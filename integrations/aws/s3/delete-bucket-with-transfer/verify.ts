import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound, listKeys } from "../../../../src/providers/aws";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const source = ctx.params.SOURCE_S3_BUCKET_NAME;
  const destination = ctx.params.DESTINATION_S3_BUCKET_NAME;

  const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
  if (keysJson) {
    const transferred = JSON.parse(keysJson) as string[];
    const destKeys = new Set(await listKeys(s3, destination));
    const missing = transferred.filter((k) => !destKeys.has(k));
    if (missing.length) {
      throw new Error(
        `${missing.length} of ${transferred.length} transferred object(s) are missing from ` +
          `s3://${destination}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
      );
    }
    ctx.log.success(`Confirmed all ${transferred.length} transferred object(s) are present in s3://${destination}`);
  }

  let sourceStillExists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: source, ExpectedBucketOwner: ctx.accountId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    sourceStillExists = false;
  }
  if (sourceStillExists) throw new Error(`s3://${source} still exists after the transfer step`);
  ctx.log.success(`Confirmed s3://${source} no longer exists`);
}
