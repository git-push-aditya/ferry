import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep, s3EncryptionStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Sets default encryption on a bucket that already exists. Does not create
 * the bucket: run `aws/s3/create-bucket` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/s3/update-bucket-encryption",
  schemaVersion: 1,
  summary:
    "Sets an existing bucket's default encryption (AES256 or aws:kms), proven with a live write.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }),
    s3EncryptionStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      enabled: () => true,
      algorithm: (p) => p.ENCRYPTION_ALGORITHM,
      kmsKeyId: (p) => p.ENCRYPTION_KMS_KEY_ID,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Encryption — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/update-bucket-encryption\`.

## Setting

- Bucket: \`${p.S3_BUCKET_NAME}\`
- Algorithm: \`${p.ENCRYPTION_ALGORITHM}\`
${p.ENCRYPTION_KMS_KEY_ID ? `- KMS key: \`${p.ENCRYPTION_KMS_KEY_ID}\`\n` : ""}
## Verification

Verified — wrote a test object and confirmed its response reported
\`${p.ENCRYPTION_ALGORITHM}\` server-side encryption, not just that the bucket
config was stored.
`;
  },
});
