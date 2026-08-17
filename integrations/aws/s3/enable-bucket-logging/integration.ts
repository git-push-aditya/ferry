import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { loggingStep } from "./steps/logging";
import { verify } from "./verify";

/**
 * Enables server access logging on a bucket that already exists, to a target
 * bucket that also already exists. Does not create either bucket, and does
 * not grant the target bucket's log-delivery policy — see README.
 */
export default defineIntegration<Params>({
  id: "aws/s3/enable-bucket-logging",
  schemaVersion: 1,
  summary:
    "Enables server access logging on an existing bucket to an existing target bucket, proven with a config round-trip.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }),
    s3BucketExistsGuardStep<Params>({
      bucket: (p) => p.LOGGING_TARGET_BUCKET,
      id: "logging-target-bucket-exists",
      title: "Confirm the logging target bucket already exists",
    }),
    loggingStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Logging — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/enable-bucket-logging\`.

## Setting

- Bucket: \`${p.S3_BUCKET_NAME}\`
- Target: \`s3://${p.LOGGING_TARGET_BUCKET}/${p.LOGGING_TARGET_PREFIX}\`

## Verification

Verified — the stored logging configuration targets the desired bucket and
prefix (a config round-trip; actual log delivery is best-effort and
asynchronous, and is not, and cannot practically be, verified same-run).

## Before you run this

The target bucket must already grant the S3 log-delivery principal write
permission via its own bucket policy (e.g. via
\`aws/s3/update-bucket-permissions\`). AWS accepts this call regardless and
silently delivers nothing if that grant is missing — this integration does
not check for it.
`;
  },
});
