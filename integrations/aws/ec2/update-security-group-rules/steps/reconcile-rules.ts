import type { IpPermission } from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "../params";
import { applyRuleDiff, describeGroupRules, diffRules, pollRulesConverged } from "./rules";

/**
 * Always-reconcile, self-idempotent — same shape as `s3VersioningStep` /
 * `s3BucketExistsGuardStep`'s sibling pattern for whole-document-replace
 * APIs, except a security group's rule set isn't a single PUT, so the diff
 * is computed and applied as add/remove every run (the shared helpers in
 * `./rules.ts`, also used by `create-security-group`'s reconcile()).
 *
 * check() always returns "missing" (meaning "reconcile still needs to run")
 * when the group exists, and "conflict" when it doesn't — this integration
 * never creates a group (real precondition, not a cycle), so there is no
 * "missing" in the create-or-skip sense, and no clean "already matches" skip
 * state distinguishable at check() time without doing the same diff work
 * reconcile() does anyway. reconcile() itself is what short-circuits to a
 * no-op when the live set already matches desired.
 */
export const reconcileRulesStep: Step<Params> = {
  id: "reconcile-security-group-rules",
  title: "Reconcile the security group's rule set to the desired state",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const rules = await describeGroupRules(ec2, ctx.params.GROUP_ID);
    return rules ? "missing" : "conflict";
  },

  async reconcile(ctx) {
    const { ec2 } = awsClients(ctx);
    const groupId = ctx.params.GROUP_ID;

    const rules = await describeGroupRules(ec2, groupId);
    if (!rules) throw new Error(`Security group ${groupId} not found`);

    const ingressDiff = diffRules(rules.ingress, ctx.params.DESIRED_INGRESS_RULES);
    const egressDiff = diffRules(rules.egress, ctx.params.DESIRED_EGRESS_RULES);

    ctx.log.info(
      `Ingress: ${ingressDiff.toRevoke.length} to revoke, ${ingressDiff.toAdd.length} to add. ` +
        `Egress: ${egressDiff.toRevoke.length} to revoke, ${egressDiff.toAdd.length} to add.`,
    );

    await applyRuleDiff(ec2, groupId, "ingress", ingressDiff);
    await applyRuleDiff(ec2, groupId, "egress", egressDiff);

    const confirmed = await pollRulesConverged(
      ec2,
      groupId,
      ctx.params.DESIRED_INGRESS_RULES,
      ctx.params.DESIRED_EGRESS_RULES,
    );
    if (confirmed) {
      ctx.log.success(`Security group ${groupId} rules confirmed converged`);
    } else {
      ctx.log.warn(`Security group ${groupId} rules did not confirm converged within the timeout`);
    }

    // Captured for rollback: exactly what this run revoked and added, in full
    // IpPermission shape, so rollback can replay the diff in reverse.
    return {
      revokedIngressJson: JSON.stringify(ingressDiff.toRevoke),
      addedIngressJson: JSON.stringify(ingressDiff.toAdd),
      revokedEgressJson: JSON.stringify(egressDiff.toRevoke),
      addedEgressJson: JSON.stringify(egressDiff.toAdd),
    };
  },

  /** Re-authorizes whatever this run revoked, and re-revokes whatever this run added. */
  async rollback(ctx) {
    const { ec2 } = awsClients(ctx);
    const groupId = ctx.params.GROUP_ID;

    const revokedIngress = JSON.parse(
      (ctx.outputs.revokedIngressJson as string) ?? "[]",
    ) as IpPermission[];
    const addedIngress = JSON.parse((ctx.outputs.addedIngressJson as string) ?? "[]") as IpPermission[];
    const revokedEgress = JSON.parse(
      (ctx.outputs.revokedEgressJson as string) ?? "[]",
    ) as IpPermission[];
    const addedEgress = JSON.parse((ctx.outputs.addedEgressJson as string) ?? "[]") as IpPermission[];

    await applyRuleDiff(ec2, groupId, "ingress", { toRevoke: addedIngress, toAdd: revokedIngress });
    await applyRuleDiff(ec2, groupId, "egress", { toRevoke: addedEgress, toAdd: revokedEgress });

    ctx.log.warn(`Rolled back rule changes on security group ${groupId}`);
  },

  resource(ctx) {
    return {
      type: "aws_security_group_ruleset",
      name: ctx.params.GROUP_ID,
      attributes: {
        groupId: ctx.params.GROUP_ID,
        ingressCount: String(ctx.params.DESIRED_INGRESS_RULES.length),
        egressCount: String(ctx.params.DESIRED_EGRESS_RULES.length),
      },
    };
  },
};
