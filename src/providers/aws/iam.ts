import {
  AddUserToGroupCommand,
  AttachRolePolicyCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreateRoleCommand,
  CreateUserCommand,
  DeactivateMFADeviceCommand,
  DeleteAccessKeyCommand,
  DeleteLoginProfileCommand,
  DeleteRoleCommand,
  DeleteServiceSpecificCredentialCommand,
  DeleteSigningCertificateCommand,
  DeleteSSHPublicKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  DeleteVirtualMFADeviceCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  GetLoginProfileCommand,
  GetPolicyCommand,
  GetRoleCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListMFADevicesCommand,
  ListServiceSpecificCredentialsCommand,
  ListSigningCertificatesCommand,
  ListSSHPublicKeysCommand,
  ListUserPoliciesCommand,
  RemoveUserFromGroupCommand,
  UpdateAccessKeyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type { Step, StepContext, StepState } from "../../core/define";
import { warn } from "../../core/logger";
import { awsClients } from "./clients";

export function isNoSuchEntity(err: unknown): boolean {
  return (err as { name?: string })?.name === "NoSuchEntityException";
}

export function policyArn(accountId: string, policyName: string): string {
  return `arn:aws:iam::${accountId}:policy/${policyName}`;
}

export function roleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

export function userArn(accountId: string, userName: string): string {
  return `arn:aws:iam::${accountId}:user/${userName}`;
}

/**
 * IAM has no "exists but isn't ours" case the way S3 does: policy/role/user
 * names are account-scoped, so NoSuchEntity means missing and anything else is
 * a real error worth surfacing.
 */
async function presence(probe: () => Promise<unknown>): Promise<StepState> {
  try {
    await probe();
    return "exists";
  } catch (err) {
    if (isNoSuchEntity(err)) return "missing";
    throw err;
  }
}

export function policyState(iam: IAMClient, arn: string): Promise<StepState> {
  return presence(() => iam.send(new GetPolicyCommand({ PolicyArn: arn })));
}

export function roleState(iam: IAMClient, roleName: string): Promise<StepState> {
  return presence(() => iam.send(new GetRoleCommand({ RoleName: roleName })));
}

export function userState(iam: IAMClient, userName: string): Promise<StepState> {
  return presence(() => iam.send(new GetUserCommand({ UserName: userName })));
}

export interface RoleStepOptions<P> {
  /** Reads the role name out of the integration's own params. */
  roleName(params: P): string;
  id?: string;
  title?: string;
}

/**
 * A precondition step for integrations that operate on a role they do not
 * create (attach/detach a policy, reconcile trust policy or tags). "Missing"
 * is folded into "conflict" here rather than left as "missing", because this
 * step declares no create(): without this, a missing role would silently
 * plan a "skip" and the real failure would only surface as a raw
 * NoSuchEntityException partway through apply. Mirrors s3BucketExistsGuardStep.
 */
export function iamRoleExistsGuardStep<P>(opts: RoleStepOptions<P>): Step<P> {
  const name = (ctx: StepContext<P>) => opts.roleName(ctx.params);

  return {
    id: opts.id ?? "iam-role-exists",
    title: opts.title ?? "Confirm the IAM role already exists",

    async check(ctx) {
      const state = await roleState(awsClients(ctx).iam, name(ctx));
      if (state === "missing") {
        warn(
          `IAM role "${name(ctx)}" does not exist. This integration operates on an existing role ` +
            `and does not create one — run aws/iam/role/create-role first if you need it provisioned.`,
        );
        return "conflict";
      }
      return state;
    },

    async rollback() {
      // A read-only precondition changes nothing, so there is nothing to undo.
    },
  };
}

/**
 * Ensures a role exists with the given trust policy. Role names are
 * account-scoped (unlike S3 bucket names), so there is no "exists but isn't
 * ours" third state the way s3BucketStep needs — NoSuchEntity is the only
 * "missing" signal, and any successful GetRole means this account already
 * owns it.
 */
export function iamRoleStep<P>(
  opts: RoleStepOptions<P> & {
    trustPolicy(params: P): object;
    path?(params: P): string | undefined;
    description?(params: P): string | undefined;
    maxSessionDurationSeconds?(params: P): number | undefined;
    permissionsBoundaryArn?(params: P): string | undefined;
  },
): Step<P> {
  const name = (ctx: StepContext<P>) => opts.roleName(ctx.params);

  return {
    id: opts.id ?? "iam-role",
    title: opts.title ?? "Ensure IAM role",

    async check(ctx) {
      return roleState(awsClients(ctx).iam, name(ctx));
    },

    async create(ctx) {
      const created = await awsClients(ctx).iam.send(
        new CreateRoleCommand({
          RoleName: name(ctx),
          AssumeRolePolicyDocument: JSON.stringify(opts.trustPolicy(ctx.params)),
          Path: opts.path?.(ctx.params),
          Description: opts.description?.(ctx.params),
          MaxSessionDuration: opts.maxSessionDurationSeconds?.(ctx.params),
          PermissionsBoundary: opts.permissionsBoundaryArn?.(ctx.params),
        }),
      );
      return {
        roleArn: created.Role?.Arn ?? roleArn(ctx.accountId, name(ctx)),
        roleCreatedThisRun: true,
      };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(new DeleteRoleCommand({ RoleName: name(ctx) }));
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_role",
        name: name(ctx),
        attributes: { arn: roleArn(ctx.accountId, name(ctx)) },
      };
    },

    handoff: {
      terraform: {
        type: "aws_iam_role",
        address: "aws_iam_role.this",
        importId: (ctx) => name(ctx),
      },
    },
  };
}

