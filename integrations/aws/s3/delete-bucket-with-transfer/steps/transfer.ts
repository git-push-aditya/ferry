import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import {
  awsClients,
  copyObject,
  deleteKeys,
  ensureBucketState,
  listKeys,
  objectExists,
} from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * One step, not N — copying N objects doesn't fit the "N independently
 * identified resources" shape a step-factory targets; this is one aggregate
 * action whose `resource()` describes the transfer as a whole.
 *
 * Same delete-shaped check() as `delete-empty-bucket`: the source already
 * being gone means the target state (transferred + deleted) is achieved, so
 * check() reads that as "exists" — an idempotent no-op on re-run.
 *
 * The phase ordering here is a hard invariant, not best-effort: every key is
 * copied AND confirmed landed in the destination before the source is
 * touched at all. Never delete source objects/bucket until that full
 * confirmation — that's what makes the source-deletion step safe to run
 * unconditionally once reached.
 */
export const transferStep: Step<Params> = {
  id: "transfer-and-delete-source",
  title: "Copy every object to the destination, then delete the source bucket",

  async check(ctx) {
    const { s3 } = awsClients(ctx);
    const state = await ensureBucketState(s3, ctx.params.SOURCE_S3_BUCKET_NAME, ctx.accountId);
    if (state === "conflict") return "conflict";
    if (state === "missing") return "exists"; // already transferred + deleted — nothing to do
    return "missing"; // source still present — transfer + delete still needs to happen
  },

  async create(ctx) {
    const { s3 } = awsClients(ctx);
    const source = ctx.params.SOURCE_S3_BUCKET_NAME;
    const destination = ctx.params.DESTINATION_S3_BUCKET_NAME;

    const keys = await listKeys(s3, source);
    ctx.log.info(`Copying ${keys.length} object(s) from s3://${source} to s3://${destination}`);

    const copiedKeys: string[] = [];
    for (const key of keys) {
      await copyObject(s3, { bucket: source, key }, { bucket: destination, key });
      if (!(await objectExists(s3, destination, key))) {
        throw new Error(
          `s3://${destination}/${key} did not confirm as landed after copying — aborting ` +
            `before touching the source bucket. ${copiedKeys.length} object(s) copied so far.`,
        );
      }
      copiedKeys.push(key);
    }
    ctx.log.success(`Confirmed all ${copiedKeys.length} object(s) landed in s3://${destination}`);

    // Only now, with every object confirmed, is it safe to touch the source.
    await deleteKeys(s3, source, keys);
    await s3.send(new DeleteBucketCommand({ Bucket: source }));
    ctx.log.success(`Deleted s3://${source}`);

    return { transferredKeysJson: JSON.stringify(copiedKeys) };
  },

  /**
   * Deletes only the keys THIS RUN copied into the destination — never
   * pre-existing destination objects, and never the destination bucket
   * itself (this integration does not own it). The source is never restored
   * here: by the time this step's create() could fail partway, the source
   * deletion has not run yet (it's gated behind full confirmation), so there
   * is nothing to undo on the source side.
   */
  async rollback(ctx) {
    const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
    if (!keysJson) return;

    const keys = JSON.parse(keysJson) as string[];
    if (!keys.length) return;

    await deleteKeys(awsClients(ctx).s3, ctx.params.DESTINATION_S3_BUCKET_NAME, keys);
  },

  resource(ctx) {
    const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
    const objectCount = keysJson ? (JSON.parse(keysJson) as string[]).length : 0;
    return {
      type: "aws_s3_bucket_transfer",
      name: ctx.params.SOURCE_S3_BUCKET_NAME,
      attributes: {
        sourceBucket: ctx.params.SOURCE_S3_BUCKET_NAME,
        destinationBucket: ctx.params.DESTINATION_S3_BUCKET_NAME,
        objectCount: String(objectCount),
      },
    };
  },
};
