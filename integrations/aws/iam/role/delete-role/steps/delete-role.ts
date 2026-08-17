import {
  AddRoleToInstanceProfileCommand,
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteInstanceProfileCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetInstanceProfileCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListInstanceProfilesForRoleCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  RemoveRoleFromInstanceProfileCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type { Step, StepContext } from "../../../../../../src/core/define";
import { retryWithBackoff } from "../../../../../../src/core/wait";
import { awsClients, isNoSuchEntity, roleArn, roleState } from "../../../../../../src/providers/aws";
import type { Params } from "../params";

interface InlinePolicySnapshot {
  policyName: string;
  document: string;
}

interface RoleSnapshot {
  assumeRolePolicyDocument: string;
  path?: string;
  description?: string;
  maxSessionDuration?: number;
  tags: { Key: string; Value: string }[];
}

/** `Role.Path` starting with `/aws-service-role/`, or a name prefixed `AWSServiceRoleFor`. */
function isServiceLinked(roleName: string, path: string | undefined): boolean {
  return Boolean(path?.startsWith("/aws-service-role/")) || roleName.startsWith("AWSServiceRoleFor");
}

async function listAttachedPolicyArns(iam: IAMClient, roleName: string): Promise<string[]> {
  const arns: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker }),
    );
    for (const p of page.AttachedPolicies ?? []) if (p.PolicyArn) arns.push(p.PolicyArn);
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return arns;
}

async function listInlinePolicyNames(iam: IAMClient, roleName: string): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
    names.push(...(page.PolicyNames ?? []));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return names;
}

async function listInstanceProfileNames(iam: IAMClient, roleName: string): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(
      new ListInstanceProfilesForRoleCommand({ RoleName: roleName, Marker: marker }),
    );
    for (const p of page.InstanceProfiles ?? []) if (p.InstanceProfileName) names.push(p.InstanceProfileName);
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return names;
}

