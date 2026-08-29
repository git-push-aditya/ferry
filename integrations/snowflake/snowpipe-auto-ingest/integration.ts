import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { bucketNotificationStep } from "./steps/bucket-notification";
import { connectStep } from "./steps/connect";
import { pipeStep } from "./steps/pipe";
import { stageExistsGuardStep } from "./steps/stage-exists";
import { verify } from "./verify";

/**
 * Wires an S3 bucket to a Snowflake PIPE for continuous, event-driven
 * ingestion. Pipe-first ordering is a hard, non-rearrangeable dependency:
 * Snowflake mints and owns the SQS queue a pipe listens on — the queue's
 * ARN is only knowable by reading it back off the created pipe (SHOW
 * PIPES). There is no IAM/SQS policy step in this integration at all: the
 * customer side never creates a queue or grants permissions on one — the
 * only genuinely new AWS-side action is pointing the bucket's own event
 * notification configuration at the queue Snowflake already owns.
 *
 * Never creates the stage or storage integration itself — run
 * snowflake/create-storage-s3-integration first.
 */
export default defineIntegration<Params>({
  id: "snowflake/snowpipe-auto-ingest",
  schemaVersion: 1,
  summary:
    "Creates a Snowpipe object and merges its owned SQS queue into the source bucket's event notifications, proven by a live ingest of a test object.",

  // SF_FILE_FORMAT carries a zod default, so the .env-facing input (optional)
  // differs from the parsed output (required) — same ZodType<P> mismatch
  // aws/s3/create-bucket's boolFlag cast already established the precedent for.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws", "snowflake"],

  steps: [connectStep, stageExistsGuardStep, pipeStep, bucketNotificationStep],

  verify,

  reportName: (ctx) => ctx.params.SF_PIPE_NAME,

  report(ctx) {
    const p = ctx.params;
    const notificationChannel = String(ctx.outputs.notificationChannel ?? "");

    return `# Snowpipe Auto-Ingest — \`${p.SF_PIPE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/snowpipe-auto-ingest\`.

## Snowflake

- Pipe: \`${p.SF_PIPE_NAME}\`
- Target table: \`${p.SF_TARGET_TABLE}\`
- Source stage: \`${p.SF_STAGE_NAME}\`
- Notification channel (SQS queue Snowflake owns): \`${notificationChannel}\`

## S3

- Bucket: \`${p.S3_BUCKET_NAME}\`
- Watched prefix: \`${p.S3_INGEST_PREFIX}\`

## Verification

Verified — uploaded a real test object under the watched prefix and polled
\`SYSTEM$PIPE_STATUS\` until the pipe reported receiving it, then cleaned it
up.
`;
  },
});
