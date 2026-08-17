import type { Step } from "../../../../../../src/core/define";
import {
  attachRolePolicy,
  awsClients,
  detachRolePolicy,
  isNoSuchEntity,
  listAttachedRolePolicyArns,
} from "../../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Converges a role's full managed-policy-attachment set to exactly
 * DESIRED_POLICY_ARNS, in one indivisible operation: the set of attachments
 * to touch is discovered dynamically against live IAM state at reconcile
 * time, so this is an aggregate step (like delete-role) rather than a
 * step-factory over N items.
 *
 * Always reconciles (no create()) — the desired state depends on params, not
 * a static missing/exists check.
 */
export const rotatePermissionsStep: Step<Params> = {
  id: "rotate-role-permissions",
  title: "Rotate the role's managed-policy attachments to the desired set",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;
    const desiredArns = ctx.params.DESIRED_POLICY_ARNS;

    const currentArns = await listAttachedRolePolicyArns(iam, roleName);
    const toAttach = desiredArns.filter((a) => !currentArns.includes(a));
    const toDetach = currentArns.filter((a) => !desiredArns.includes(a));

    if (toAttach.length === 0 && toDetach.length === 0) {
      ctx.log.info(`${roleName} already has exactly the desired ${desiredArns.length} policy attachment(s)`);
      return { executedAttach: JSON.stringify([]), executedDetach: JSON.stringify([]) };
    }

    ctx.log.info(
      `${roleName}: ${toAttach.length} to attach, ${toDetach.length} to detach`,
    );

    // Attach before detach is a hard invariant: never leave the role
    // under-permissioned mid-run. Only what actually succeeds is recorded, so
    // a partial failure's rollback unwinds exactly what happened.
    const executedAttach: string[] = [];
    for (const arn of toAttach) {
      await attachRolePolicy(iam, roleName, arn);
      executedAttach.push(arn);
    }

    const executedDetach: string[] = [];
    for (const arn of toDetach) {
      await detachRolePolicy(iam, roleName, arn);
      executedDetach.push(arn);
    }

    ctx.log.success(
      `${roleName}: attached ${executedAttach.length}, detached ${executedDetach.length}`,
    );

    return {
      executedAttach: JSON.stringify(executedAttach),
      executedDetach: JSON.stringify(executedDetach),
    };
  },

  /**
   * Inverse of what was actually executed, using the EXECUTED lists (not the
   * originally-computed toAttach/toDetach, which may differ from a partial
   * failure) — restores exactly the starting attachment set.
   */
  async rollback(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;
    const executedAttach = JSON.parse((ctx.outputs.executedAttach as string) ?? "[]") as string[];
    const executedDetach = JSON.parse((ctx.outputs.executedDetach as string) ?? "[]") as string[];

    for (const arn of executedDetach) {
      try {
        await attachRolePolicy(iam, roleName, arn);
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }
    for (const arn of executedAttach) {
      try {
        await detachRolePolicy(iam, roleName, arn);
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }
  },

  resource(ctx) {
    const roleName = ctx.params.ROLE_NAME;
    const executedAttach = JSON.parse((ctx.outputs.executedAttach as string) ?? "[]") as string[];
    const executedDetach = JSON.parse((ctx.outputs.executedDetach as string) ?? "[]") as string[];
    return {
      type: "aws_iam_role_policy_set",
      name: roleName,
      attributes: {
        role: roleName,
        attachedCount: String(ctx.params.DESIRED_POLICY_ARNS.length),
        attachedThisRun: String(executedAttach.length),
        detachedThisRun: String(executedDetach.length),
      },
    };
  },
};
