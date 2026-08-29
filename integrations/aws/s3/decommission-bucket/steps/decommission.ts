import { DeleteBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Step, StepContext } from "../../../../../src/core/define";
import {
  awsClients,
  copyObject,
  deleteKeys,
  ensureBucketState,
  listKeys,
  objectExists,
} from "../../../../../src/providers/aws";
import type { Params } from "../params";

interface BodyWithBytes {
  transformToByteArray?: () => Promise<Uint8Array>;
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  const stream = body as BodyWithBytes;
  if (typeof stream?.transformToByteArray === "function") return stream.transformToByteArray();
  return new Uint8Array();
}

function localPathFor(downloadDir: string, key: string, preserveStructure: boolean): string {
  return path.join(downloadDir, preserveStructure ? key : key.replace(/\//g, "_"));
}

/** Write every object to disk, confirming each landed by byte size. */
async function drainByDownload(ctx: StepContext<Params>, keys: string[]) {
  const { s3 } = awsClients(ctx);
  const source = ctx.params.SOURCE_S3_BUCKET_NAME;
  const downloadDir = ctx.params.DOWNLOAD_DIR!;
  const preserveStructure = ctx.params.PRESERVE_KEY_PREFIX_STRUCTURE;

  await mkdir(downloadDir, { recursive: true });
  ctx.log.info(`Downloading ${keys.length} object(s) from s3://${source} to ${downloadDir}`);

  const downloaded: { key: string; size: number }[] = [];
  for (const key of keys) {
    const got = await s3.send(new GetObjectCommand({ Bucket: source, Key: key }));
    const bytes = await bodyToBytes(got.Body);
    const localPath = localPathFor(downloadDir, key, preserveStructure);

    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, bytes);

    const info = await stat(localPath);
    const expected = got.ContentLength ?? bytes.length;
    if (info.size !== expected) {
      throw new Error(
        `Downloaded ${localPath} is ${info.size} bytes, expected ${expected} — aborting before ` +
          `touching the source bucket. ${downloaded.length} object(s) downloaded so far.`,
      );
    }
    downloaded.push({ key, size: info.size });
  }
  ctx.log.success(`Confirmed all ${downloaded.length} object(s) downloaded to ${downloadDir}`);
  return { downloadedManifestJson: JSON.stringify(downloaded) };
}

/** Copy every object into the destination, confirming each landed. */
async function drainByTransfer(ctx: StepContext<Params>, keys: string[]) {
  const { s3 } = awsClients(ctx);
  const source = ctx.params.SOURCE_S3_BUCKET_NAME;
  const destination = ctx.params.DESTINATION_S3_BUCKET_NAME!;

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
  return { transferredKeysJson: JSON.stringify(copiedKeys) };
}

/**
 * One step, not N — draining N objects doesn't fit the "N independently
 * identified resources" shape a step factory targets; this is one aggregate
 * action whose `resource()` describes the decommission as a whole.
 *
 * Delete-shaped check(): the source already being gone means the target state
 * is achieved, so check() reads that as "exists" — an idempotent no-op on
 * re-run.
 *
 * **The phase ordering is a hard invariant, not best-effort.** Every object is
 * drained AND confirmed before the source bucket or any of its objects are
 * touched. Never delete source objects until that full confirmation — that is
 * what makes the deletion safe to run unconditionally once reached, and it is
 * the single most important property of this step.
 */
export const decommissionStep: Step<Params> = {
  id: "decommission-bucket",
  title: "Drain the bucket's contents, then delete it",

  async check(ctx) {
    const { s3 } = awsClients(ctx);
    const state = await ensureBucketState(s3, ctx.params.SOURCE_S3_BUCKET_NAME, ctx.accountId);
    if (state === "conflict") return "conflict";
    if (state === "missing") return "exists"; // already decommissioned — nothing to do

    // DRAIN_MODE=none is a guard, not a drain: refuse rather than destroy data
    // the caller did not ask to preserve.
    if (ctx.params.DRAIN_MODE === "none") {
      const keys = await listKeys(s3, ctx.params.SOURCE_S3_BUCKET_NAME);
      if (keys.length > 0) {
        ctx.log.warn(
          `s3://${ctx.params.SOURCE_S3_BUCKET_NAME} holds ${keys.length} object(s) and ` +
            `DRAIN_MODE=none. Set DRAIN_MODE=download or =transfer to preserve them first.`,
        );
        return "conflict";
      }
    }
    return "missing";
  },

  async create(ctx) {
    const { s3 } = awsClients(ctx);
    const source = ctx.params.SOURCE_S3_BUCKET_NAME;
    const keys = await listKeys(s3, source);

    let outputs: Record<string, string> = {};
    if (ctx.params.DRAIN_MODE === "download") outputs = await drainByDownload(ctx, keys);
    if (ctx.params.DRAIN_MODE === "transfer") outputs = await drainByTransfer(ctx, keys);

    // Only now, with every object confirmed preserved (or the bucket proven
    // empty at plan time), is it safe to touch the source.
    if (keys.length > 0) await deleteKeys(s3, source, keys);
    await s3.send(new DeleteBucketCommand({ Bucket: source }));
    ctx.log.success(`Deleted s3://${source}`);

    return outputs;
  },

  /**
   * Undoes only what this run put somewhere else — local files it wrote, or
   * keys it copied into the destination. Never pre-existing destination
   * objects, never the destination bucket (this integration does not own it),
   * and never the source: by the time create() can fail partway, the source
   * deletion has not run yet, because it is gated behind full confirmation.
   */
  async rollback(ctx) {
    if (ctx.params.DRAIN_MODE === "download") {
      const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
      if (!manifestJson) return;
      const manifest = JSON.parse(manifestJson) as { key: string }[];
      for (const { key } of manifest) {
        await rm(localPathFor(ctx.params.DOWNLOAD_DIR!, key, ctx.params.PRESERVE_KEY_PREFIX_STRUCTURE), {
          force: true,
        }).catch(() => {});
      }
      return;
    }

    if (ctx.params.DRAIN_MODE === "transfer") {
      const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
      if (!keysJson) return;
      const keys = JSON.parse(keysJson) as string[];
      if (!keys.length) return;
      await deleteKeys(awsClients(ctx).s3, ctx.params.DESTINATION_S3_BUCKET_NAME!, keys);
    }
  },

  resource(ctx) {
    const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
    const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
    const objectCount = manifestJson
      ? (JSON.parse(manifestJson) as unknown[]).length
      : keysJson
        ? (JSON.parse(keysJson) as string[]).length
        : 0;

    return {
      type: "aws_s3_bucket_decommission",
      name: ctx.params.SOURCE_S3_BUCKET_NAME,
      attributes: {
        sourceBucket: ctx.params.SOURCE_S3_BUCKET_NAME,
        drainMode: ctx.params.DRAIN_MODE,
        destinationBucket: ctx.params.DESTINATION_S3_BUCKET_NAME ?? "",
        downloadDir: ctx.params.DOWNLOAD_DIR ?? "",
        objectCount: String(objectCount),
      },
    };
  },
};
