import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import { awsClients, copyObject, deleteKeys, objectExists } from "../../../../../src/providers/aws";
import type { Params } from "../params";

/** key -> size, via ListObjectsV2's own Size field — no separate HeadObject needed per key. */
async function listWithSize(
  s3: ReturnType<typeof awsClients>["s3"],
  bucket: string,
  prefix: string,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key) sizes.set(object.Key, object.Size ?? 0);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return sizes;
}

/**
 * Repeatable and non-destructive, unlike its `delete-bucket-with-transfer`
 * sibling: the source is never touched, and the destination bucket is never
 * deleted. Diffing by key + size (not ETag, which isn't a reliable content
 * hash for multipart-uploaded objects) is deliberately coarse — when in
 * doubt this re-copies, which is cheap and idempotent, rather than risking a
 * false "already synced".
 *
 * Never deletes anything from either side — a "mirror + delete extras"
 * variant would be a different, explicitly opt-in task given its different
 * risk profile.
 *
 * Always reconciles (no create()): meant to be re-run repeatedly, and the
 * diff naturally shrinks to empty as it catches up — that convergence to a
 * no-op on repeated runs is the whole point.
 */
export const syncStep: Step<Params> = {
  id: "sync-objects",
  title: "Sync every object from the source to the destination",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { s3 } = awsClients(ctx);
    const source = ctx.params.SOURCE_S3_BUCKET_NAME;
    const destination = ctx.params.DESTINATION_S3_BUCKET_NAME;
    const prefix = ctx.params.KEY_PREFIX_FILTER;

    const [sourceSizes, destSizes] = await Promise.all([
      listWithSize(s3, source, prefix),
      listWithSize(s3, destination, prefix),
    ]);

    const toSync = [...sourceSizes.entries()].filter(
      ([key, size]) => destSizes.get(key) !== size,
    );
    ctx.log.info(
      `${toSync.length} of ${sourceSizes.size} object(s) need syncing from s3://${source} to s3://${destination}`,
    );

    const syncedKeys: string[] = [];
    for (const [key, size] of toSync) {
      await copyObject(s3, { bucket: source, key }, { bucket: destination, key }, size);
      if (!(await objectExists(s3, destination, key))) {
        throw new Error(`s3://${destination}/${key} did not confirm as landed after copying`);
      }
      syncedKeys.push(key);
    }
    ctx.log.success(`Synced ${syncedKeys.length} object(s) to s3://${destination}`);

    return { syncedKeysJson: JSON.stringify(syncedKeys) };
  },

  /** Deletes only the keys THIS RUN copied — never pre-existing destination objects. */
  async rollback(ctx) {
    const keysJson = ctx.outputs.syncedKeysJson as string | undefined;
    if (!keysJson) return;
    const keys = JSON.parse(keysJson) as string[];
    if (!keys.length) return;

    await deleteKeys(awsClients(ctx).s3, ctx.params.DESTINATION_S3_BUCKET_NAME, keys);
  },

  resource(ctx) {
    const keysJson = ctx.outputs.syncedKeysJson as string | undefined;
    const objectsSynced = keysJson ? (JSON.parse(keysJson) as string[]).length : 0;
    return {
      type: "aws_s3_bucket_sync",
      name: ctx.params.SOURCE_S3_BUCKET_NAME,
      attributes: {
        sourceBucket: ctx.params.SOURCE_S3_BUCKET_NAME,
        destinationBucket: ctx.params.DESTINATION_S3_BUCKET_NAME,
        objectsSynced: String(objectsSynced),
      },
    };
  },
};
