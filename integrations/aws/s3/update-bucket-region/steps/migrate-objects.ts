import type { Step } from "../../../../../src/core/define";
import {
  awsClients,
  copyObject,
  deleteKeys,
  listKeys,
  objectExists,
} from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * S3 has no in-place region migration API — this is create-new + copy +
 * verify + cutover. This step is the copy phase only; it never deletes
 * anything on the old side. That's `delete-old-bucket-step`, a deliberately
 * separate, explicitly-confirmed step rather than something auto-chained
 * here — the same "prove before the destructive half runs" discipline as
 * `delete-bucket-with-transfer`.
 *
 * check() always re-copies if the old bucket still exists: unlike a
 * one-shot transfer, this step's job (get everything into the new bucket) is
 * naturally idempotent — re-copying an already-copied key is a safe overwrite
 * — and there is no cheap way to know "already fully migrated" short of
 * re-listing both sides, which this does anyway as part of copying.
 */
export const migrateObjectsStep: Step<Params> = {
  id: "migrate-objects",
  title: "Copy every object from the old bucket to the new one",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { s3 } = awsClients(ctx);
    const oldBucket = ctx.params.OLD_S3_BUCKET_NAME;
    const newBucket = ctx.params.NEW_S3_BUCKET_NAME;

    const keys = await listKeys(s3, oldBucket);
    ctx.log.info(`Copying ${keys.length} object(s) from s3://${oldBucket} to s3://${newBucket}`);

    const copiedKeys: string[] = [];
    for (const key of keys) {
      await copyObject(s3, { bucket: oldBucket, key }, { bucket: newBucket, key });
      if (!(await objectExists(s3, newBucket, key))) {
        throw new Error(
          `s3://${newBucket}/${key} did not confirm as landed after copying — aborting before ` +
            `the old bucket is deleted. ${copiedKeys.length} object(s) confirmed so far.`,
        );
      }
      copiedKeys.push(key);
    }
    ctx.log.success(`Confirmed all ${copiedKeys.length} object(s) present in s3://${newBucket}`);

    return { migratedKeysJson: JSON.stringify(copiedKeys) };
  },

  /**
   * Deletes only the keys copied into the new bucket by THIS run — never
   * pre-existing objects there, and never the new bucket itself (its own
   * step owns that rollback). The old bucket is never touched here since
   * this step never mutates it.
   */
  async rollback(ctx) {
    const keysJson = ctx.outputs.migratedKeysJson as string | undefined;
    if (!keysJson) return;
    const keys = JSON.parse(keysJson) as string[];
    if (!keys.length) return;

    await deleteKeys(awsClients(ctx).s3, ctx.params.NEW_S3_BUCKET_NAME, keys);
  },

  resource(ctx) {
    const keysJson = ctx.outputs.migratedKeysJson as string | undefined;
    const objectCount = keysJson ? (JSON.parse(keysJson) as string[]).length : 0;
    return {
      type: "aws_s3_bucket_migration",
      name: ctx.params.OLD_S3_BUCKET_NAME,
      attributes: {
        oldBucket: ctx.params.OLD_S3_BUCKET_NAME,
        newBucket: ctx.params.NEW_S3_BUCKET_NAME,
        objectCount: String(objectCount),
      },
    };
  },
};
