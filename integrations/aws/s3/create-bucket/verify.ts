import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { pollUntil } from "../../../../src/core/wait";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

interface BodyWithTransformToString {
  transformToString?: () => Promise<string>;
}

async function readBody(body: unknown): Promise<string> {
  const stream = body as BodyWithTransformToString;
  if (typeof stream?.transformToString === "function") return stream.transformToString();
  return "";
}

/**
 * "Provisioned" means proven working, not just "the API calls returned 200".
 * Every opted-in setting gets a live check against the bucket itself, not a
 * re-read of what was just written — that would only prove the write
 * succeeded, not that the setting is what it claims to be.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;

  const key = `ferry-verify-${Date.now()}.txt`;
  const body = `ferry verification ${new Date().toISOString()}\n`;

  const put = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  ctx.log.success(`Wrote s3://${bucket}/${key}`);

  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if ((await readBody(got.Body)) !== body) {
      throw new Error("Read-back of the verification object did not match what was written");
    }
    ctx.log.success("Read it back byte for byte");

    if (ctx.params.ENABLE_ENCRYPTION) {
      if (put.ServerSideEncryption !== ctx.params.ENCRYPTION_ALGORITHM) {
        throw new Error(
          `Expected new objects to be encrypted with ${ctx.params.ENCRYPTION_ALGORITHM}, ` +
            `but PutObject reported "${put.ServerSideEncryption ?? "(none)"}"`,
        );
      }
      ctx.log.success(`Confirmed new objects are encrypted with ${put.ServerSideEncryption}`);
    }
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    ctx.log.success("Deleted the verification object");
  }

  if (ctx.params.ENABLE_VERSIONING) {
    const confirmed = await pollUntil(
      async () => {
        const status = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
        return status.Status === "Enabled";
      },
      { intervalMs: 2_000, timeoutMs: 15_000, label: "Bucket versioning reads back Enabled" },
    );
    if (!confirmed) {
      throw new Error(`s3://${bucket} versioning did not confirm as Enabled after enabling it`);
    }
    ctx.log.success("Confirmed bucket versioning is Enabled");
  }

  const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
  const wantBlocked = ctx.params.BLOCK_PUBLIC_ACCESS;
  const actual = pab.PublicAccessBlockConfiguration;
  const matches =
    actual?.BlockPublicAcls === wantBlocked &&
    actual?.IgnorePublicAcls === wantBlocked &&
    actual?.BlockPublicPolicy === wantBlocked &&
    actual?.RestrictPublicBuckets === wantBlocked;
  if (!matches) {
    throw new Error(
      `s3://${bucket} public access block does not match BLOCK_PUBLIC_ACCESS=${wantBlocked}`,
    );
  }
  ctx.log.success(`Confirmed public access block matches BLOCK_PUBLIC_ACCESS=${wantBlocked}`);
}