export interface RolePolicyAttachmentOptions<P> {
  roleName(params: P): string;
  policyArn(params: P): string;
  id?: string;
  title?: string;
}

async function isPolicyAttachedToRole(
  iam: IAMClient,
  roleName: string,
  policyArn: string,
): Promise<boolean> {
  const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
  return (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === policyArn);
}

/**
 * AttachRolePolicy is itself idempotent (no "already attached" error), so the
 * call alone can't tell us whether the attachment is ours. check() first —
 * detaching a pre-existing attachment on rollback would damage state this
 * run did not create. Mirrors create-backend-s3-user's attachPolicyStep,
 * generalized from users to roles.
 */
export function iamAttachRolePolicyStep<P>(opts: RolePolicyAttachmentOptions<P>): Step<P> {
  return {
    id: opts.id ?? "attach-role-policy",
    title: opts.title ?? "Attach policy to role",

    async check(ctx) {
      try {
        const attached = await isPolicyAttachedToRole(
          awsClients(ctx).iam,
          opts.roleName(ctx.params),
          opts.policyArn(ctx.params),
        );
        return attached ? "exists" : "missing";
      } catch (err) {
        // The role itself doesn't exist yet — an earlier step will create it.
        if (isNoSuchEntity(err)) return "missing";
        throw err;
      }
    },

    async create(ctx) {
      await awsClients(ctx).iam.send(
        new AttachRolePolicyCommand({
          RoleName: opts.roleName(ctx.params),
          PolicyArn: opts.policyArn(ctx.params),
        }),
      );
      return { policyAttachedThisRun: true };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(
          new DetachRolePolicyCommand({
            RoleName: opts.roleName(ctx.params),
            PolicyArn: opts.policyArn(ctx.params),
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_role_policy_attachment",
        name: `${opts.roleName(ctx.params)}:${opts.policyArn(ctx.params)}`,
        attributes: { role: opts.roleName(ctx.params), policyArn: opts.policyArn(ctx.params) },
      };
    },

    handoff: {
      terraform: {
        type: "aws_iam_role_policy_attachment",
        address: "aws_iam_role_policy_attachment.this",
        importId: (ctx) => `${opts.roleName(ctx.params)}/${opts.policyArn(ctx.params)}`,
      },
    },
  };
}

/**
 * Inverted create-or-skip: the target state is "the attachment is gone".
 * Mirrors delete-empty-bucket's deleteBucketStep pattern.
 */
export function iamDetachRolePolicyStep<P>(opts: RolePolicyAttachmentOptions<P>): Step<P> {
  return {
    id: opts.id ?? "detach-role-policy",
    title: opts.title ?? "Detach policy from role",

    async check(ctx) {
      try {
        const attached = await isPolicyAttachedToRole(
          awsClients(ctx).iam,
          opts.roleName(ctx.params),
          opts.policyArn(ctx.params),
        );
        return attached ? "missing" : "exists";
      } catch (err) {
        // Role already gone — the detachment's target state is already achieved.
        if (isNoSuchEntity(err)) return "exists";
        throw err;
      }
    },

    async create(ctx) {
      await awsClients(ctx).iam.send(
        new DetachRolePolicyCommand({
          RoleName: opts.roleName(ctx.params),
          PolicyArn: opts.policyArn(ctx.params),
        }),
      );
      return { policyDetachedThisRun: true };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(
          new AttachRolePolicyCommand({
            RoleName: opts.roleName(ctx.params),
            PolicyArn: opts.policyArn(ctx.params),
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_role_policy_attachment",
        name: `${opts.roleName(ctx.params)}:${opts.policyArn(ctx.params)}`,
        attributes: {
          role: opts.roleName(ctx.params),
          policyArn: opts.policyArn(ctx.params),
          action: "detached",
        },
      };
    },
  };
}

/** Thin wrapper, not a Step — used by rotate-role-permissions to converge a full policy set. */
export async function attachRolePolicy(
  iam: IAMClient,
  roleName: string,
  policyArn: string,
): Promise<void> {
  await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
}

/** Thin wrapper, not a Step — used by rotate-role-permissions to converge a full policy set. */
export async function detachRolePolicy(
  iam: IAMClient,
  roleName: string,
  policyArn: string,
): Promise<void> {
  await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
}

/** Paginated list of every managed policy ARN currently attached to a role. */
export async function listAttachedRolePolicyArns(
  iam: IAMClient,
  roleName: string,
): Promise<string[]> {
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

// ---------------------------------------------------------------------------
// aws/iam/user shared factories
// ---------------------------------------------------------------------------

export interface UserStepOptions<P> {
  userName(params: P): string;
  id?: string;
  title?: string;
}

/**
 * Precondition step for integrations that operate on a user they do not
 * create. Mirrors iamRoleExistsGuardStep/s3BucketExistsGuardStep: "missing"
 * is folded into "conflict" here because this step declares no create() —
 * without this, a missing user would silently plan a skip instead of
 * aborting cleanly in the plan phase.
 */
export function iamUserExistsGuardStep<P>(opts: UserStepOptions<P>): Step<P> {
  const name = (ctx: StepContext<P>) => opts.userName(ctx.params);

  return {
    id: opts.id ?? "iam-user-exists",
    title: opts.title ?? "Confirm the IAM user already exists",

    async check(ctx) {
      const state = await userState(awsClients(ctx).iam, name(ctx));
      if (state === "missing") {
        warn(
          `IAM user "${name(ctx)}" does not exist. This integration operates on an existing user ` +
            `and does not create one — run aws/iam/user/create-user first if you need it provisioned.`,
        );
        return "conflict";
      }
      return state;
    },

    async rollback() {
      // A read-only precondition changes nothing, so there is nothing to undo.
    },
  };
}

/**
 * Ensures a user exists. Generalized from create-backend-s3-user's
 * iamUserStep — same create-or-skip shape, no third "conflict" state (user
 * names are account-scoped, not globally unique like S3 bucket names).
 */
export function iamUserStep<P>(
  opts: UserStepOptions<P> & {
    path?(params: P): string | undefined;
    permissionsBoundaryArn?(params: P): string | undefined;
  },
): Step<P> {
  const name = (ctx: StepContext<P>) => opts.userName(ctx.params);

  return {
    id: opts.id ?? "iam-user",
    title: opts.title ?? "Ensure IAM user",

    async check(ctx) {
      return userState(awsClients(ctx).iam, name(ctx));
    },

    async create(ctx) {
      const created = await awsClients(ctx).iam.send(
        new CreateUserCommand({
          UserName: name(ctx),
          Path: opts.path?.(ctx.params),
          PermissionsBoundary: opts.permissionsBoundaryArn?.(ctx.params),
        }),
      );
      return {
        userArn: created.User?.Arn ?? userArn(ctx.accountId, name(ctx)),
        userCreatedThisRun: true,
      };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(new DeleteUserCommand({ UserName: name(ctx) }));
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_user",
        name: name(ctx),
        attributes: { arn: userArn(ctx.accountId, name(ctx)) },
      };
    },

    handoff: {
      terraform: {
        type: "aws_iam_user",
        address: "aws_iam_user.this",
        importId: (ctx) => name(ctx),
      },
    },
  };
}

export interface UserPolicyAttachmentOptions<P> {
  userName(params: P): string;
  policyArn(params: P): string;
  id?: string;
  title?: string;
}

async function isPolicyAttachedToUser(
  iam: IAMClient,
  userName: string,
  policyArn: string,
): Promise<boolean> {
  const attached = await iam.send(new ListAttachedUserPoliciesCommand({ UserName: userName }));
  return (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === policyArn);
}

/**
 * Generalized from create-backend-s3-user's attachPolicyStep. AttachUserPolicy
 * is itself idempotent (no "already attached" error), so check() first —
 * detaching a pre-existing attachment on rollback would damage state this run
 * did not create.
 */
export function iamAttachUserPolicyStep<P>(opts: UserPolicyAttachmentOptions<P>): Step<P> {
  return {
    id: opts.id ?? "attach-user-policy",
    title: opts.title ?? "Attach policy to user",

    async check(ctx) {
      try {
        const attached = await isPolicyAttachedToUser(
          awsClients(ctx).iam,
          opts.userName(ctx.params),
          opts.policyArn(ctx.params),
        );
        return attached ? "exists" : "missing";
      } catch (err) {
        // The user itself doesn't exist yet — an earlier step will create it.
        if (isNoSuchEntity(err)) return "missing";
        throw err;
      }
    },

    async create(ctx) {
      await awsClients(ctx).iam.send(
        new AttachUserPolicyCommand({
          UserName: opts.userName(ctx.params),
          PolicyArn: opts.policyArn(ctx.params),
        }),
      );
      return { policyAttachedThisRun: true };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(
          new DetachUserPolicyCommand({
            UserName: opts.userName(ctx.params),
            PolicyArn: opts.policyArn(ctx.params),
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_user_policy_attachment",
        name: `${opts.userName(ctx.params)}:${opts.policyArn(ctx.params)}`,
        attributes: { user: opts.userName(ctx.params), policyArn: opts.policyArn(ctx.params) },
      };
    },

    handoff: {
      terraform: {
        type: "aws_iam_user_policy_attachment",
        address: "aws_iam_user_policy_attachment.this",
        importId: (ctx) => `${opts.userName(ctx.params)}/${opts.policyArn(ctx.params)}`,
      },
    },
  };
}

/** Inverted create-or-skip: the target state is "the attachment is gone". */
export function iamDetachUserPolicyStep<P>(opts: UserPolicyAttachmentOptions<P>): Step<P> {
  return {
    id: opts.id ?? "detach-user-policy",
    title: opts.title ?? "Detach policy from user",

    async check(ctx) {
      try {
        const attached = await isPolicyAttachedToUser(
          awsClients(ctx).iam,
          opts.userName(ctx.params),
          opts.policyArn(ctx.params),
        );
        return attached ? "missing" : "exists";
      } catch (err) {
        if (isNoSuchEntity(err)) return "exists";
        throw err;
      }
    },

    async create(ctx) {
      await awsClients(ctx).iam.send(
        new DetachUserPolicyCommand({
          UserName: opts.userName(ctx.params),
          PolicyArn: opts.policyArn(ctx.params),
        }),
      );
      return { policyDetachedThisRun: true };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(
          new AttachUserPolicyCommand({
            UserName: opts.userName(ctx.params),
            PolicyArn: opts.policyArn(ctx.params),
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_user_policy_attachment",
        name: `${opts.userName(ctx.params)}:${opts.policyArn(ctx.params)}`,
        attributes: {
          user: opts.userName(ctx.params),
          policyArn: opts.policyArn(ctx.params),
          action: "detached",
        },
      };
    },
  };
}

export interface UserGroupMembershipOptions<P> {
  userName(params: P): string;
  groupName(params: P): string;
  id?: string;
  title?: string;
}

async function isUserInGroup(iam: IAMClient, userName: string, groupName: string): Promise<boolean> {
  const groups = await iam.send(new ListGroupsForUserCommand({ UserName: userName }));
  return (groups.Groups ?? []).some((g) => g.GroupName === groupName);
}

/** Same List/Add/Remove triad as the policy-attach factory, against group membership. */
export function iamAddUserToGroupStep<P>(opts: UserGroupMembershipOptions<P>): Step<P> {
  return {
    id: opts.id ?? "add-user-to-group",
    title: opts.title ?? "Add user to group",

    async check(ctx) {
      try {
        const member = await isUserInGroup(
          awsClients(ctx).iam,
          opts.userName(ctx.params),
          opts.groupName(ctx.params),
        );
        return member ? "exists" : "missing";
      } catch (err) {
        if (isNoSuchEntity(err)) return "missing";
        throw err;
      }
    },

    async create(ctx) {
      await awsClients(ctx).iam.send(
        new AddUserToGroupCommand({
          UserName: opts.userName(ctx.params),
          GroupName: opts.groupName(ctx.params),
        }),
      );
      return { addedToGroupThisRun: true };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(
          new RemoveUserFromGroupCommand({
            UserName: opts.userName(ctx.params),
            GroupName: opts.groupName(ctx.params),
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_user_group_membership",
        name: `${opts.userName(ctx.params)}:${opts.groupName(ctx.params)}`,
        attributes: { user: opts.userName(ctx.params), group: opts.groupName(ctx.params) },
      };
    },
  };
}

/** Inverted create-or-skip: the target state is "not a member". */
export function iamRemoveUserFromGroupStep<P>(opts: UserGroupMembershipOptions<P>): Step<P> {
  return {
    id: opts.id ?? "remove-user-from-group",
    title: opts.title ?? "Remove user from group",

    async check(ctx) {
      try {
        const member = await isUserInGroup(
          awsClients(ctx).iam,
          opts.userName(ctx.params),
          opts.groupName(ctx.params),
        );
        return member ? "missing" : "exists";
      } catch (err) {
        if (isNoSuchEntity(err)) return "exists";
        throw err;
      }
    },

    async create(ctx) {
      await awsClients(ctx).iam.send(
        new RemoveUserFromGroupCommand({
          UserName: opts.userName(ctx.params),
          GroupName: opts.groupName(ctx.params),
        }),
      );
      return { removedFromGroupThisRun: true };
    },

    async rollback(ctx) {
      try {
        await awsClients(ctx).iam.send(
          new AddUserToGroupCommand({
            UserName: opts.userName(ctx.params),
            GroupName: opts.groupName(ctx.params),
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_user_group_membership",
        name: `${opts.userName(ctx.params)}:${opts.groupName(ctx.params)}`,
        attributes: {
          user: opts.userName(ctx.params),
          group: opts.groupName(ctx.params),
          action: "removed",
        },
      };
    },
  };
}

/**
 * Mints an access key. A user already holding a key (and not opting into a
 * second one) is left alone — creating another on every re-run would burn
 * through the 2-key AWS limit. Generalized from create-backend-s3-user's
 * accessKeyStep with an explicit ALLOW_SECOND_KEY-style escape hatch used by
 * rotate-access-key.
 */
export function iamAccessKeyStep<P>(
  opts: UserStepOptions<P> & { allowSecondKey?(params: P): boolean },
): Step<P> {
  const name = (ctx: StepContext<P>) => opts.userName(ctx.params);

  return {
    id: opts.id ?? "access-key",
    title: opts.title ?? "Create access key",

    async check(ctx) {
      try {
        const existing = await awsClients(ctx).iam.send(
          new ListAccessKeysCommand({ UserName: name(ctx) }),
        );
        const keys = existing.AccessKeyMetadata ?? [];
        if (keys.length === 0) return "missing";
        if (keys.length >= 2) return "exists"; // hard cap — a second create() would 409 regardless
        const allowSecond = opts.allowSecondKey?.(ctx.params) ?? false;
        return allowSecond ? "missing" : "exists";
      } catch (err) {
        if (isNoSuchEntity(err)) return "missing";
        throw err;
      }
    },

    async create(ctx) {
      const created = await awsClients(ctx).iam.send(
        new CreateAccessKeyCommand({ UserName: name(ctx) }),
      );
      const accessKey = created.AccessKey;
      if (!accessKey?.AccessKeyId || !accessKey?.SecretAccessKey) {
        throw new Error("CreateAccessKey did not return an access key pair");
      }
      return {
        accessKeyId: accessKey.AccessKeyId,
        // Held in memory only. Never written to any file — printed to stdout
        // once, at report time, and masked in the persisted markdown.
        secretAccessKey: accessKey.SecretAccessKey,
        accessKeyCreatedThisRun: true,
      };
    },

    async rollback(ctx) {
      const accessKeyId = ctx.outputs.accessKeyId as string | undefined;
      if (!accessKeyId) return;
      try {
        await awsClients(ctx).iam.send(
          new DeleteAccessKeyCommand({ UserName: name(ctx), AccessKeyId: accessKeyId }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_access_key",
        name: name(ctx),
        attributes: { accessKeyId: String(ctx.outputs.accessKeyId ?? "") },
      };
    },
  };
}

/**
 * Toggles a specific access key's Status between Active/Inactive — fully
 * reversible, unlike delete. Shared by deactivate-access-key and
 * rotate-access-key's cutover phase (desired: "Inactive" in both cases;
 * "Active" is the natural reactivation counterpart, not built as its own
 * integration in this pass).
 */
export function iamAccessKeyStatusStep<P>(opts: {
  userName(params: P): string;
  accessKeyId(params: P): string;
  desired(params: P): "Active" | "Inactive";
  id?: string;
  title?: string;
}): Step<P> {
  return {
    id: opts.id ?? "access-key-status",
    title: opts.title ?? "Reconcile access key status",

    async check(ctx) {
      const { iam } = awsClients(ctx);
      const userName = opts.userName(ctx.params);
      const accessKeyId = opts.accessKeyId(ctx.params);
      const desired = opts.desired(ctx.params);
      const existing = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
      const key = (existing.AccessKeyMetadata ?? []).find((k) => k.AccessKeyId === accessKeyId);
      if (!key) return "missing"; // already gone — nothing to toggle
      return key.Status === desired ? "exists" : "missing";
    },

    async create(ctx) {
      const { iam } = awsClients(ctx);
      const userName = opts.userName(ctx.params);
      const accessKeyId = opts.accessKeyId(ctx.params);
      const desired = opts.desired(ctx.params);

      const existing = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
      const key = (existing.AccessKeyMetadata ?? []).find((k) => k.AccessKeyId === accessKeyId);
      if (!key) {
        ctx.log.info(`Access key ${accessKeyId} no longer exists — nothing to reconcile`);
        return {};
      }

      const priorStatus = key.Status;
      await iam.send(
        new UpdateAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId, Status: desired }),
      );
      return { priorAccessKeyStatus: priorStatus };
    },

    async rollback(ctx) {
      const priorStatus = ctx.outputs.priorAccessKeyStatus as "Active" | "Inactive" | undefined;
      if (!priorStatus) return;
      try {
        await awsClients(ctx).iam.send(
          new UpdateAccessKeyCommand({
            UserName: opts.userName(ctx.params),
            AccessKeyId: opts.accessKeyId(ctx.params),
            Status: priorStatus,
          }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_iam_access_key_status",
        name: `${opts.userName(ctx.params)}:${opts.accessKeyId(ctx.params)}`,
        attributes: {
          user: opts.userName(ctx.params),
          accessKeyId: opts.accessKeyId(ctx.params),
          status: opts.desired(ctx.params),
        },
      };
    },
  };
}

export interface UserTeardownSummary {
  deactivatedKeyCount: number;
  deletedKeyCount: number;
  hadLoginProfile: boolean;
  mfaDeviceCount: number;
  groupCount: number;
  attachedPolicyCount: number;
  inlinePolicyCount: number;
  signingCertCount: number;
  sshKeyCount: number;
  serviceSpecificCredCount: number;
}

/**
 * Full teardown-then-delete, shared verbatim by delete-user and
 * offboard-user (per the plan: "there is no justification for two
 * independently maintained copies of a nine-API-call destructive sequence").
 *
 * One aggregate step, mirroring delete-role's deleteRoleStep shape: the *set*
 * of attached artifacts is discovered dynamically at check/apply time, and
 * DeleteUser hard-gates on all of them being cleared first (DeleteConflict
 * otherwise) — so this is an indivisible converge-then-delete transaction,
 * not an N-item step-factory.
 */
export function iamUserTeardownStep<P>(opts: UserStepOptions<P>): Step<P> {
  const name = (ctx: StepContext<P>) => opts.userName(ctx.params);

  return {
    id: opts.id ?? "user-teardown",
    title: opts.title ?? "Tear down and delete IAM user",

    async check(ctx) {
      // Inverted create-or-skip: the target state is "the user is gone", so
      // this deliberately flips userState's usual meaning — a user that's
      // already absent is the achieved state ("exists" — nothing to do), and
      // a user that's still present still needs tearing down ("missing").
      const state = await userState(awsClients(ctx).iam, name(ctx));
      return state === "missing" ? "exists" : "missing";
    },

    async create(ctx) {
      const { iam } = awsClients(ctx);
      const userName = name(ctx);

      const keys = (
        await iam.send(new ListAccessKeysCommand({ UserName: userName }))
      ).AccessKeyMetadata ?? [];
      for (const key of keys) {
        if (!key.AccessKeyId) continue;
        await iam.send(
          new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: key.AccessKeyId }),
        );
      }

      let hadLoginProfile = false;
      try {
        await iam.send(new GetLoginProfileCommand({ UserName: userName }));
        hadLoginProfile = true;
        await iam.send(new DeleteLoginProfileCommand({ UserName: userName }));
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }

      const mfaDevices = (
        await iam.send(new ListMFADevicesCommand({ UserName: userName }))
      ).MFADevices ?? [];
      for (const device of mfaDevices) {
        if (!device.SerialNumber) continue;
        await iam.send(
          new DeactivateMFADeviceCommand({ UserName: userName, SerialNumber: device.SerialNumber }),
        );
        if (device.SerialNumber.includes(":mfa/")) {
          await iam.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: device.SerialNumber }));
        }
      }

      const groups = (
        await iam.send(new ListGroupsForUserCommand({ UserName: userName }))
      ).Groups ?? [];
      for (const group of groups) {
        if (!group.GroupName) continue;
        await iam.send(
          new RemoveUserFromGroupCommand({ UserName: userName, GroupName: group.GroupName }),
        );
      }

      const attachedPolicies = (
        await iam.send(new ListAttachedUserPoliciesCommand({ UserName: userName }))
      ).AttachedPolicies ?? [];
      for (const policy of attachedPolicies) {
        if (!policy.PolicyArn) continue;
        await iam.send(
          new DetachUserPolicyCommand({ UserName: userName, PolicyArn: policy.PolicyArn }),
        );
      }

      const inlinePolicies = (
        await iam.send(new ListUserPoliciesCommand({ UserName: userName }))
      ).PolicyNames ?? [];
      for (const policyName of inlinePolicies) {
        await iam.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: policyName }));
      }

      // Rarely populated for a machine/backend user, but DeleteUser's own
      // documented precondition list includes these — a fully honest
      // teardown clears them too, or the final call 409s on an account that
      // happens to have them.
      const signingCerts = (
        await iam.send(new ListSigningCertificatesCommand({ UserName: userName }))
      ).Certificates ?? [];
      for (const cert of signingCerts) {
        if (!cert.CertificateId) continue;
        await iam.send(
          new DeleteSigningCertificateCommand({ UserName: userName, CertificateId: cert.CertificateId }),
        );
      }

      const sshKeys = (
        await iam.send(new ListSSHPublicKeysCommand({ UserName: userName }))
      ).SSHPublicKeys ?? [];
      for (const key of sshKeys) {
        if (!key.SSHPublicKeyId) continue;
        await iam.send(
          new DeleteSSHPublicKeyCommand({ UserName: userName, SSHPublicKeyId: key.SSHPublicKeyId }),
        );
      }

      const serviceSpecificCreds = (
        await iam.send(new ListServiceSpecificCredentialsCommand({ UserName: userName }))
      ).ServiceSpecificCredentials ?? [];
      for (const cred of serviceSpecificCreds) {
        if (!cred.ServiceSpecificCredentialId) continue;
        await iam.send(
          new DeleteServiceSpecificCredentialCommand({
            UserName: userName,
            ServiceSpecificCredentialId: cred.ServiceSpecificCredentialId,
          }),
        );
      }

      await iam.send(new DeleteUserCommand({ UserName: userName }));

      const summary: UserTeardownSummary = {
        deactivatedKeyCount: 0,
        deletedKeyCount: keys.length,
        hadLoginProfile,
        mfaDeviceCount: mfaDevices.length,
        groupCount: groups.length,
        attachedPolicyCount: attachedPolicies.length,
        inlinePolicyCount: inlinePolicies.length,
        signingCertCount: signingCerts.length,
        sshKeyCount: sshKeys.length,
        serviceSpecificCredCount: serviceSpecificCreds.length,
      };

      return { userTornDownThisRun: true, userTeardownSummary: JSON.stringify(summary) };
    },

    async rollback(ctx) {
      // Deliberately does not attempt to recreate what was deleted: a deleted
      // access key's secret and a deleted login profile's password are gone
      // forever (AWS never returns a secret again after creation). Rollback
      // only recreates the bare user shell and loudly enumerates everything
      // that cannot be restored, mirroring s3VersioningStep's honest
          // "cannot be restored to never-configured" caveat.
      const userName = name(ctx);
      const summaryRaw = ctx.outputs.userTeardownSummary as string | undefined;
      const summary: UserTeardownSummary | undefined = summaryRaw ? JSON.parse(summaryRaw) : undefined;

      try {
        await awsClients(ctx).iam.send(new CreateUserCommand({ UserName: userName }));
      } catch (err) {
        if (!(err as { name?: string })?.name?.includes("EntityAlreadyExists")) throw err;
      }

      warn(
        `Rollback recreated a BARE user "${userName}" — everything torn down is unrecoverable: ` +
          `${summary?.deletedKeyCount ?? "?"} access key(s) (secrets cannot be retrieved again), ` +
          `login profile present: ${summary?.hadLoginProfile ?? "unknown"}, ` +
          `${summary?.mfaDeviceCount ?? "?"} MFA device(s), ${summary?.groupCount ?? "?"} group membership(s), ` +
          `${summary?.attachedPolicyCount ?? "?"} attached + ${summary?.inlinePolicyCount ?? "?"} inline polic(y/ies). ` +
          `Reprovision access keys, group memberships and policy attachments manually.`,
      );
    },

    resource(ctx) {
      const summaryRaw = ctx.outputs.userTeardownSummary as string | undefined;
      const summary: Partial<UserTeardownSummary> = summaryRaw ? JSON.parse(summaryRaw) : {};
      return {
        type: "aws_iam_user",
        name: name(ctx),
        attributes: {
          arn: userArn(ctx.accountId, name(ctx)),
          action: "deleted",
          deletedKeyCount: String(summary.deletedKeyCount ?? 0),
          groupCount: String(summary.groupCount ?? 0),
          attachedPolicyCount: String(summary.attachedPolicyCount ?? 0),
          inlinePolicyCount: String(summary.inlinePolicyCount ?? 0),
        },
      };
    },
  };
}
