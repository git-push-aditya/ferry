import { describe, expect, test } from "bun:test";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteBucketEncryptionCommand,
  DeleteBucketPolicyCommand,
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
  PutPublicAccessBlockCommand,
  UploadPartCopyCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  copyObject,
  emptyAndDeleteBucket,
  ensureBucketState,
  s3BucketExistsGuardStep,
  s3BucketPolicyStep,
  s3BucketStep,
  s3EncryptionStep,
  s3PublicAccessBlockStep,
  s3VersioningStep,
} from "../../src/providers/aws/s3";
import type { StepContext } from "../../src/core/define";

const ACCOUNT = "909317186541";

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/** Minimal S3Client stand-in: records every command and replies from a queue. */
function fakeS3(handler: (sent: Sent) => unknown): { client: S3Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const record = { name: command.constructor.name, input: command.input };
      sent.push(record);
      const reply = handler(record);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return { client: client as unknown as S3Client, sent };
}

function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

describe("ensureBucketState — the three-way ownership branch", () => {
  test("HeadBucket succeeding for our account means 'exists' (reuse it)", async () => {
    const { client, sent } = fakeS3(() => ({}));

    expect(await ensureBucketState(client, "shared-bucket", ACCOUNT)).toBe("exists");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe(HeadBucketCommand.name);
  });

  test("ownership is asserted with ExpectedBucketOwner, not inferred from readability", async () => {
    const { client, sent } = fakeS3(() => ({}));

    await ensureBucketState(client, "shared-bucket", ACCOUNT);

    expect(sent[0]!.input.ExpectedBucketOwner).toBe(ACCOUNT);
  });

  test("a 404 by name means 'missing' (create it)", async () => {
    const { client } = fakeS3(() => awsError("NotFound", 404));
    expect(await ensureBucketState(client, "brand-new", ACCOUNT)).toBe("missing");
  });

  test("a 404 by status code means 'missing' even without a recognised name", async () => {
    const { client } = fakeS3(() => awsError("SomethingElse", 404));
    expect(await ensureBucketState(client, "brand-new", ACCOUNT)).toBe("missing");
  });

  test("a 403 means 'conflict' — bucket names are globally unique, so this is not a 404", async () => {
    const { client } = fakeS3(() => awsError("Forbidden", 403));
    expect(await ensureBucketState(client, "taken-elsewhere", ACCOUNT)).toBe("conflict");
  });

  test("a 403 by status code means 'conflict' too", async () => {
    const { client } = fakeS3(() => awsError("AccessDenied", 403));
    expect(await ensureBucketState(client, "taken-elsewhere", ACCOUNT)).toBe("conflict");
  });

  test("NEVER attempts a create on 403 — only HeadBucket is ever sent", async () => {
    const { client, sent } = fakeS3(() => awsError("Forbidden", 403));

    await ensureBucketState(client, "taken-elsewhere", ACCOUNT);

    expect(sent.map((s) => s.name)).toEqual([HeadBucketCommand.name]);
    expect(sent.some((s) => s.name === CreateBucketCommand.name)).toBe(false);
  });

  test("an unrelated error propagates instead of being read as missing or conflict", async () => {
    const { client } = fakeS3(() => awsError("Throttling", 429));
    await expect(ensureBucketState(client, "any", ACCOUNT)).rejects.toThrow("Throttling");
  });
});

describe("s3BucketStep", () => {
  function ctxFor(client: S3Client): StepContext<{ bucket: string }> {
    return {
      params: { bucket: "the-bucket" },
      creds: {},
      clients: { aws: { s3: client, iam: {}, sts: {}, region: "eu-west-1" } },
      accountId: ACCOUNT,
      outputs: {},
      dryRun: false,
      log: { info() {}, warn() {}, error() {}, success() {} },
    };
  }

  const step = s3BucketStep<{ bucket: string }>({ bucket: (p) => p.bucket });

  test("check() delegates to the three-way ownership probe", async () => {
    const { client } = fakeS3(() => awsError("Forbidden", 403));
    expect(await step.check(ctxFor(client))).toBe("conflict");
  });

  test("create() honours the region and reports the bucket in its outputs", async () => {
    const { client, sent } = fakeS3(() => ({}));

    const outputs = await step.create!(ctxFor(client));

    expect(sent[0]!.name).toBe(CreateBucketCommand.name);
    expect(sent[0]!.input.CreateBucketConfiguration).toEqual({ LocationConstraint: "eu-west-1" });
    expect(outputs).toEqual({ bucket: "the-bucket", bucketCreatedThisRun: true });
  });

  test("create() tolerates BucketAlreadyOwnedByYou — a race, not a failure", async () => {
    const { client } = fakeS3(() => awsError("BucketAlreadyOwnedByYou", 409));
    await expect(step.create!(ctxFor(client))).resolves.toBeDefined();
  });

  test("rollback() empties the bucket before deleting it", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === ListObjectsV2Command.name
        ? { Contents: [{ Key: "a" }, { Key: "b" }], IsTruncated: false }
        : {},
    );

    await step.rollback(ctxFor(client));

    expect(sent.map((s) => s.name)).toEqual([
      ListObjectsV2Command.name,
      DeleteObjectsCommand.name,
      DeleteBucketCommand.name,
    ]);
  });
});

