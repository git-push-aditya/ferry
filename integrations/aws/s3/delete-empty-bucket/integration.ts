import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { deleteBucketStep } from "./steps/delete-bucket";
import { verify } from "./verify";

/**
 * Deletes a bucket that has no objects, versions, or delete markers. Never
 * empties a non-empty bucket — that's `delete-bucket-with-transfer` or
 * `delete-bucket-with-download`, which choose deliberately where the data
 * goes rather than silently discarding it.
 */
export default defineIntegration<Params>({
  id: "aws/s3/delete-empty-bucket",
  schemaVersion: 1,
  summary:
    "Deletes a bucket that is already empty, aborting instead of emptying it if it isn't.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [deleteBucketStep],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Deletion — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/delete-empty-bucket\`.

## Setting

- Bucket: \`${p.S3_BUCKET_NAME}\`

## Verification

Verified — confirmed the bucket no longer exists.
`;
  },
});
