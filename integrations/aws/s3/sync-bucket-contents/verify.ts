import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

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
 * Re-runs the same diff reconcile() used, and confirms it's now empty — a
 * real "prove it worked" check, not just trusting individual copy calls.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const source = ctx.params.SOURCE_S3_BUCKET_NAME;
  const destination = ctx.params.DESTINATION_S3_BUCKET_NAME;
  const prefix = ctx.params.KEY_PREFIX_FILTER;

  const [sourceSizes, destSizes] = await Promise.all([
    listWithSize(s3, source, prefix),
    listWithSize(s3, destination, prefix),
  ]);

  const stillMissing = [...sourceSizes.entries()].filter(([key, size]) => destSizes.get(key) !== size);
  if (stillMissing.length) {
    throw new Error(
      `${stillMissing.length} of ${sourceSizes.size} object(s) are still not in sync at s3://${destination}`,
    );
  }
  ctx.log.success(`Confirmed all ${sourceSizes.size} object(s) are in sync at s3://${destination}`);
}
