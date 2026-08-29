import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound, listKeys } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Two things to prove, in this order: the contents really were preserved
 * wherever they were sent, and the source really is gone. Checking
 * preservation first matters -- if the drain silently lost data, saying so is
 * more useful than reporting the deletion succeeded.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const source = ctx.params.SOURCE_S3_BUCKET_NAME;

  if (ctx.params.DRAIN_MODE === "transfer") {
    const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
    if (keysJson) {
      const destination = ctx.params.DESTINATION_S3_BUCKET_NAME!;
      const transferred = JSON.parse(keysJson) as string[];
      const destKeys = new Set(await listKeys(s3, destination));
      const missing = transferred.filter((k) => !destKeys.has(k));
      if (missing.length) {
        throw new Error(
          `${missing.length} of ${transferred.length} transferred object(s) are missing from ` +
            `s3://${destination}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
        );
      }
      ctx.log.success(
        `Confirmed all ${transferred.length} transferred object(s) are present in s3://${destination}`,
      );
    }
  }

  if (ctx.params.DRAIN_MODE === "download") {
    const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
    if (manifestJson) {
      const manifest = JSON.parse(manifestJson) as { key: string; size: number }[];
      const downloadDir = ctx.params.DOWNLOAD_DIR!;
      const preserve = ctx.params.PRESERVE_KEY_PREFIX_STRUCTURE;
      for (const { key, size } of manifest) {
        const localPath = path.join(downloadDir, preserve ? key : key.replace(/\//g, "_"));
        const info = await stat(localPath).catch(() => undefined);
        if (!info) throw new Error(`Downloaded file ${localPath} is missing after apply`);
        if (info.size !== size) {
          throw new Error(`Downloaded file ${localPath} is ${info.size} bytes, expected ${size}`);
        }
      }
      ctx.log.success(`Confirmed all ${manifest.length} downloaded file(s) are present in ${downloadDir}`);
    }
  }

  let sourceStillExists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: source, ExpectedBucketOwner: ctx.accountId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    sourceStillExists = false;
  }
  if (sourceStillExists) throw new Error(`s3://${source} still exists after the decommission step`);
  ctx.log.success(`Confirmed s3://${source} no longer exists`);
}
