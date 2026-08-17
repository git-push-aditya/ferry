import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound } from "../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const source = ctx.params.SOURCE_S3_BUCKET_NAME;

  const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
  if (manifestJson) {
    const manifest = JSON.parse(manifestJson) as { key: string; size: number }[];
    for (const { key, size } of manifest) {
      const localPath = path.join(
        ctx.params.DOWNLOAD_DIR,
        ctx.params.PRESERVE_KEY_PREFIX_STRUCTURE ? key : key.replace(/\//g, "_"),
      );
      let actualSize: number;
      try {
        actualSize = (await stat(localPath)).size;
      } catch {
        throw new Error(`${localPath} is missing on disk after the download step`);
      }
      if (actualSize !== size) {
        throw new Error(`${localPath} is ${actualSize} bytes on disk, expected ${size}`);
      }
    }
    ctx.log.success(`Confirmed all ${manifest.length} downloaded file(s) are present with the expected size`);
  }

  let sourceStillExists = true;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: source, ExpectedBucketOwner: ctx.accountId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    sourceStillExists = false;
  }
  if (sourceStillExists) throw new Error(`s3://${source} still exists after the download step`);
  ctx.log.success(`Confirmed s3://${source} no longer exists`);
}
