import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { Step, StepContext, StepState } from "../../core/define";
import { warn } from "../../core/logger";
import { awsClients } from "./clients";

export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

function isForbidden(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "Forbidden" || e?.$metadata?.httpStatusCode === 403;
}

/**
 * Three-way, because S3 bucket names are globally unique across every AWS
 * account. A name that is taken by somebody else does not 404 — it 403s, and
 * calling CreateBucket on it would fail *after* the plan phase had already
 * promised the run could proceed.
 *
 *   404 / NotFound            → "missing"   create it, register rollback
 *   200 (owner == accountId)  → "exists"    reuse it, register NO rollback
 *   403 / Forbidden           → "conflict"  abort before mutating anything
 *
 * `ExpectedBucketOwner` is what turns "I can see this bucket" into "I own this
 * bucket": without it, a HeadBucket that happens to be readable would read as
 * ours. Never attempt a create on 403.
 */
export async function ensureBucketState(
  s3: S3Client,
  bucket: string,
  accountId: string,
): Promise<StepState> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: accountId }));
    return "exists";
  } catch (err) {
    if (isNotFound(err)) return "missing";
    if (isForbidden(err)) {
      warn(
        `s3://${bucket} returned 403. Either the name is taken by a different AWS account ` +
          `(bucket names are globally unique), or these bootstrap credentials lack ` +
          `s3:ListBucket / s3:GetBucketLocation on a bucket account ${accountId} does own. ` +
          `Not attempting to create it.`,
      );
      return "conflict";
    }
    throw err;
  }
}

export async function createBucket(s3: S3Client, bucket: string, region: string): Promise<void> {
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 is the API's default and rejects an explicit constraint.
        ...(region === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
  } catch (err) {
    // A race between the check and the create, on a bucket we do own.
    if ((err as { name?: string })?.name !== "BucketAlreadyOwnedByYou") throw err;
  }
}

export async function listKeys(s3: S3Client, bucket: string, prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of listed.Contents ?? []) if (object.Key) keys.push(object.Key);
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

export async function deleteKeys(s3: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
}

/** Only ever called for a bucket this run created, so emptying it is safe. */
export async function emptyAndDeleteBucket(s3: S3Client, bucket: string): Promise<void> {
  await deleteKeys(s3, bucket, await listKeys(s3, bucket));
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err) || (err as { name?: string })?.name === "NoSuchBucket") return false;
    throw err;
  }
}

export interface BucketStepOptions<P> {
  /** Reads the bucket name out of the integration's own params. */
  bucket(params: P): string;
  id?: string;
  title?: string;
}

/**
 * The bucket is shared ground: both integrations need it and neither owns it,
 * so the step lives here rather than in either folder. Reuse registers no
 * rollback — only the run that actually creates the bucket may delete it.
 */
export function s3BucketStep<P>(opts: BucketStepOptions<P>): Step<P> {
  const name = (ctx: StepContext<P>) => opts.bucket(ctx.params);

  return {
    id: opts.id ?? "s3-bucket",
    title: opts.title ?? "Ensure S3 bucket",

    async check(ctx) {
      return ensureBucketState(awsClients(ctx).s3, name(ctx), ctx.accountId);
    },

    async create(ctx) {
      const { s3, region } = awsClients(ctx);
      await createBucket(s3, name(ctx), region);
      ctx.log.info(`Created s3://${name(ctx)} in ${region}`);
      return { bucket: name(ctx), bucketCreatedThisRun: true };
    },

    async rollback(ctx) {
      await emptyAndDeleteBucket(awsClients(ctx).s3, name(ctx));
    },

    resource(ctx) {
      return {
        type: "aws_s3_bucket",
        name: name(ctx),
        attributes: { arn: `arn:aws:s3:::${name(ctx)}`, region: awsClients(ctx).region },
      };
    },

    handoff: {
      terraform: {
        type: "aws_s3_bucket",
        address: "aws_s3_bucket.export",
        importId: (ctx) => name(ctx),
      },
    },
  };
}

/**
 * S3 has no directories; the zero-byte key just makes the prefix visible in the
 * console and gives `COPY INTO` a landing area operators can find.
 */
export function s3PrefixMarkerStep<P>(opts: {
  bucket(params: P): string;
  prefix(params: P): string;
}): Step<P> {
  const bucketOf = (ctx: StepContext<P>) => opts.bucket(ctx.params);
  const keyOf = (ctx: StepContext<P>) => opts.prefix(ctx.params);

  return {
    id: "s3-prefix-marker",
    title: "Ensure S3 prefix marker",

    async check(ctx) {
      return (await objectExists(awsClients(ctx).s3, bucketOf(ctx), keyOf(ctx)))
        ? "exists"
        : "missing";
    },

    async create(ctx) {
      await awsClients(ctx).s3.send(
        new PutObjectCommand({ Bucket: bucketOf(ctx), Key: keyOf(ctx), Body: "" }),
      );
      ctx.log.info(`Prefix marker s3://${bucketOf(ctx)}/${keyOf(ctx)} present`);
      return { prefix: keyOf(ctx) };
    },

    async rollback(ctx) {
      await awsClients(ctx).s3.send(
        new DeleteObjectCommand({ Bucket: bucketOf(ctx), Key: keyOf(ctx) }),
      );
    },

    resource(ctx) {
      return {
        type: "aws_s3_object",
        name: keyOf(ctx),
        attributes: { uri: `s3://${bucketOf(ctx)}/${keyOf(ctx)}` },
      };
    },
  };
}
