import { HeadBucketCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound, listKeys } from "../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const oldBucket = ctx.params.OLD_S3_BUCKET_NAME;
  const newBucket = ctx.params.NEW_S3_BUCKET_NAME;

  const keysJson = ctx.outputs.migratedKeysJson as string | undefined;
  if (keysJson) {
    const migrated = JSON.parse(keysJson) as string[];
    const newKeys = new Set(await listKeys(s3, newBucket));
    const missing = migrated.filter((k) => !newKeys.has(k));
    if (missing.length) {
      throw new Error(
        `${missing.length} of ${migrated.length} migrated object(s) are missing from s3://${newBucket}`,
      );
    }
    ctx.log.success(`Confirmed all ${migrated.length} migrated object(s) are present in s3://${newBucket}`);
  }

  let oldStillExists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: oldBucket, ExpectedBucketOwner: ctx.accountId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    oldStillExists = false;
  }
  if (oldStillExists) throw new Error(`s3://${oldBucket} still exists after the migration`);
  ctx.log.success(`Confirmed s3://${oldBucket} no longer exists`);
}
