import { DeleteBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Step } from "../../../../../src/core/define";
import { awsClients, deleteKeys, ensureBucketState, listKeys } from "../../../../../src/providers/aws";
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

/**
 * One step, not N — same reasoning as `delete-bucket-with-transfer`'s
 * `transferStep`: this is one aggregate download-then-delete action, not N
 * independent resources.
 *
 * Same delete-shaped check() as its sibling: the source already being gone
 * means the target state is achieved, so check() reads that as "exists" — an
 * idempotent no-op on re-run.
 *
 * Same hard ordering gate: every object is downloaded AND confirmed on disk
 * (by byte size) before the source bucket or any of its objects are touched.
 */
export const downloadStep: Step<Params> = {
  id: "download-and-delete-source",
  title: "Download every object to disk, then delete the source bucket",

  async check(ctx) {
    const { s3 } = awsClients(ctx);
    const state = await ensureBucketState(s3, ctx.params.SOURCE_S3_BUCKET_NAME, ctx.accountId);
    if (state === "conflict") return "conflict";
    if (state === "missing") return "exists"; // already downloaded + deleted — nothing to do
    return "missing";
  },

  async create(ctx) {
    const { s3 } = awsClients(ctx);
    const source = ctx.params.SOURCE_S3_BUCKET_NAME;
    const downloadDir = ctx.params.DOWNLOAD_DIR;
    const preserveStructure = ctx.params.PRESERVE_KEY_PREFIX_STRUCTURE;

    await mkdir(downloadDir, { recursive: true });

    const keys = await listKeys(s3, source);
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

    // Only now, with every object confirmed on disk, is it safe to touch the source.
    await deleteKeys(s3, source, keys);
    await s3.send(new DeleteBucketCommand({ Bucket: source }));
    ctx.log.success(`Deleted s3://${source}`);

    return { downloadedManifestJson: JSON.stringify(downloaded) };
  },

  /** Deletes only the local files THIS RUN created — never touches AWS. */
  async rollback(ctx) {
    const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
    if (!manifestJson) return;

    const manifest = JSON.parse(manifestJson) as { key: string }[];
    const downloadDir = ctx.params.DOWNLOAD_DIR;
    const preserveStructure = ctx.params.PRESERVE_KEY_PREFIX_STRUCTURE;

    for (const { key } of manifest) {
      await rm(localPathFor(downloadDir, key, preserveStructure), { force: true }).catch(() => {});
    }
  },

  resource(ctx) {
    const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
    const objectCount = manifestJson ? (JSON.parse(manifestJson) as unknown[]).length : 0;
    return {
      type: "aws_s3_bucket_download",
      name: ctx.params.SOURCE_S3_BUCKET_NAME,
      attributes: {
        sourceBucket: ctx.params.SOURCE_S3_BUCKET_NAME,
        downloadDir: ctx.params.DOWNLOAD_DIR,
        objectCount: String(objectCount),
      },
    };
  },
};