async function snapshotRole(iam: IAMClient, roleName: string): Promise<RoleSnapshot> {
  const got = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  const role = got.Role;
  if (!role?.AssumeRolePolicyDocument) throw new Error(`Could not read role ${roleName} to snapshot it`);
  return {
    assumeRolePolicyDocument: decodeURIComponent(role.AssumeRolePolicyDocument),
    path: role.Path,
    description: role.Description,
    maxSessionDuration: role.MaxSessionDuration,
    tags: (role.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" })),
  };
}

/**
 * Inverted create-or-skip: the target state is "the role is gone." Mirrors
 * delete-empty-bucket's deleteBucketStep. Unlike that step, the set of
 * attachments to clean up (managed policies, inline policies, instance
 * profiles) is discovered dynamically at delete-time, so this is one
 * aggregate step rather than a per-resource factory.
 */
export const deleteRoleStep: Step<Params> = {
  id: "delete-role",
  title: "Delete the IAM role (detaching everything attached first)",

  async check(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;

    const state = await roleState(iam, roleName);
    if (state === "missing") return "exists"; // already gone — nothing to do

    const got = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    const role = got.Role;
    if (isServiceLinked(roleName, role?.Path)) {
      ctx.log.warn(
        `${roleName} is a service-linked role and cannot be deleted with DeleteRole. ` +
          `Use a dedicated delete-service-linked-role task (DeleteServiceLinkedRole + ` +
          `GetServiceLinkedRoleDeletionStatus) instead.`,
      );
      return "conflict";
    }

    return "missing"; // present, ordinary role — deletion still needs to happen
  },

  async create(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;

    const snapshot = await snapshotRole(iam, roleName);
    const attachedPolicyArns = await listAttachedPolicyArns(iam, roleName);
    const inlinePolicyNames = await listInlinePolicyNames(iam, roleName);
    const instanceProfileNames = await listInstanceProfileNames(iam, roleName);

    const inlinePolicies: InlinePolicySnapshot[] = [];
    for (const policyName of inlinePolicyNames) {
      const got = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
      if (!got.PolicyDocument) continue;
      inlinePolicies.push({ policyName, document: decodeURIComponent(got.PolicyDocument) });
    }

    for (const policyArn of attachedPolicyArns) {
      await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
    }
    ctx.log.success(`Detached ${attachedPolicyArns.length} managed polic${attachedPolicyArns.length === 1 ? "y" : "ies"}`);

    for (const policyName of inlinePolicyNames) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
    }
    ctx.log.success(`Deleted ${inlinePolicyNames.length} inline polic${inlinePolicyNames.length === 1 ? "y" : "ies"}`);

    for (const profileName of instanceProfileNames) {
      await iam.send(
        new RemoveRoleFromInstanceProfileCommand({ RoleName: roleName, InstanceProfileName: profileName }),
      );
    }
    ctx.log.success(
      `Removed role from ${instanceProfileNames.length} instance profile${instanceProfileNames.length === 1 ? "" : "s"}`,
    );

    const deletedInstanceProfiles: string[] = [];
    if (ctx.params.DELETE_INSTANCE_PROFILES_TOO) {
      for (const profileName of instanceProfileNames) {
        const got = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }));
        const remainingRoles = (got.InstanceProfile?.Roles ?? []).filter((r) => r.RoleName !== roleName);
        if (remainingRoles.length > 0) {
          ctx.log.warn(
            `Instance profile ${profileName} still has other roles attached — not deleting it.`,
          );
          continue;
        }
        await iam.send(new DeleteInstanceProfileCommand({ InstanceProfileName: profileName }));
        deletedInstanceProfiles.push(profileName);
      }
    }

    // DeleteRole's own precondition (all attachments removed first) can race
    // a very fresh detach under IAM's eventual consistency, surfacing as
    // DeleteConflict — retry that specifically, not any other error.
    await retryWithBackoff(
      () => iam.send(new DeleteRoleCommand({ RoleName: roleName })),
      {
        backoffsMs: [1_000, 2_000, 4_000, 8_000],
        label: `DeleteRole(${roleName})`,
        retryable: (err) => (err as { name?: string })?.name === "DeleteConflictException",
        log: ctx.log,
      },
    );
    ctx.log.success(`Deleted role ${roleName}`);

    return {
      roleDeletedThisRun: true,
      roleArn: roleArn(ctx.accountId, roleName),
      priorRoleSnapshot: snapshot,
      detachedPolicyArns: attachedPolicyArns,
      deletedInlinePolicies: inlinePolicies,
      removedInstanceProfileNames: instanceProfileNames,
      deletedInstanceProfileNames: deletedInstanceProfiles,
    };
  },

  /**
   * Best-effort, loudly non-authoritative: recreates the role shell from the
   * pre-delete snapshot and re-provisions every captured attachment. RoleId
   * changes on recreation, so any resource policy or trust relationship keyed
   * on the old RoleId (some cross-account bucket policies, for example) will
   * not automatically re-authorize — and anything the linked service itself
   * held (activity history, service-side state) is gone for good.
   */
  async rollback(ctx) {
    if (ctx.outputs.roleDeletedThisRun !== true) return;

    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;
    const snapshot = ctx.outputs.priorRoleSnapshot as RoleSnapshot;
    const attachedPolicyArns = ctx.outputs.detachedPolicyArns as string[];
    const inlinePolicies = ctx.outputs.deletedInlinePolicies as InlinePolicySnapshot[];
    const instanceProfileNames = ctx.outputs.removedInstanceProfileNames as string[];

    ctx.log.warn(
      `Recreating ${roleName} — this is BEST-EFFORT, not a real restore. The new role gets a new ` +
        `RoleId, so any resource policy or trust relationship keyed on the old RoleId will not ` +
        `automatically re-authorize, and any activity history or service-owned state is gone.`,
    );

    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: snapshot.assumeRolePolicyDocument,
        Path: snapshot.path,
        Description: snapshot.description,
        MaxSessionDuration: snapshot.maxSessionDuration,
        Tags: snapshot.tags.length ? snapshot.tags : undefined,
      }),
    );

    for (const policyArn of attachedPolicyArns) {
      await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
    }
    for (const inline of inlinePolicies) {
      await iam.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: inline.policyName,
          PolicyDocument: inline.document,
        }),
      );
    }
    for (const profileName of instanceProfileNames) {
      try {
        await iam.send(
          new AddRoleToInstanceProfileCommand({ RoleName: roleName, InstanceProfileName: profileName }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
        ctx.log.warn(`Instance profile ${profileName} no longer exists — could not re-attach ${roleName}`);
      }
    }
  },

  resource(ctx) {
    const attachedPolicyArns = (ctx.outputs.detachedPolicyArns as string[] | undefined) ?? [];
    const inlinePolicies = (ctx.outputs.deletedInlinePolicies as InlinePolicySnapshot[] | undefined) ?? [];
    const instanceProfileNames = (ctx.outputs.removedInstanceProfileNames as string[] | undefined) ?? [];

    return {
      type: "aws_iam_role",
      name: ctx.params.ROLE_NAME,
      attributes: {
        arn: roleArn(ctx.accountId, ctx.params.ROLE_NAME),
        action: "deleted",
        detachedPolicyCount: String(attachedPolicyArns.length),
        deletedInlinePolicyCount: String(inlinePolicies.length),
        removedInstanceProfileCount: String(instanceProfileNames.length),
      },
    };
  },
};
