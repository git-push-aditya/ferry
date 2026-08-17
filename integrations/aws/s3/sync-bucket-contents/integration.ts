import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { syncStep } from "./steps/sync";
import { verify } from "./verify";

/**
 * Repeatable, non-destructive one-way sync between two buckets that already
 * exist. Unlike `delete-bucket-with-transfer`, the source is never touched
 * and the destination is never deleted from — meant to be run again and
 * again, converging to a no-op as it catches up.
 */
export default defineIntegration<Params>({
  id: "aws/s3/sync-bucket-contents",
  schemaVersion: 1,
  summary:
    "Repeatable one-way sync from a source bucket to a destination bucket, proven by re-running the same diff.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({
      bucket: (p) => p.SOURCE_S3_BUCKET_NAME,
      id: "source-bucket-exists",
      title: "Confirm the source bucket already exists",
    }),
    s3BucketExistsGuardStep<Params>({
      bucket: (p) => p.DESTINATION_S3_BUCKET_NAME,
      id: "destination-bucket-exists",
      title: "Confirm the destination bucket already exists",
    }),
    syncStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.SOURCE_S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Sync — \`${p.SOURCE_S3_BUCKET_NAME}\` → \`${p.DESTINATION_S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/sync-bucket-contents\`.

## Setting

- Source: \`${p.SOURCE_S3_BUCKET_NAME}\` (never modified)
- Destination: \`${p.DESTINATION_S3_BUCKET_NAME}\`
${p.KEY_PREFIX_FILTER ? `- Key prefix filter: \`${p.KEY_PREFIX_FILTER}\`\n` : ""}
## Verification

Verified — re-ran the same key+size diff after syncing and confirmed it's
now empty.
`;
  },
});