describe("copyObject", () => {
  const SOURCE = { bucket: "src-bucket", key: "docs/report.pdf" };
  const DEST = { bucket: "dest-bucket", key: "docs/report.pdf" };
  const GIB = 1024 * 1024 * 1024;

  test("uses a single CopyObjectCommand for an object under the 5 GiB ceiling", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === HeadObjectCommand.name ? { ContentLength: 42 } : {},
    );

    await copyObject(client, SOURCE, DEST);

    expect(sent.map((s) => s.name)).toEqual([HeadObjectCommand.name, CopyObjectCommand.name]);
    expect(sent[1]!.input).toEqual({
      Bucket: DEST.bucket,
      Key: DEST.key,
      CopySource: `${SOURCE.bucket}/${encodeURIComponent(SOURCE.key)}`,
    });
  });

  test("skips the HeadObject when the caller already knows the size", async () => {
    const { client, sent } = fakeS3(() => ({}));

    await copyObject(client, SOURCE, DEST, 42);

    expect(sent.map((s) => s.name)).toEqual([CopyObjectCommand.name]);
  });

  test("switches to multipart create/UploadPartCopy/complete at or above the 5 GiB ceiling", async () => {
    const size = 6 * GIB;
    const { client, sent } = fakeS3((s) => {
      if (s.name === CreateMultipartUploadCommand.name) return { UploadId: "upload-1" };
      if (s.name === UploadPartCopyCommand.name) {
        return { CopyPartResult: { ETag: `etag-${s.input.PartNumber}` } };
      }
      return {};
    });

    await copyObject(client, SOURCE, DEST, size);

    const names = sent.map((s) => s.name);
    expect(names[0]).toBe(CreateMultipartUploadCommand.name);
    expect(names[names.length - 1]).toBe(CompleteMultipartUploadCommand.name);
    expect(names.filter((n) => n === UploadPartCopyCommand.name)).toHaveLength(
      Math.ceil(size / (500 * 1024 * 1024)),
    );

    const complete = sent[sent.length - 1]!;
    expect(complete.input.MultipartUpload).toEqual({
      Parts: (complete.input.MultipartUpload as { Parts: unknown[] }).Parts,
    });
    const parts = (complete.input.MultipartUpload as { Parts: { PartNumber: number }[] }).Parts;
    expect(parts.map((p) => p.PartNumber)).toEqual(parts.map((_, i) => i + 1));
  });

  test("aborts the multipart upload if a part copy fails, then propagates the error", async () => {
    const { client, sent } = fakeS3((s) => {
      if (s.name === CreateMultipartUploadCommand.name) return { UploadId: "upload-1" };
      if (s.name === UploadPartCopyCommand.name) return new Error("SlowDown");
      return {};
    });

    await expect(copyObject(client, SOURCE, DEST, 6 * GIB)).rejects.toThrow("SlowDown");

    expect(sent.map((s) => s.name)).toEqual([
      CreateMultipartUploadCommand.name,
      UploadPartCopyCommand.name,
      AbortMultipartUploadCommand.name,
    ]);
    expect(sent[2]!.input.UploadId).toBe("upload-1");
  });
});

describe("emptyAndDeleteBucket", () => {
  test("follows pagination so a truncated listing does not leave objects behind", async () => {
    let page = 0;
    const { client, sent } = fakeS3((s) => {
      if (s.name !== ListObjectsV2Command.name) return {};
      page += 1;
      return page === 1
        ? { Contents: [{ Key: "a" }], IsTruncated: true, NextContinuationToken: "t2" }
        : { Contents: [{ Key: "b" }], IsTruncated: false };
    });

    await emptyAndDeleteBucket(client, "b");

    expect(sent.filter((s) => s.name === ListObjectsV2Command.name)).toHaveLength(2);
    const deletes = sent.filter((s) => s.name === DeleteObjectsCommand.name);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Delete).toEqual({ Objects: [{ Key: "a" }, { Key: "b" }] });
  });
});

