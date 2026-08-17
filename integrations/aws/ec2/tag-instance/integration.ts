import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { tagsStep } from "./steps/tags";
import { verify } from "./verify";

/**
 * Sets an existing instance's tags to (at least) a desired set. Does not
 * create the instance; run `aws/ec2/launch-instance` first if it doesn't
 * exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/tag-instance",
  schemaVersion: 1,
  summary:
    "Reconciles an existing instance's tags against a desired set, proven with a live read-back.",

  // TAGS/PRUNE_UNMANAGED_TAGS arrive as strings and are parsed/coerced here —
  // same ZodEffects Input != Output shape as create-bucket's boolFlag.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [tagsStep],

  verify,

  reportName: (ctx) => ctx.params.INSTANCE_ID,

  report(ctx) {
    const p = ctx.params;
    return `# Instance Tags — \`${p.INSTANCE_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/tag-instance\`.

## Setting

- Instance: \`${p.INSTANCE_ID}\`
- Tags: \`${JSON.stringify(p.TAGS)}\`
- Prune unmanaged tags: ${p.PRUNE_UNMANAGED_TAGS ? "yes" : "no (additive/updating only)"}

## Verification

Verified — read the instance's tags back and confirmed the desired set is
present${p.PRUNE_UNMANAGED_TAGS ? " and no unmanaged tags remain" : ""}.
`;
  },
});
