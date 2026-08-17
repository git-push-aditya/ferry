import { requireOutput, type StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import { describeGroupRules, diffRules } from "../update-security-group-rules/steps/rules";
import type { Params } from "./params";

/**
 * "Created" means present with the expected starting rule set, checked live
 * (set-equality, not order-sensitive) — not just trusted from the API calls
 * that applied them.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const groupId = requireOutput<string>(ctx, "groupId");

  const rules = await describeGroupRules(ec2, groupId);
  if (!rules) throw new Error(`Security group ${groupId} not found during verify`);

  const ingressDiff = diffRules(rules.ingress, ctx.params.INGRESS_RULES);
  if (ingressDiff.toRevoke.length > 0 || ingressDiff.toAdd.length > 0) {
    throw new Error(
      `Security group ${groupId} ingress rules do not match the starting set ` +
        `(${ingressDiff.toRevoke.length} extra, ${ingressDiff.toAdd.length} missing)`,
    );
  }

  const egressDiff = diffRules(rules.egress, ctx.params.EGRESS_RULES);
  if (egressDiff.toRevoke.length > 0 || egressDiff.toAdd.length > 0) {
    throw new Error(
      `Security group ${groupId} egress rules do not match the starting set ` +
        `(${egressDiff.toRevoke.length} extra, ${egressDiff.toAdd.length} missing)`,
    );
  }

  ctx.log.success(`Confirmed security group ${groupId} has the expected starting rule set`);
}
