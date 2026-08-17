import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Encryption config only affects newly-written objects, so the live proof is
 * a fresh write — not a re-read of GetBucketEncryption, which would only
 * prove the config was stored, not that it actually applies.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;
  const key = `ferry-verify-${Date.now()}.txt`;

  const put = await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: "ferry verification\n" }),
  );

  try {
    if (put.ServerSideEncryption !== ctx.params.ENCRYPTION_ALGORITHM) {
      throw new Error(
        `Expected new objects to be encrypted with ${ctx.params.ENCRYPTION_ALGORITHM}, ` +
          `but PutObject reported "${put.ServerSideEncryption ?? "(none)"}"`,
      );
    }
    ctx.log.success(`Confirmed new objects are encrypted with ${put.ServerSideEncryption}`);
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
