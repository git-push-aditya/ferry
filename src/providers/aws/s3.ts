import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteBucketEncryptionCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeletePublicAccessBlockCommand,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  UploadPartCopyCommand,
  type PublicAccessBlockConfiguration,
  type S3Client,
  type ServerSideEncryptionConfiguration,
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

export interface S3Location {
  bucket: string;
  key: string;
}

/** CopyObject's hard ceiling per the S3 API — above this, only UploadPartCopy works. */
const COPY_SINGLE_SHOT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
/** Part size used when an object is too large for a single CopyObject call. */
const MULTIPART_COPY_PART_SIZE_BYTES = 500 * 1024 * 1024;

/**
 * Copies one object, branching at the verified 5 GiB CopyObject ceiling:
 * below it, a single CopyObjectCommand; at or above it, a multipart
 * create/UploadPartCopy/complete sequence. Callers that already know the size
 * (e.g. from a prior listing) may skip the HeadObject by passing it directly.
 *
 * On any failure during the multipart path, the in-progress upload is
 * aborted so it doesn't linger as an incomplete-upload storage cost — the
 * caller's own step rollback is what undoes anything already completed.
 */
export async function copyObject(
  s3: S3Client,
  source: S3Location,
  dest: S3Location,
  knownSizeBytes?: number,
): Promise<void> {
  const size =
    knownSizeBytes ??
    (await s3.send(new HeadObjectCommand({ Bucket: source.bucket, Key: source.key })))
      .ContentLength ??
    0;

  const copySource = `${source.bucket}/${encodeURIComponent(source.key)}`;

  if (size < COPY_SINGLE_SHOT_LIMIT_BYTES) {
    await s3.send(
      new CopyObjectCommand({ Bucket: dest.bucket, Key: dest.key, CopySource: copySource }),
    );
    return;
  }

  const created = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: dest.bucket, Key: dest.key }),
  );
  const uploadId = created.UploadId;
  if (!uploadId) {
    throw new Error(
      `CreateMultipartUpload for s3://${dest.bucket}/${dest.key} did not return an UploadId`,
    );
  }

  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    let partNumber = 1;
    for (let start = 0; start < size; start += MULTIPART_COPY_PART_SIZE_BYTES) {
      const end = Math.min(start + MULTIPART_COPY_PART_SIZE_BYTES, size) - 1;
      const part = await s3.send(
        new UploadPartCopyCommand({
          Bucket: dest.bucket,
          Key: dest.key,
          UploadId: uploadId,
          PartNumber: partNumber,
          CopySource: copySource,
          CopySourceRange: `bytes=${start}-${end}`,
        }),
      );
      const etag = part.CopyPartResult?.ETag;
      if (!etag) {
        throw new Error(
          `UploadPartCopy part ${partNumber} of s3://${dest.bucket}/${dest.key} did not return an ETag`,
        );
      }
      parts.push({ ETag: etag, PartNumber: partNumber });
      partNumber += 1;
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: dest.bucket,
        Key: dest.key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: dest.bucket, Key: dest.key, UploadId: uploadId }))
      .catch(() => {});
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
/**
 * A precondition step for integrations that operate on a bucket they do not
 * create — deleting, tagging, or reconciling a setting on it. "Missing" is
 * folded into "conflict" here rather than left as "missing", because this
 * step declares no create(): without this, a missing bucket would silently
 * plan a "skip" and the real failure would only surface as a raw
 * NoSuchBucket error partway through apply, instead of aborting cleanly in
 * the plan phase like every other conflict does.
 */
export function s3BucketExistsGuardStep<P>(opts: BucketStepOptions<P>): Step<P> {
  const name = (ctx: StepContext<P>) => opts.bucket(ctx.params);

  return {
    id: opts.id ?? "s3-bucket-exists",
    title: opts.title ?? "Confirm the bucket already exists",

    async check(ctx) {
      const state = await ensureBucketState(awsClients(ctx).s3, name(ctx), ctx.accountId);
      if (state === "missing") {
        warn(
          `s3://${name(ctx)} does not exist. This integration operates on an existing bucket ` +
            `and does not create one — run aws/s3/create-bucket first if you need it provisioned.`,
        );
        return "conflict";
      }
      return state;
    },

    async rollback() {
      // A read-only precondition changes nothing, so there is nothing to undo.
    },
  };
}

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

export interface BucketSettingStepOptions<P> {
  /** Reads the bucket name out of the integration's own params. */
  bucket(params: P): string;
}

/**
 * Once versioning has ever been touched, GetBucketVersioning has no third
 * state — only Enabled/Suspended, never "never configured" again. So
 * `desired(params)` returning undefined means "leave whatever the bucket
 * already has alone" (used by `create-bucket`'s opt-in toggle), while
 * "Enabled"/"Suspended" means converge to that value explicitly (used by a
 * dedicated update-bucket-versioning integration that wants Suspended too,
 * not just Enabled).
 *
 * The desired state depends on params, which aren't knowable as a static
 * "missing"/"exists" at plan time — so, like the Snowflake integration's
 * `trust-policy.ts`, this step declares no create() and always reconciles;
 * reconcile() is itself the idempotent check.
 */
