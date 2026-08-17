import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import {
  s3BucketStep,
  s3EncryptionStep,
  s3PublicAccessBlockStep,
  s3VersioningStep,
} from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Provisions an S3 bucket with the settings a new bucket most often needs at
 * creation time: versioning, default encryption, and public-access-block —
 * each opted into independently, each its own step, and each reusable by
 * other s3/ integrations that manage the same bucket-level settings.
 */
export default defineIntegration<Params>({
  id: "aws/s3/create-bucket",
  schemaVersion: 1,
  summary:
    "Provisions an S3 bucket with opt-in versioning, default encryption, and a public-access block, proven with a live write/read against the bucket.",

  // The .env-facing input differs from the parsed output (booleans arrive as
  // "true"/"false" strings), which is a real, if unusual, ZodEffects shape
  // that z.ZodType<P>'s default same-Input-as-Output generic doesn't model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    s3BucketStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }),
    s3VersioningStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      desired: (p) => (p.ENABLE_VERSIONING ? "Enabled" : undefined),
    }),
    s3EncryptionStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      enabled: (p) => p.ENABLE_ENCRYPTION,
      algorithm: (p) => p.ENCRYPTION_ALGORITHM,
      kmsKeyId: (p) => p.ENCRYPTION_KMS_KEY_ID,
    }),
    s3PublicAccessBlockStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      blocked: (p) => p.BLOCK_PUBLIC_ACCESS,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# S3 Bucket — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/create-bucket\`.

## Bucket

- Name: \`${p.S3_BUCKET_NAME}\`
- ARN: \`arn:aws:s3:::${p.S3_BUCKET_NAME}\`

## Settings

| Setting | Value |
| --- | --- |
| Versioning | ${p.ENABLE_VERSIONING ? "Enabled" : "not managed by ferry"} |
| Default encryption | ${p.ENABLE_ENCRYPTION ? p.ENCRYPTION_ALGORITHM : "not managed by ferry (AWS default SSE-S3 applies)"} |
| Public access block | ${p.BLOCK_PUBLIC_ACCESS ? "blocking all public access" : "not blocking public access"} |

## Verification

Verified — wrote, read and deleted a test object; confirmed every opted-in
setting above against the bucket itself, not just against the API calls that
set them.
`;
  },
});
