import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { reconcileRulesStep } from "./steps/reconcile-rules";
import { verify } from "./verify";

/**
 * Always-reconciles a security group's ingress/egress rule set to exactly
 * what's declared in params — never creates the group itself (real
 * precondition, not a cycle; see `create-security-group` for that). Fully
 * reversible: rollback replays the diff in reverse using the pre-image
 * captured during reconcile().
 */
export default defineIntegration<Params>({
  id: "aws/ec2/update-security-group-rules",
  schemaVersion: 1,
  summary:
    "Reconciles a security group's ingress/egress rule set to the declared desired state, proven by re-diffing live rules.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [reconcileRulesStep],

  verify,

  reportName: (ctx) => ctx.params.GROUP_ID,

  report(ctx) {
    const p = ctx.params;
    return `# Security Group Rules — \`${p.GROUP_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/update-security-group-rules\`.

## Group

- Group id: \`${p.GROUP_ID}\` (never created by this integration — must already exist)
- Desired ingress rules: ${p.DESIRED_INGRESS_RULES.length}
- Desired egress rules: ${p.DESIRED_EGRESS_RULES.length}

## Verification

Verified — re-diffed the live rule set against the desired set and confirmed
it's now empty, for both ingress and egress.
`;
  },
});
