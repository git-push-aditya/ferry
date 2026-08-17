import { HeadBucketCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound } from "../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;

  let stillExists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: ctx.accountId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    stillExists = false;
  }

  if (stillExists) throw new Error(`s3://${bucket} still exists after the delete step`);
  ctx.log.success(`Confirmed s3://${bucket} no longer exists`);
}
