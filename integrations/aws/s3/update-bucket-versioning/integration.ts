import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep, s3VersioningStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Sets versioning on a bucket that already exists — Enabled or Suspended,
 * explicitly. Does not create the bucket: run `aws/s3/create-bucket` first if
 * it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/s3/update-bucket-versioning",
  schemaVersion: 1,
  summary:
    "Sets an existing bucket's versioning to Enabled or Suspended, proven with a polled read-back.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }),
    s3VersioningStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      desired: (p) => p.DESIRED_VERSIONING_STATUS,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Versioning — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/update-bucket-versioning\`.

## Setting

- Bucket: \`${p.S3_BUCKET_NAME}\`
- Versioning: \`${p.DESIRED_VERSIONING_STATUS}\`

## Verification

Verified — polled \`GetBucketVersioning\` until it read back \`${p.DESIRED_VERSIONING_STATUS}\`.
`;
  },
});