export function s3VersioningStep<P>(
  opts: BucketSettingStepOptions<P> & {
    desired(params: P): "Enabled" | "Suspended" | undefined;
  },
): Step<P> {
  return {
    id: "bucket-versioning",
    title: "Reconcile bucket versioning",

    async check() {
      return "missing";
    },

    async reconcile(ctx) {
      const { s3 } = awsClients(ctx);
      const bucket = opts.bucket(ctx.params);
      const desired = opts.desired(ctx.params);

      if (desired === undefined) {
        ctx.log.info("Versioning not requested — leaving bucket versioning untouched");
        return {};
      }

      const before = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      const priorStatus = before.Status ?? ""; // "" means never configured

      if (priorStatus === desired) {
        ctx.log.info(`s3://${bucket} versioning already ${desired}`);
        return { priorVersioningStatus: priorStatus };
      }

      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: desired },
        }),
      );
      ctx.log.success(`Set versioning to ${desired} on s3://${bucket}`);
      return { priorVersioningStatus: priorStatus };
    },

    /**
     * "" (never configured) has no real inverse — S3 offers no un-configure
     * call — so the closest achievable restoration is Suspended, with a loud
     * warning that it is not an exact restore. Enabled/Suspended restore
     * exactly (an idempotent re-Put of the same value if reconcile found it
     * already matched, harmless the same way `storage-integration.ts`'s
     * ALTER re-application is).
     */
    async rollback(ctx) {
      const prior = ctx.outputs.priorVersioningStatus as string | undefined;
      if (prior === undefined) return;

      const bucket = opts.bucket(ctx.params);
      await awsClients(ctx).s3.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: {
            Status: prior === "" ? "Suspended" : (prior as "Enabled" | "Suspended"),
          },
        }),
      );
      if (prior === "") {
        ctx.log.warn(
          `s3://${bucket} versioning cannot be restored to "never configured" (S3 has no such call) — suspended instead`,
        );
      }
    },

    resource(ctx) {
      const desired = opts.desired(ctx.params);
      return {
        type: "aws_s3_bucket_versioning",
        name: opts.bucket(ctx.params),
        attributes: { status: desired ?? "not managed by ferry" },
      };
    },
  };
}

/**
 * ENABLE_ENCRYPTION is opt-in. AWS applies default SSE-S3 to every new bucket
 * even with no explicit configuration, so "off" here means "don't set an
 * explicit configuration", not "unencrypted" — and unlike versioning, this one
 * is fully reversible: DeleteBucketEncryption cleanly returns a bucket to
 * that baseline.
 *
 * Always reconciles (no create()), same reasoning as `s3VersioningStep`.
 */
export function s3EncryptionStep<P>(
  opts: BucketSettingStepOptions<P> & {
    enabled(params: P): boolean;
    algorithm(params: P): "AES256" | "aws:kms";
    kmsKeyId(params: P): string | undefined;
  },
): Step<P> {
  const desiredConfig = (params: P): ServerSideEncryptionConfiguration => {
    const algorithm = opts.algorithm(params);
    return {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: algorithm,
            ...(algorithm === "aws:kms" ? { KMSMasterKeyID: opts.kmsKeyId(params) } : {}),
          },
        },
      ],
    };
  };

  return {
    id: "bucket-encryption",
    title: "Reconcile bucket default encryption",

    async check() {
      return "missing";
    },

    async reconcile(ctx) {
      const { s3 } = awsClients(ctx);
      const bucket = opts.bucket(ctx.params);

      if (!opts.enabled(ctx.params)) {
        ctx.log.info("Encryption not requested — leaving AWS's default encryption baseline in place");
        return {};
      }

      let priorConfig: ServerSideEncryptionConfiguration | undefined;
      try {
        const before = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
        priorConfig = before.ServerSideEncryptionConfiguration;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }

      await s3.send(
        new PutBucketEncryptionCommand({
          Bucket: bucket,
          ServerSideEncryptionConfiguration: desiredConfig(ctx.params),
        }),
      );
      ctx.log.success(`Set default encryption (${opts.algorithm(ctx.params)}) on s3://${bucket}`);

      return {
        hadExplicitEncryptionConfig: priorConfig !== undefined,
        priorEncryptionConfig: priorConfig ? JSON.stringify(priorConfig) : "",
      };
    },

    async rollback(ctx) {
      if (ctx.outputs.hadExplicitEncryptionConfig === undefined) return; // disabled this run

      const { s3 } = awsClients(ctx);
      const bucket = opts.bucket(ctx.params);

      if (ctx.outputs.hadExplicitEncryptionConfig === false) {
        await s3.send(new DeleteBucketEncryptionCommand({ Bucket: bucket }));
        return;
      }

      await s3.send(
        new PutBucketEncryptionCommand({
          Bucket: bucket,
          ServerSideEncryptionConfiguration: JSON.parse(
            ctx.outputs.priorEncryptionConfig as string,
          ),
        }),
      );
    },

    resource(ctx) {
      return {
        type: "aws_s3_bucket_server_side_encryption_configuration",
        name: opts.bucket(ctx.params),
        attributes: {
          algorithm: opts.enabled(ctx.params) ? opts.algorithm(ctx.params) : "not managed by ferry",
        },
      };
    },
  };
}

