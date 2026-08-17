import { GetBucketTaggingCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound } from "../../../../src/providers/aws";
import { parsedTags, type Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const desired = parsedTags(ctx.params);
  if (desired === undefined) {
    ctx.log.warn("TAGS_JSON not set this run — nothing to verify");
    return;
  }

  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;

  let actual: Record<string, string> = {};
  try {
    const got = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
    for (const tag of got.TagSet ?? []) {
      if (tag.Key) actual[tag.Key] = tag.Value ?? "";
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
    actual = {};
  }

  const sortedEntries = (o: Record<string, string>) =>
    Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(sortedEntries(actual)) !== JSON.stringify(sortedEntries(desired))) {
    throw new Error(`s3://${bucket} tags do not match the desired set`);
  }
  ctx.log.success(`Confirmed ${Object.keys(desired).length} tag(s) match the desired set`);
}
