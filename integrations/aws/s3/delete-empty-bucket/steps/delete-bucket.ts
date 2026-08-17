import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import { awsClients, ensureBucketState } from "../../../../../src/providers/aws";
import type { Params } from "../params";

/** Zero objects, zero versions, zero delete markers — DeleteBucket's own precondition. */
async function isEmpty(
  s3: ReturnType<typeof awsClients>["s3"],
  bucket: string,
): Promise<boolean> {
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
  if ((objects.Contents ?? []).length > 0) return false;

  const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1 }));
  return (versions.Versions ?? []).length === 0 && (versions.DeleteMarkers ?? []).length === 0;
}

/**
 * A delete-type step maps onto the create-or-skip contract inverted: "the
 * target state" is *the bucket being gone*, so check() returns "missing" when
 * the deletion still needs to happen (bucket present and empty) and "exists"
 * when it's already achieved (bucket already gone — nothing to do, matching
 * idempotency: a re-run after a successful delete is a clean no-op, not an
 * error). A present-but-non-empty bucket is "conflict" — this step never
 * silently empties a bucket; that's a different, explicitly named task.
 */
export const deleteBucketStep: Step<Params> = {
  id: "delete-empty-bucket",
  title: "Delete the bucket (must already be empty)",

  async check(ctx) {
    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;

    const state = await ensureBucketState(s3, bucket, ctx.accountId);
    if (state === "conflict") return "conflict";
    if (state === "missing") return "exists"; // already gone — nothing to do

    return (await isEmpty(s3, bucket)) ? "missing" : "conflict";
  },

  async create(ctx) {
    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    ctx.log.success(`Deleted s3://${bucket}`);
    return { bucketDeletedThisRun: true };
  },

  /**
   * Cannot truly un-delete — bucket-level config (versioning, policy,
   * lifecycle, tags) is gone once the bucket is deleted, and there is no API
   * to restore it. Best-effort: recreate an empty bucket of the same
   * name/region, loudly flagged as not a full restore.
   */
  async rollback(ctx) {
    if (ctx.outputs.bucketDeletedThisRun !== true) return;

    const { s3, region } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
    ctx.log.warn(
      `Recreated s3://${bucket} as an empty bucket. This is NOT a full restore — any versioning, ` +
        `policy, lifecycle, or tag configuration the bucket had is gone and was not recoverable.`,
    );
  },

  resource(ctx) {
    return {
      type: "aws_s3_bucket",
      name: ctx.params.S3_BUCKET_NAME,
      attributes: { arn: `arn:aws:s3:::${ctx.params.S3_BUCKET_NAME}`, action: "deleted" },
    };
  },
};
