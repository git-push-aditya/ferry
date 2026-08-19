import type { Step } from "../../../../src/core/define";
import {
  attachRolePolicy,
  awsClients,
  detachRolePolicy,
  isNoSuchEntity,
  listAttachedRolePolicyArns,
} from "../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Converges the execution role's managed-policy attachments to exactly
 * EXECUTION_POLICY_ARNS — same aggregate-convergence shape as
 * aws/iam/role/rotate-role-permissions, adapted here rather than imported
 * since that step is typed to its own integration's Params.
 *
 * Always reconciles (no create()) — the desired set depends on params, not
 * a static missing/exists check.
 */
export const executionPoliciesStep: Step<Params> = {
  id: "execution-role-policies",
  title: "Converge the execution role's managed-policy attachments",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.CFN_EXECUTION_ROLE_NAME;
    const desiredArns = ctx.params.EXECUTION_POLICY_ARNS;

    const currentArns = await listAttachedRolePolicyArns(iam, roleName);
    const toAttach = desiredArns.filter((a) => !currentArns.includes(a));
    const toDetach = currentArns.filter((a) => !desiredArns.includes(a));

    if (toAttach.length === 0 && toDetach.length === 0) {
      ctx.log.info(`${roleName} already has exactly the desired ${desiredArns.length} policy attachment(s)`);
      return { executedAttach: JSON.stringify([]), executedDetach: JSON.stringify([]) };
    }

    // Attach before detach — never leave the execution role under-permissioned mid-run.
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

    ctx.log.success(`${roleName}: attached ${executedAttach.length}, detached ${executedDetach.length}`);

    return {
      executedAttach: JSON.stringify(executedAttach),
      executedDetach: JSON.stringify(executedDetach),
    };
  },

  async rollback(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.CFN_EXECUTION_ROLE_NAME;
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
    const roleName = ctx.params.CFN_EXECUTION_ROLE_NAME;
    return {
      type: "aws_iam_role_policy_set",
      name: roleName,
      attributes: { role: roleName, attachedCount: String(ctx.params.EXECUTION_POLICY_ARNS.length) },
    };
  },
};
