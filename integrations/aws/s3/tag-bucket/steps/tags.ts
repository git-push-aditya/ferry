import {
  DeleteBucketTaggingCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  type Tag,
} from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import { awsClients, isNotFound } from "../../../../../src/providers/aws";
import { parsedTags, type Params } from "../params";

/**
 * PutBucketTagging is a whole-set replace — AWS's own docs say plainly "you
 * cannot use this operation to add tags to an existing list" — so the prior
 * set is captured in full for rollback, same shape as `s3EncryptionStep`.
 *
 * Always reconciles (no create()): the desired set depends on params, not
 * knowable as a plan-time missing/exists split.
 */
export const tagsStep: Step<Params> = {
  id: "bucket-tags",
  title: "Reconcile bucket tags",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const bucket = ctx.params.S3_BUCKET_NAME;
    const desired = parsedTags(ctx.params);

    if (desired === undefined) {
      ctx.log.info("TAGS_JSON not set — leaving the bucket's tags untouched");
      return {};
    }

    const { s3 } = awsClients(ctx);
    let priorTagSet: Tag[] | undefined;
    try {
      const before = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      priorTagSet = before.TagSet;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    const tagSet = Object.entries(desired).map(([Key, Value]) => ({ Key, Value }));
    if (tagSet.length === 0) {
      await s3.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
      ctx.log.success(`Cleared all tags on s3://${bucket}`);
    } else {
      await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tagSet } }));
      ctx.log.success(`Set ${tagSet.length} tag(s) on s3://${bucket}`);
    }

    return {
      hadPriorTags: priorTagSet !== undefined,
      priorTagSetJson: priorTagSet ? JSON.stringify(priorTagSet) : "",
    };
  },

  async rollback(ctx) {
    if (ctx.outputs.hadPriorTags === undefined) return; // untouched this run

    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;

    if (ctx.outputs.hadPriorTags === false) {
      await s3.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
      return;
    }

    await s3.send(
      new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: { TagSet: JSON.parse(ctx.outputs.priorTagSetJson as string) },
      }),
    );
  },

  resource(ctx) {
    const desired = parsedTags(ctx.params);
    return {
      type: "aws_s3_bucket_tagging",
      name: ctx.params.S3_BUCKET_NAME,
      attributes: { tagCount: String(desired ? Object.keys(desired).length : 0) },
    };
  },
};