describe("s3BucketExistsGuardStep", () => {
  function guardCtx(client: S3Client): StepContext<{ bucket: string }> {
    return {
      params: { bucket: "the-bucket" },
      creds: {},
      clients: { aws: { s3: client, iam: {}, sts: {}, region: "eu-west-1" } },
      accountId: ACCOUNT,
      outputs: {},
      dryRun: false,
      log: { info() {}, warn() {}, error() {}, success() {} },
    };
  }

  const step = s3BucketExistsGuardStep<{ bucket: string }>({ bucket: (p) => p.bucket });

  test("a bucket we own passes as 'exists' — never a create()", async () => {
    const { client } = fakeS3(() => ({}));
    expect(await step.check(guardCtx(client))).toBe("exists");
    expect(step.create).toBeUndefined();
  });

  test("a missing bucket is folded into 'conflict', not 'missing' — this step never creates one", async () => {
    const { client } = fakeS3(() => awsError("NotFound", 404));
    expect(await step.check(guardCtx(client))).toBe("conflict");
  });

  test("a bucket owned by another account is still 'conflict'", async () => {
    const { client } = fakeS3(() => awsError("Forbidden", 403));
    expect(await step.check(guardCtx(client))).toBe("conflict");
  });

  test("rollback is a no-op — a read-only precondition changes nothing", async () => {
    await expect(step.rollback(guardCtx(fakeS3(() => ({})).client))).resolves.toBeUndefined();
  });
});

interface SettingParams {
  bucket: string;
  enabled: boolean;
  algorithm: "AES256" | "aws:kms";
  kmsKeyId?: string;
  blocked: boolean;
  policy?: Record<string, unknown>;
}

const SETTING_PARAMS: SettingParams = {
  bucket: "the-bucket",
  enabled: false,
  algorithm: "AES256",
  blocked: true,
};

function settingCtx(
  params: SettingParams,
  outputs: Record<string, unknown>,
  client: S3Client,
): StepContext<SettingParams> {
  return {
    params,
    creds: {},
    clients: { aws: { s3: client, iam: {}, sts: {}, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: { info() {}, warn() {}, error() {}, success() {} },
  };
}

describe("s3VersioningStep", () => {
  const step = s3VersioningStep<SettingParams>({
    bucket: (p) => p.bucket,
    desired: (p) => (p.enabled ? "Enabled" : undefined),
  });

  test("always applies — the desired state depends on params, not plan-time state", async () => {
    const { client } = fakeS3(() => ({}));
    expect(await step.check(settingCtx(SETTING_PARAMS, {}, client))).toBe("missing");
    expect(step.create).toBeUndefined();
    expect(step.reconcile).toBeDefined();
  });

  test("desired=undefined leaves the bucket untouched — no API call at all", async () => {
    const { client, sent } = fakeS3(() => ({}));

    const outputs = await step.reconcile!(settingCtx(SETTING_PARAMS, {}, client));

    expect(sent).toEqual([]);
    expect(outputs).toEqual({});
  });

  test("desired=Enabled on a never-configured bucket enables it and captures the prior state", async () => {
    const { client, sent } = fakeS3(() => ({}));

    const outputs = await step.reconcile!(
      settingCtx({ ...SETTING_PARAMS, enabled: true }, {}, client),
    );

    expect(sent.map((s) => s.name)).toEqual([
      GetBucketVersioningCommand.name,
      PutBucketVersioningCommand.name,
    ]);
    expect(sent[1]!.input).toEqual({
      Bucket: "the-bucket",
      VersioningConfiguration: { Status: "Enabled" },
    });
    expect(outputs).toEqual({ priorVersioningStatus: "" });
  });

  test("enabled and already Enabled makes no PutBucketVersioning call", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === GetBucketVersioningCommand.name ? { Status: "Enabled" } : {},
    );

    await step.reconcile!(settingCtx({ ...SETTING_PARAMS, enabled: true }, {}, client));

    expect(sent.map((s) => s.name)).toEqual([GetBucketVersioningCommand.name]);
  });

  test("rollback does nothing when versioning was never touched this run", async () => {
    const { client, sent } = fakeS3(() => ({}));
    await step.rollback(settingCtx(SETTING_PARAMS, {}, client));
    expect(sent).toEqual([]);
  });

  test("rollback restores Enabled exactly when that was the prior state", async () => {
    const { client, sent } = fakeS3(() => ({}));
    await step.rollback(settingCtx(SETTING_PARAMS, { priorVersioningStatus: "Enabled" }, client));
    expect(sent).toEqual([
      {
        name: PutBucketVersioningCommand.name,
        input: { Bucket: "the-bucket", VersioningConfiguration: { Status: "Enabled" } },
      },
    ]);
  });

  test("an explicit Suspended target converges a currently-Enabled bucket", async () => {
    const suspendStep = s3VersioningStep<SettingParams>({
      bucket: (p) => p.bucket,
      desired: () => "Suspended",
    });
    const { client, sent } = fakeS3((s) =>
      s.name === GetBucketVersioningCommand.name ? { Status: "Enabled" } : {},
    );

    const outputs = await suspendStep.reconcile!(settingCtx(SETTING_PARAMS, {}, client));

    expect(sent[1]!.input).toEqual({
      Bucket: "the-bucket",
      VersioningConfiguration: { Status: "Suspended" },
    });
    expect(outputs).toEqual({ priorVersioningStatus: "Enabled" });
  });

  test("rollback restores Suspended (the closest achievable state) when never configured before", async () => {
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(settingCtx(SETTING_PARAMS, { priorVersioningStatus: "" }, client));

    expect(sent.map((s) => ({ name: s.name, input: s.input }))).toEqual([
      {
        name: PutBucketVersioningCommand.name,
        input: { Bucket: "the-bucket", VersioningConfiguration: { Status: "Suspended" } },
      },
    ]);
  });
});

