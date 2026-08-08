import { describe, expect, test } from "bun:test";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  emptyAndDeleteBucket,
  ensureBucketState,
  s3BucketStep,
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
