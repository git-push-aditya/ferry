import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { lifecycleStep } from "./steps/lifecycle";
import { verify } from "./verify";

/**
 * Sets lifecycle rules on a bucket that already exists. Does not create the
 * bucket; run `aws/s3/create-bucket` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/s3/enable-bucket-lifecycle-rules",
  schemaVersion: 1,
  summary:
    "Sets an existing bucket's lifecycle rules to an exact desired set, proven with a config round-trip.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [s3BucketExistsGuardStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }), lifecycleStep],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Lifecycle Rules — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/enable-bucket-lifecycle-rules\`.

## Setting

- Bucket: \`${p.S3_BUCKET_NAME}\`
- Rules: ${p.LIFECYCLE_RULES_JSON ? `set (see .env for the document)` : "not managed by ferry"}

## Verification

Verified — the stored configuration matches the desired rule set exactly
(a config round-trip; actual expiration/transition behavior runs on AWS's own
schedule and is not, and cannot practically be, verified same-run).
`;
  },
});
