import { CreateBucketCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import { awsClients, deleteKeys, ensureBucketState, listKeys } from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Deliberately its own step, run only after `migrate-objects` has already
 * confirmed every object present in the new bucket — never auto-chained into
 * the copy step itself. Same delete-shaped check() as
 * `delete-empty-bucket`/`delete-bucket-with-transfer`: the old bucket already
 * being gone means the target state is achieved, so a re-run is a no-op.
 */
export const deleteOldBucketStep: Step<Params> = {
  id: "delete-old-bucket",
  title: "Delete the old bucket, now that every object is confirmed in the new one",

  async check(ctx) {
    const { s3 } = awsClients(ctx);
    const state = await ensureBucketState(s3, ctx.params.OLD_S3_BUCKET_NAME, ctx.accountId);
    if (state === "conflict") return "conflict";
    if (state === "missing") return "exists"; // already deleted — nothing to do
    return "missing";
  },

  async create(ctx) {
    const { s3 } = awsClients(ctx);
    const oldBucket = ctx.params.OLD_S3_BUCKET_NAME;
    await deleteKeys(s3, oldBucket, await listKeys(s3, oldBucket));
    await s3.send(new DeleteBucketCommand({ Bucket: oldBucket }));
    ctx.log.success(`Deleted s3://${oldBucket}`);
    return { oldBucketDeletedThisRun: true };
  },

  /**
   * Best-effort, not a real restore — same limitation as `delete-empty-bucket`:
   * a deleted bucket's own configuration (versioning, policy, lifecycle, tags)
   * cannot be recovered. Recreates an empty bucket of the same name/region and
   * warns loudly.
   */
  async rollback(ctx) {
    if (ctx.outputs.oldBucketDeletedThisRun !== true) return;

    const { s3, region } = awsClients(ctx);
    const oldBucket = ctx.params.OLD_S3_BUCKET_NAME;
    await s3.send(
      new CreateBucketCommand({
        Bucket: oldBucket,
        ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
    ctx.log.warn(
      `Recreated s3://${oldBucket} as an empty bucket. This is NOT a full restore — its objects ` +
        `were migrated to the new bucket, and any bucket-level configuration it had is gone.`,
    );
  },

  resource(ctx) {
    return {
      type: "aws_s3_bucket",
      name: ctx.params.OLD_S3_BUCKET_NAME,
      attributes: { arn: `arn:aws:s3:::${ctx.params.OLD_S3_BUCKET_NAME}`, action: "deleted" },
    };
  },
};
