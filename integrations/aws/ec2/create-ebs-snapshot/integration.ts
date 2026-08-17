import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { snapshotStep } from "./steps/snapshot";
import { verify } from "./verify";

/**
 * Creates a point-in-time snapshot of an existing EBS volume. Create-only —
 * idempotency is handled at the Ferry level via an identity tag
 * (`ferry:integration-id` + `ferry:logical-name`) looked up in check(),
 * since CreateSnapshot itself has no client token.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/create-ebs-snapshot",
  schemaVersion: 1,
  summary: "Creates and confirms a point-in-time snapshot of an existing EBS volume.",

  // The .env-facing input differs from the parsed output (STOP_INSTANCE_FIRST
  // arrives as a "true"/"false" string), same ZodEffects shape as create-bucket.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [snapshotStep],

  verify,

  reportName: (ctx) => ctx.params.LOGICAL_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# EBS Snapshot — \`${p.LOGICAL_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/create-ebs-snapshot\`.

## Setting

- Volume: \`${p.VOLUME_ID}\`
- Logical name (identity tag): \`${p.LOGICAL_NAME}\`
- Stopped instance first: \`${p.STOP_INSTANCE_FIRST}\`${p.STOP_INSTANCE_FIRST ? ` (\`${p.INSTANCE_ID}\`)` : ""}

## Verification

Verified — confirmed the snapshot reached \`completed\` and its \`VolumeId\` matches \`${p.VOLUME_ID}\`.
`;
  },
});
