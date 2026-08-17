import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { groupStep } from "./steps/group";
import { verify } from "./verify";

/**
 * Creates a security group (create-or-skip, keyed on name+VPC per AWS's own
 * per-VPC name uniqueness) and applies its starting ingress/egress rule
 * list. Deliberately a two-layer step — create() for the group's existence,
 * reconcile() to catch up any starting rules a prior partial run left
 * missing — per the plan's explicit fix for the "group exists but under-
 * ruled" gap. Ongoing rule changes after this run are
 * `aws/ec2/update-security-group-rules`'s job, not this integration's.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/create-security-group",
  schemaVersion: 1,
  summary:
    "Creates a security group with a starting ingress/egress rule set, proven present with the expected rules.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [groupStep],

  verify,

  reportName: (ctx) => ctx.params.GROUP_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Security Group — \`${p.GROUP_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/create-security-group\`.

## Group

| Field | Value |
| --- | --- |
| Name | \`${p.GROUP_NAME}\` |
| Description | \`${p.GROUP_DESCRIPTION}\` |
| VPC | \`${p.VPC_ID}\` |
| Starting ingress rules | ${p.INGRESS_RULES.length} |
| Starting egress rules | ${p.EGRESS_RULES.length} |

## Verification

Verified — confirmed the group is present with the expected starting rule
set, for both ingress and egress.
`;
  },
});