/**
 * Unlike versioning/encryption, blocking public access is not opt-in — it
 * defaults to true (via the caller's own params default) and is always
 * reconciled, because a freshly provisioned bucket should not be publicly
 * reachable by accident. A caller that genuinely wants a public bucket sets
 * its own param to false explicitly.
 *
 * Always reconciles (no create()), same reasoning as `s3VersioningStep`.
 */
export function s3PublicAccessBlockStep<P>(
  opts: BucketSettingStepOptions<P> & { blocked(params: P): boolean },
): Step<P> {
  const desiredConfig = (params: P): PublicAccessBlockConfiguration => {
    const blocked = opts.blocked(params);
    return {
      BlockPublicAcls: blocked,
      IgnorePublicAcls: blocked,
      BlockPublicPolicy: blocked,
      RestrictPublicBuckets: blocked,
    };
  };

  return {
    id: "bucket-public-access-block",
    title: "Reconcile bucket public access block",

    async check() {
      return "missing";
    },

    async reconcile(ctx) {
      const { s3 } = awsClients(ctx);
      const bucket = opts.bucket(ctx.params);

      let priorConfig: PublicAccessBlockConfiguration | undefined;
      try {
        const before = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
        priorConfig = before.PublicAccessBlockConfiguration;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }

      await s3.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: desiredConfig(ctx.params),
        }),
      );
      ctx.log.success(
        `Public access ${opts.blocked(ctx.params) ? "blocked" : "permitted"} on s3://${bucket}`,
      );

      return {
        hadExplicitPublicAccessBlock: priorConfig !== undefined,
        priorPublicAccessBlock: priorConfig ? JSON.stringify(priorConfig) : "",
      };
    },

    async rollback(ctx) {
      const { s3 } = awsClients(ctx);
      const bucket = opts.bucket(ctx.params);

      if (ctx.outputs.hadExplicitPublicAccessBlock === false) {
        await s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket }));
        return;
      }

      await s3.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: JSON.parse(ctx.outputs.priorPublicAccessBlock as string),
        }),
      );
    },

    resource(ctx) {
      return {
        type: "aws_s3_bucket_public_access_block",
        name: opts.bucket(ctx.params),
        attributes: { blocked: String(opts.blocked(ctx.params)) },
      };
    },
  };
}

/**
 * `policy(params)` returning undefined means "leave whatever policy the
 * bucket already has alone" — the same "opt-in, don't force a state" shape as
 * `s3VersioningStep`. GetBucketPolicy 404s with no policy set at all, which
 * is "missing", not an error.
 *
 * PutBucketPolicy is a whole-document replace — there is no "add one
 * statement" — so the prior document is captured in full for rollback,
 * exactly the same shape as `s3EncryptionStep`.
 */
export function s3BucketPolicyStep<P>(
  opts: BucketSettingStepOptions<P> & {
    policy(params: P): Record<string, unknown> | undefined;
  },
): Step<P> {
  return {
    id: "bucket-policy",
    title: "Reconcile bucket policy",

    async check() {
      return "missing";
    },

    async reconcile(ctx) {
      const bucket = opts.bucket(ctx.params);
      const desired = opts.policy(ctx.params);

      if (desired === undefined) {
        ctx.log.info("No policy requested — leaving the bucket's policy untouched");
        return {};
      }

      const { s3 } = awsClients(ctx);
      let priorPolicy: string | undefined;
      try {
        const before = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        priorPolicy = before.Policy;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }

      await s3.send(
        new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(desired) }),
      );
      ctx.log.success(`Set bucket policy on s3://${bucket}`);

      return {
        hadExplicitBucketPolicy: priorPolicy !== undefined,
        priorBucketPolicy: priorPolicy ?? "",
      };
    },

    async rollback(ctx) {
      if (ctx.outputs.hadExplicitBucketPolicy === undefined) return; // disabled this run

      const { s3 } = awsClients(ctx);
      const bucket = opts.bucket(ctx.params);

      if (ctx.outputs.hadExplicitBucketPolicy === false) {
        await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
        return;
      }

      await s3.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: ctx.outputs.priorBucketPolicy as string,
        }),
      );
    },

    resource(ctx) {
      return {
        type: "aws_s3_bucket_policy",
        name: opts.bucket(ctx.params),
        attributes: { hasPolicy: String(opts.policy(ctx.params) !== undefined) },
      };
    },
  };
}