describe("s3EncryptionStep", () => {
  const step = s3EncryptionStep<SettingParams>({
    bucket: (p) => p.bucket,
    enabled: (p) => p.enabled,
    algorithm: (p) => p.algorithm,
    kmsKeyId: (p) => p.kmsKeyId,
  });

  test("disabled leaves the bucket untouched — no API call at all", async () => {
    const { client, sent } = fakeS3(() => ({}));

    const outputs = await step.reconcile!(settingCtx(SETTING_PARAMS, {}, client));

    expect(sent).toEqual([]);
    expect(outputs).toEqual({});
  });

  test("enabled with no prior config sets AES256 and captures 'no prior config'", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === GetBucketEncryptionCommand.name
        ? awsError("ServerSideEncryptionConfigurationNotFoundError", 404)
        : {},
    );

    const outputs = await step.reconcile!(
      settingCtx({ ...SETTING_PARAMS, enabled: true }, {}, client),
    );

    expect(sent.map((s) => s.name)).toEqual([
      GetBucketEncryptionCommand.name,
      PutBucketEncryptionCommand.name,
    ]);
    expect(sent[1]!.input).toEqual({
      Bucket: "the-bucket",
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    });
    expect(outputs).toEqual({ hadExplicitEncryptionConfig: false, priorEncryptionConfig: "" });
  });

  test("aws:kms includes the KMS key id in the desired config", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === GetBucketEncryptionCommand.name
        ? awsError("ServerSideEncryptionConfigurationNotFoundError", 404)
        : {},
    );

    await step.reconcile!(
      settingCtx(
        {
          ...SETTING_PARAMS,
          enabled: true,
          algorithm: "aws:kms",
          kmsKeyId: "arn:aws:kms:ap-south-1:123:key/abc",
        },
        {},
        client,
      ),
    );

    expect(sent[1]!.input.ServerSideEncryptionConfiguration).toEqual({
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: {
            SSEAlgorithm: "aws:kms",
            KMSMasterKeyID: "arn:aws:kms:ap-south-1:123:key/abc",
          },
        },
      ],
    });
  });

  test("rollback deletes the config when there was none before", async () => {
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(
      settingCtx(
        SETTING_PARAMS,
        { hadExplicitEncryptionConfig: false, priorEncryptionConfig: "" },
        client,
      ),
    );

    expect(sent).toEqual([
      { name: DeleteBucketEncryptionCommand.name, input: { Bucket: "the-bucket" } },
    ]);
  });

  test("rollback restores the prior config exactly when one existed before", async () => {
    const prior = { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] };
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(
      settingCtx(
        SETTING_PARAMS,
        { hadExplicitEncryptionConfig: true, priorEncryptionConfig: JSON.stringify(prior) },
        client,
      ),
    );

    expect(sent).toEqual([
      {
        name: PutBucketEncryptionCommand.name,
        input: { Bucket: "the-bucket", ServerSideEncryptionConfiguration: prior },
      },
    ]);
  });

  test("rollback does nothing when encryption was never touched this run", async () => {
    const { client, sent } = fakeS3(() => ({}));
    await step.rollback(settingCtx(SETTING_PARAMS, {}, client));
    expect(sent).toEqual([]);
  });
});

