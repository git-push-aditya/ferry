import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { transferStep } from "./steps/transfer";
import { verify } from "./verify";

/**
 * Copies every object from a source bucket into a destination bucket that
 * already exists, confirms every object landed, and only then deletes the
 * source bucket. Never creates the destination — that's a real ordering
 * dependency, not a cycle: run `aws/s3/create-bucket` for it first if needed.
 */
export default defineIntegration<Params>({
  id: "aws/s3/delete-bucket-with-transfer",
  schemaVersion: 1,
  summary:
    "Transfers every object to an existing destination bucket, confirms landing, then deletes the source bucket.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({
      bucket: (p) => p.DESTINATION_S3_BUCKET_NAME,
      id: "destination-bucket-exists",
      title: "Confirm the destination bucket already exists",
    }),
    transferStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.SOURCE_S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Transfer — \`${p.SOURCE_S3_BUCKET_NAME}\` → \`${p.DESTINATION_S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/delete-bucket-with-transfer\`.

## Setting

- Source: \`${p.SOURCE_S3_BUCKET_NAME}\` (deleted after transfer)
- Destination: \`${p.DESTINATION_S3_BUCKET_NAME}\` (must already exist)

## Verification

Verified — every transferred object is present in the destination bucket, and
the source bucket no longer exists.
`;
  },
});
