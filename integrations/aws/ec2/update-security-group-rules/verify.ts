import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";
import { describeGroupRules, diffRules } from "./steps/rules";

/**
 * Live-verifies the security group's rule set set-equals the desired rule
 * set, both directions — re-uses the shared diff so "matches" means the
 * same thing here as it does inside reconcile()'s own convergence poll.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const groupId = ctx.params.GROUP_ID;

  const rules = await describeGroupRules(ec2, groupId);
  if (!rules) throw new Error(`Security group ${groupId} not found during verify`);

  const ingressDiff = diffRules(rules.ingress, ctx.params.DESIRED_INGRESS_RULES);
  if (ingressDiff.toRevoke.length > 0 || ingressDiff.toAdd.length > 0) {
    throw new Error(
      `Security group ${groupId} ingress rules do not match desired ` +
        `(${ingressDiff.toRevoke.length} extra, ${ingressDiff.toAdd.length} missing)`,
    );
  }

  const egressDiff = diffRules(rules.egress, ctx.params.DESIRED_EGRESS_RULES);
  if (egressDiff.toRevoke.length > 0 || egressDiff.toAdd.length > 0) {
    throw new Error(
      `Security group ${groupId} egress rules do not match desired ` +
        `(${egressDiff.toRevoke.length} extra, ${egressDiff.toAdd.length} missing)`,
    );
  }

  ctx.log.success(`Confirmed security group ${groupId} ingress and egress rules match desired`);
}