describe("s3PublicAccessBlockStep", () => {
  const step = s3PublicAccessBlockStep<SettingParams>({
    bucket: (p) => p.bucket,
    blocked: (p) => p.blocked,
  });

  test("always reconciles — it is not opt-in, and defaults to blocking", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === GetPublicAccessBlockCommand.name
        ? awsError("NoSuchPublicAccessBlockConfiguration", 404)
        : {},
    );

    const outputs = await step.reconcile!(settingCtx(SETTING_PARAMS, {}, client));

    expect(sent[1]!.input).toEqual({
      Bucket: "the-bucket",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(outputs).toEqual({ hadExplicitPublicAccessBlock: false, priorPublicAccessBlock: "" });
  });

  test("blocked=false sets all four booleans to false", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === GetPublicAccessBlockCommand.name
        ? awsError("NoSuchPublicAccessBlockConfiguration", 404)
        : {},
    );

    await step.reconcile!(settingCtx({ ...SETTING_PARAMS, blocked: false }, {}, client));

    expect(sent[1]!.input.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: false,
      IgnorePublicAcls: false,
      BlockPublicPolicy: false,
      RestrictPublicBuckets: false,
    });
  });

  test("rollback deletes the config when there was none before", async () => {
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(
      settingCtx(
        SETTING_PARAMS,
        { hadExplicitPublicAccessBlock: false, priorPublicAccessBlock: "" },
        client,
      ),
    );

    expect(sent).toEqual([
      { name: DeletePublicAccessBlockCommand.name, input: { Bucket: "the-bucket" } },
    ]);
  });

  test("rollback restores the prior config exactly when one existed before", async () => {
    const prior = {
      BlockPublicAcls: false,
      IgnorePublicAcls: false,
      BlockPublicPolicy: false,
      RestrictPublicBuckets: false,
    };
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(
      settingCtx(
        SETTING_PARAMS,
        { hadExplicitPublicAccessBlock: true, priorPublicAccessBlock: JSON.stringify(prior) },
        client,
      ),
    );

    expect(sent).toEqual([
      {
        name: PutPublicAccessBlockCommand.name,
        input: { Bucket: "the-bucket", PublicAccessBlockConfiguration: prior },
      },
    ]);
  });
});

describe("s3BucketPolicyStep", () => {
  const step = s3BucketPolicyStep<SettingParams>({
    bucket: (p) => p.bucket,
    policy: (p) => p.policy,
  });
  const DESIRED = { Version: "2012-10-17", Statement: [{ Sid: "allow" }] };

  test("policy=undefined leaves the bucket untouched — no API call at all", async () => {
    const { client, sent } = fakeS3(() => ({}));

    const outputs = await step.reconcile!(settingCtx(SETTING_PARAMS, {}, client));

    expect(sent).toEqual([]);
    expect(outputs).toEqual({});
  });

  test("a desired policy with no prior policy sets it and captures 'no prior policy'", async () => {
    const { client, sent } = fakeS3((s) =>
      s.name === GetBucketPolicyCommand.name ? awsError("NoSuchBucketPolicy", 404) : {},
    );

    const outputs = await step.reconcile!(
      settingCtx({ ...SETTING_PARAMS, policy: DESIRED }, {}, client),
    );

    expect(sent.map((s) => s.name)).toEqual([GetBucketPolicyCommand.name, PutBucketPolicyCommand.name]);
    expect(sent[1]!.input).toEqual({ Bucket: "the-bucket", Policy: JSON.stringify(DESIRED) });
    expect(outputs).toEqual({ hadExplicitBucketPolicy: false, priorBucketPolicy: "" });
  });

  test("rollback deletes the policy when there was none before", async () => {
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(
      settingCtx(SETTING_PARAMS, { hadExplicitBucketPolicy: false, priorBucketPolicy: "" }, client),
    );

    expect(sent).toEqual([{ name: DeleteBucketPolicyCommand.name, input: { Bucket: "the-bucket" } }]);
  });

  test("rollback restores the prior policy exactly when one existed before", async () => {
    const prior = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "old" }] });
    const { client, sent } = fakeS3(() => ({}));

    await step.rollback(
      settingCtx(
        SETTING_PARAMS,
        { hadExplicitBucketPolicy: true, priorBucketPolicy: prior },
        client,
      ),
    );

    expect(sent).toEqual([
      { name: PutBucketPolicyCommand.name, input: { Bucket: "the-bucket", Policy: prior } },
    ]);
  });

  test("rollback does nothing when the policy was never touched this run", async () => {
    const { client, sent } = fakeS3(() => ({}));
    await step.rollback(settingCtx(SETTING_PARAMS, {}, client));
    expect(sent).toEqual([]);
  });
});
