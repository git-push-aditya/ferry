import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { assignEipStep } from "./steps/assign-eip";
import { verify } from "./verify";

/**
 * Allocates a new Elastic IP and associates it with an existing instance,
 * tagged with this integration's identity so a re-run finds it (and skips)
 * instead of allocating a second one. Does not cover "associate an existing
 * pre-allocated EIP" — a different, simpler task not in scope here.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/assign-elastic-ip",
  schemaVersion: 1,
  summary:
    "Allocates a new Elastic IP and associates it with an instance, tagged for idempotent re-runs, proven with a live read-back.",

  // TAGS arrives as a JSON string and is parsed into Record<string,string>
  // here — same ZodEffects Input != Output shape as launch-instance's TAGS.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [assignEipStep],

  verify,

  reportName: (ctx) => ctx.params.LOGICAL_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Elastic IP — \`${p.LOGICAL_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/assign-elastic-ip\`.

## Setting

| Field | Value |
| --- | --- |
| Logical name | \`${p.LOGICAL_NAME}\` |
| Instance | \`${p.INSTANCE_ID}\` |

## Verification

Verified — read the Elastic IP back and confirmed it is associated with the
target instance.
`;
  },
});
