import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { attachDetachStep } from "./steps/attach-detach";
import { verify } from "./verify";

/**
 * Attaches or detaches an existing EBS volume to/from an existing EC2
 * instance — one integration, parameterized by `ACTION`, the same
 * single-two-way-toggle shape as `stop-start-instance` (attach and detach
 * are exact mirror images of the same operation, not two independently
 * useful ones).
 */
export default defineIntegration<Params>({
  id: "aws/ec2/attach-detach-ebs-volume",
  schemaVersion: 1,
  summary: "Attaches or detaches an existing EBS volume to/from an existing EC2 instance.",

  // The .env-facing input differs from the parsed output (FORCE arrives as a
  // "true"/"false" string), same ZodEffects shape as create-bucket.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [attachDetachStep],

  verify,

  reportName: (ctx) => `${ctx.params.VOLUME_ID}-${ctx.params.INSTANCE_ID}`,

  report(ctx) {
    const p = ctx.params;
    return `# Attach/Detach EBS Volume — \`${p.VOLUME_ID}\` ↔ \`${p.INSTANCE_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/attach-detach-ebs-volume\`.

## Setting

- Volume: \`${p.VOLUME_ID}\`
- Instance: \`${p.INSTANCE_ID}\`
- Device: \`${p.DEVICE}\`
- Action: \`${p.ACTION}\`
- Force: \`${p.FORCE}\`

## Verification

Verified — confirmed the volume's attachment state matches the requested \`${p.ACTION}\`.
`;
  },
});
