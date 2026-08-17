import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { tagsStep } from "./steps/tags";
import { verify } from "./verify";

/**
 * Sets a bucket's tags on a bucket that already exists. Does not create the
 * bucket; run `aws/s3/create-bucket` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/s3/tag-bucket",
  schemaVersion: 1,
  summary: "Sets an existing bucket's tags to an exact desired set, proven with a live read-back.",

  // .default("") makes the .env-facing input optional even though the
  // parsed output is always a string — same ZodEffects shape create-bucket's
  // boolean flags hit.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [s3BucketExistsGuardStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }), tagsStep],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Tags — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/tag-bucket\`.

## Setting

- Bucket: \`${p.S3_BUCKET_NAME}\`
- Tags: ${p.TAGS_JSON ? `\`${p.TAGS_JSON}\`` : "not managed by ferry"}

## Verification

Verified — read the bucket's tags back and confirmed they match the desired
set exactly.
`;
  },
});
