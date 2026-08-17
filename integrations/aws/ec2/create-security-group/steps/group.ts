import {
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
} from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import { awsClients, ferryIdentityTags } from "../../../../../src/providers/aws";
import {
  applyRuleDiff,
  describeGroupRules,
  diffRules,
  pollRulesConverged,
} from "../../update-security-group-rules/steps/rules";
import type { Params } from "../params";

const INTEGRATION_ID = "aws/ec2/create-security-group";

function isDependencyViolation(err: unknown): boolean {
  return (err as { name?: string })?.name === "DependencyViolation";
}

/**
 * Two-layer design, per the plan's explicit call-out: create() handles the
 * group's existence (create-or-skip, keyed on name+VPC per AWS's own
 * per-VPC-uniqueness rule), while reconcile() — which the engine runs
 * whenever create() did NOT — re-applies the starting rule list against
 * whatever's actually live. This closes the gap where an interrupted first
 * run left the group existing but under-ruled: without reconcile(), check()
 * would see the tagged group as "exists" and never retry the missing rules.
 *
 * Both create()'s initial rule application and reconcile()'s catch-up diff
 * go through the SAME shared helpers `update-security-group-rules` uses
 * (`diffRules`/`applyRuleDiff`/`pollRulesConverged`), so there is exactly one
 * implementation of the add/remove diff logic, not two drifting apart.
 */
export const groupStep: Step<Params> = {
  id: "create-security-group",
  title: "Create the security group",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const described = await ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [
          { Name: "group-name", Values: [ctx.params.GROUP_NAME] },
          { Name: "vpc-id", Values: [ctx.params.VPC_ID] },
        ],
      }),
    );

    const group = described.SecurityGroups?.[0];
    if (!group) return "missing";

    const ownedByThisIntegration = (group.Tags ?? []).some(
      (tag) => tag.Key === "ferry:integration-id" && tag.Value === INTEGRATION_ID,
    );
    return ownedByThisIntegration ? "exists" : "conflict";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);

    const created = await ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: ctx.params.GROUP_NAME,
        Description: ctx.params.GROUP_DESCRIPTION,
        VpcId: ctx.params.VPC_ID,
        TagSpecifications: [
          {
            ResourceType: "security-group",
            Tags: ferryIdentityTags(INTEGRATION_ID, ctx.params.GROUP_NAME),
          },
        ],
      }),
    );

    const groupId = created.GroupId;
    if (!groupId) throw new Error("CreateSecurityGroup did not return a group id");

    ctx.log.info(`Created security group ${groupId}, applying starting rules...`);

    // "Live" is empty for a brand-new group, so the diff against the
    // starting rule lists is entirely adds.
    const ingressDiff = diffRules([], ctx.params.INGRESS_RULES);
    const egressDiff = diffRules([], ctx.params.EGRESS_RULES);

    await applyRuleDiff(ec2, groupId, "ingress", ingressDiff);
    await applyRuleDiff(ec2, groupId, "egress", egressDiff);

    const confirmed = await pollRulesConverged(
      ec2,
      groupId,
      ctx.params.INGRESS_RULES,
      ctx.params.EGRESS_RULES,
    );
    if (confirmed) {
      ctx.log.success(`Security group ${groupId} starting rules confirmed applied`);
    } else {
      ctx.log.warn(`Security group ${groupId} starting rules did not confirm applied within the timeout`);
    }

    return {
      groupId,
      vpcId: ctx.params.VPC_ID,
      ruleCount: ctx.params.INGRESS_RULES.length + ctx.params.EGRESS_RULES.length,
    };
  },

  /**
   * Runs whenever create() did NOT — i.e. the group already existed from a
   * prior partial run. Re-diffs the SAME starting rule list against the
   * live group's current rules and applies only whatever's still missing.
   */
  async reconcile(ctx) {
    const { ec2 } = awsClients(ctx);

    const described = await ec2.send(
      new DescribeSecurityGroupsCommand({
        Filters: [
          { Name: "group-name", Values: [ctx.params.GROUP_NAME] },
          { Name: "vpc-id", Values: [ctx.params.VPC_ID] },
        ],
      }),
    );
    const group = described.SecurityGroups?.[0];
    if (!group?.GroupId) throw new Error(`Security group ${ctx.params.GROUP_NAME} not found to reconcile`);
    const groupId = group.GroupId;

    const rules = await describeGroupRules(ec2, groupId);
    const ingressDiff = diffRules(rules?.ingress ?? [], ctx.params.INGRESS_RULES);
    const egressDiff = diffRules(rules?.egress ?? [], ctx.params.EGRESS_RULES);

    ctx.log.info(
      `Security group ${groupId} already exists — catching up ` +
        `${ingressDiff.toAdd.length} missing ingress and ${egressDiff.toAdd.length} missing egress rule(s)`,
    );

    // Never revoke here — a prior run's under-ruled group only needs the
    // starting rules it's still missing, not a full replace of whatever a
    // user may have separately added.
    await applyRuleDiff(ec2, groupId, "ingress", { toRevoke: [], toAdd: ingressDiff.toAdd });
    await applyRuleDiff(ec2, groupId, "egress", { toRevoke: [], toAdd: egressDiff.toAdd });

    await pollRulesConverged(ec2, groupId, ctx.params.INGRESS_RULES, ctx.params.EGRESS_RULES);

    return {
      groupId,
      vpcId: ctx.params.VPC_ID,
      ruleCount: ctx.params.INGRESS_RULES.length + ctx.params.EGRESS_RULES.length,
    };
  },

  async rollback(ctx) {
    const groupId = ctx.outputs.groupId as string | undefined;
    if (!groupId) return;

    const { ec2 } = awsClients(ctx);
    try {
      await ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      ctx.log.warn(`Rolled back — deleted security group ${groupId}`);
    } catch (err) {
      if (isDependencyViolation(err)) {
        ctx.log.warn(
          `Could not delete security group ${groupId} during rollback — still referenced by another resource`,
        );
        return;
      }
      throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_security_group",
      name: ctx.params.GROUP_NAME,
      attributes: {
        groupId: (ctx.outputs.groupId as string) ?? "",
        vpcId: ctx.params.VPC_ID,
        ruleCount: String(ctx.outputs.ruleCount ?? 0),
      },
    };
  },
};
