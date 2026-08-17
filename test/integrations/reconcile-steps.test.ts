import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepContext } from "../../src/core/define";
import { accessKeyStep } from "../../integrations/aws/s3/create-backend-s3-user/steps/access-key";
import type { Params as BackendParams } from "../../integrations/aws/s3/create-backend-s3-user/params";
import { downloadStep } from "../../integrations/aws/s3/delete-bucket-with-download/steps/download";
import type { Params as DownloadParams } from "../../integrations/aws/s3/delete-bucket-with-download/params";
import { transferStep } from "../../integrations/aws/s3/delete-bucket-with-transfer/steps/transfer";
import { deleteOldBucketStep } from "../../integrations/aws/s3/update-bucket-region/steps/delete-old-bucket";
import type { Params as RegionParams } from "../../integrations/aws/s3/update-bucket-region/params";
import type { Params as TransferParams } from "../../integrations/aws/s3/delete-bucket-with-transfer/params";
import { deleteBucketStep } from "../../integrations/aws/s3/delete-empty-bucket/steps/delete-bucket";
import type { Params as DeleteEmptyBucketParams } from "../../integrations/aws/s3/delete-empty-bucket/params";
import { lifecycleStep } from "../../integrations/aws/s3/enable-bucket-lifecycle-rules/steps/lifecycle";
import type { Params as LifecycleParams } from "../../integrations/aws/s3/enable-bucket-lifecycle-rules/params";
import { loggingStep } from "../../integrations/aws/s3/enable-bucket-logging/steps/logging";
import type { Params as LoggingParams } from "../../integrations/aws/s3/enable-bucket-logging/params";
import { syncStep } from "../../integrations/aws/s3/sync-bucket-contents/steps/sync";
import type { Params as SyncParams } from "../../integrations/aws/s3/sync-bucket-contents/params";
import { tagsStep } from "../../integrations/aws/s3/tag-bucket/steps/tags";
import type { Params as TagBucketParams } from "../../integrations/aws/s3/tag-bucket/params";
import { descIntegrationStep } from "../../integrations/snowflake/create-storage-s3-integration/steps/desc-integration";
import { storageIntegrationStep } from "../../integrations/snowflake/create-storage-s3-integration/steps/storage-integration";
import { trustPolicyStep } from "../../integrations/snowflake/create-storage-s3-integration/steps/trust-policy";
import type { Params as StorageParams } from "../../integrations/snowflake/create-storage-s3-integration/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

const STORAGE_PARAMS: StorageParams = {
  EXPORT_S3_BUCKET: "ferry-bucket",
  EXPORT_S3_PREFIX: "snowflake/",
  SF_STORAGE_INTEGRATION_NAME: "ferry_int",
  SF_STAGE_NAME: "ferry_stage",
  AWS_STORAGE_ROLE_NAME: "ferry-role",
  AWS_STORAGE_POLICY_NAME: "ferry-policy",
  ACCESS_MODE: "read-write",
};

const BACKEND_PARAMS: BackendParams = {
  EXPORT_S3_BUCKET: "ferry-bucket",
  EXPORT_S3_PREFIX: "snowflake/",
  BACKEND_IAM_USER_NAME: "ferry-user",
  BACKEND_IAM_POLICY_NAME: "ferry-user-policy",
};

function sfCtx(
  outputs: Record<string, unknown>,
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>,
): StepContext<StorageParams> {
  const conn = { connection: {}, runQuery, close: async () => {} };
  return {
    params: STORAGE_PARAMS,
    creds: {},
    clients: { snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

function iamCtx<P>(
  params: P,
  outputs: Record<string, unknown>,
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
): StepContext<P> {
  const iam = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: iam, iam, sts: iam, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const DESC_ROWS = [
  { property: "STORAGE_AWS_IAM_USER_ARN", property_value: "arn:aws:iam::123:user/abcd-s" },
  { property: "STORAGE_AWS_EXTERNAL_ID", property_value: "SFCRole=1_abc123=" },
  { property: "STORAGE_AWS_ROLE_ARN", property_value: `arn:aws:iam::${ACCOUNT}:role/ferry-role` },
];

describe("desc-integration (artifact E)", () => {
  test("hands the Snowflake principal and external id to the next step", async () => {
    const ctx = sfCtx({}, async () => DESC_ROWS);

    const outputs = await descIntegrationStep.reconcile!(ctx);

    expect(outputs).toEqual({
      storageAwsIamUserArn: "arn:aws:iam::123:user/abcd-s",
      storageAwsExternalId: "SFCRole=1_abc123=",
    });
  });

  test("fails loudly rather than patching a trust policy with undefined values", async () => {
    const ctx = sfCtx({}, async () => [{ property: "ENABLED", property_value: "true" }]);

    await expect(descIntegrationStep.reconcile!(ctx)).rejects.toThrow(
      /STORAGE_AWS_IAM_USER_ARN/,
    );
  });

  test("reading changes nothing, so it registers no resource and undoes nothing", async () => {
    expect(descIntegrationStep.resource).toBeUndefined();
    await expect(descIntegrationStep.rollback(sfCtx({}, async () => []))).resolves.toBeUndefined();
  });
});

describe("trust-policy (artifact C)", () => {
  const PRIOR = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "before" }] });

  test("always applies — the desired document is unknowable at plan time", async () => {
    expect(await trustPolicyStep.check(sfCtx({}, async () => []))).toBe("missing");
    expect(trustPolicyStep.create).toBeUndefined();
    expect(trustPolicyStep.reconcile).toBeDefined();
  });

  test("rollback restores the trust policy the role had before the patch", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(STORAGE_PARAMS, { priorTrustPolicyDocument: PRIOR }, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return {};
    });

    await trustPolicyStep.rollback(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("UpdateAssumeRolePolicyCommand");
    expect(sent[0].input).toEqual({ RoleName: "ferry-role", PolicyDocument: PRIOR });
  });

  test("rollback does nothing when no prior document was captured", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(STORAGE_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await trustPolicyStep.rollback(ctx);

    expect(sent).toEqual([]);
  });

  test("rollback tolerates the role already having been deleted by a later undo", async () => {
    const ctx = iamCtx(STORAGE_PARAMS, { priorTrustPolicyDocument: PRIOR }, () =>
      Object.assign(new Error("gone"), { name: "NoSuchEntityException" }),
    );

    await expect(trustPolicyStep.rollback(ctx)).resolves.toBeUndefined();
  });
});

describe("storage-integration (artifact D)", () => {
  test("creates with IF NOT EXISTS and never CREATE OR REPLACE", async () => {
    const queries: string[] = [];
    const ctx = sfCtx({}, async (sql) => {
      queries.push(sql);
      return [];
    });

    const outputs = await storageIntegrationStep.create!(ctx);

    expect(queries[0]).toContain("CREATE STORAGE INTEGRATION IF NOT EXISTS ferry_int");
    expect(queries.join("\n")).not.toContain("CREATE OR REPLACE");
    expect(queries[1]).toContain("ALTER STORAGE INTEGRATION ferry_int SET");
    expect(outputs.storageIntegrationCreatedThisRun).toBe(true);
  });

  test("a created integration is dropped on rollback", async () => {
    const queries: string[] = [];
    const ctx = sfCtx({ storageIntegrationCreatedThisRun: true }, async (sql) => {
      queries.push(sql);
      return [];
    });

    await storageIntegrationStep.rollback(ctx);

    expect(queries).toEqual(["DROP STORAGE INTEGRATION IF EXISTS ferry_int;"]);
  });

  test("reconcile captures the prior role ARN and allowed locations before re-pointing", async () => {
    const queries: string[] = [];
    const ctx = sfCtx({}, async (sql) => {
      queries.push(sql);
      return sql.startsWith("DESC")
        ? [
            { property: "STORAGE_AWS_ROLE_ARN", property_value: "arn:aws:iam::999:role/other" },
            { property: "STORAGE_ALLOWED_LOCATIONS", property_value: "s3://other/pre/" },
          ]
        : [];
    });

    const outputs = await storageIntegrationStep.reconcile!(ctx);

    expect(outputs.priorStorageIntegrationRoleArn).toBe("arn:aws:iam::999:role/other");
    expect(outputs.priorStorageIntegrationLocations).toBe("s3://other/pre/");
    expect(queries[0]).toStartWith("DESC INTEGRATION");
  });

  test("a pre-existing integration is put back, not dropped, on rollback", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(
      {
        priorStorageIntegrationRoleArn: "arn:aws:iam::999:role/other",
        priorStorageIntegrationLocations: "s3://other/pre/",
      },
      async (sql) => {
        queries.push(sql);
        return [];
      },
    );

    await storageIntegrationStep.rollback(ctx);

    expect(queries.join("\n")).not.toContain("DROP");
    expect(queries[0]).toContain("arn:aws:iam::999:role/other");
    expect(queries[0]).toContain("s3://other/pre/");
  });
});

describe("access-key", () => {
  test("no key yet → create one", async () => {
    const ctx = iamCtx(BACKEND_PARAMS, {}, () => ({ AccessKeyMetadata: [] }));
    expect(await accessKeyStep.check(ctx)).toBe("missing");
  });

  test("a key already exists → leave it alone, so a re-run creates nothing", async () => {
    const ctx = iamCtx(BACKEND_PARAMS, {}, () => ({
      AccessKeyMetadata: [{ AccessKeyId: "AKIAEXISTING" }],
    }));
    expect(await accessKeyStep.check(ctx)).toBe("exists");
  });

  test("the user does not exist yet → the key is still planned", async () => {
    const ctx = iamCtx(BACKEND_PARAMS, {}, () =>
      Object.assign(new Error("no user"), { name: "NoSuchEntityException" }),
    );
    expect(await accessKeyStep.check(ctx)).toBe("missing");
  });

  test("the registry records the key id and never the secret", async () => {
    const ctx = iamCtx(
      BACKEND_PARAMS,
      { backendAccessKeyId: "AKIANEW", backendSecretAccessKey: "super-secret" },
      () => ({}),
    );

    const resource = accessKeyStep.resource!(ctx);

    expect(JSON.stringify(resource)).toContain("AKIANEW");
    expect(JSON.stringify(resource)).not.toContain("super-secret");
  });
});

function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

const TAG_BUCKET_PARAMS: TagBucketParams = {
  S3_BUCKET_NAME: "ferry-tagged-bucket",
  TAGS_JSON: "",
};

describe("bucket-tags (aws/s3/tag-bucket)", () => {
  test("TAGS_JSON unset leaves the bucket untouched — no API call at all", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TAG_BUCKET_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    const outputs = await tagsStep.reconcile!(ctx);

    expect(sent).toEqual([]);
    expect(outputs).toEqual({});
  });

  test("a desired tag set with no prior tags sets it and captures 'no prior tags'", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      { ...TAG_BUCKET_PARAMS, TAGS_JSON: '{"env":"prod"}' },
      {},
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return command.constructor.name === "GetBucketTaggingCommand"
          ? awsError("NoSuchTagSet", 404)
          : {};
      },
    );

    const outputs = await tagsStep.reconcile!(ctx);

    expect(sent.map((s) => s.name)).toEqual(["GetBucketTaggingCommand", "PutBucketTaggingCommand"]);
    expect(sent[1]!.input).toEqual({
      Bucket: "ferry-tagged-bucket",
      Tagging: { TagSet: [{ Key: "env", Value: "prod" }] },
    });
    expect(outputs).toEqual({ hadPriorTags: false, priorTagSetJson: "" });
  });

  test("TAGS_JSON={} clears every tag via DeleteBucketTagging, not an empty Put", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx({ ...TAG_BUCKET_PARAMS, TAGS_JSON: "{}" }, {}, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GetBucketTaggingCommand"
        ? { TagSet: [{ Key: "old", Value: "tag" }] }
        : {};
    });

    await tagsStep.reconcile!(ctx);

    expect(sent.map((s) => s.name)).toEqual([
      "GetBucketTaggingCommand",
      "DeleteBucketTaggingCommand",
    ]);
  });

  test("rollback deletes the tags when there were none before", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      TAG_BUCKET_PARAMS,
      { hadPriorTags: false, priorTagSetJson: "" },
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      },
    );

    await tagsStep.rollback(ctx);

    expect(sent).toEqual([
      { name: "DeleteBucketTaggingCommand", input: { Bucket: "ferry-tagged-bucket" } },
    ]);
  });

  test("rollback restores the prior tag set exactly when one existed before", async () => {
    const prior = [{ Key: "env", Value: "staging" }];
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      TAG_BUCKET_PARAMS,
      { hadPriorTags: true, priorTagSetJson: JSON.stringify(prior) },
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      },
    );

    await tagsStep.rollback(ctx);

    expect(sent).toEqual([
      {
        name: "PutBucketTaggingCommand",
        input: { Bucket: "ferry-tagged-bucket", Tagging: { TagSet: prior } },
      },
    ]);
  });

  test("rollback does nothing when tags were never touched this run", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TAG_BUCKET_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await tagsStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

const LIFECYCLE_PARAMS: LifecycleParams = {
  S3_BUCKET_NAME: "ferry-lifecycle-bucket",
  LIFECYCLE_RULES_JSON: "",
};

describe("bucket-lifecycle (aws/s3/enable-bucket-lifecycle-rules)", () => {
  const RULE = { ID: "expire-logs", Filter: { Prefix: "logs/" }, Status: "Enabled", Expiration: { Days: 365 } };

  test("LIFECYCLE_RULES_JSON unset leaves the bucket untouched — no API call at all", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(LIFECYCLE_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    const outputs = await lifecycleStep.reconcile!(ctx);

    expect(sent).toEqual([]);
    expect(outputs).toEqual({});
  });

  test("a desired rule set with no prior config sets it and captures 'no prior config'", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      { ...LIFECYCLE_PARAMS, LIFECYCLE_RULES_JSON: JSON.stringify([RULE]) },
      {},
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return command.constructor.name === "GetBucketLifecycleConfigurationCommand"
          ? awsError("NoSuchLifecycleConfiguration", 404)
          : {};
      },
    );

    const outputs = await lifecycleStep.reconcile!(ctx);

    expect(sent.map((s) => s.name)).toEqual([
      "GetBucketLifecycleConfigurationCommand",
      "PutBucketLifecycleConfigurationCommand",
    ]);
    expect(sent[1]!.input).toEqual({
      Bucket: "ferry-lifecycle-bucket",
      LifecycleConfiguration: { Rules: [RULE] },
    });
    expect(outputs).toEqual({ hadPriorLifecycleConfig: false, priorLifecycleRulesJson: "" });
  });

  test("LIFECYCLE_RULES_JSON=[] clears the configuration via DeleteBucketLifecycle", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx({ ...LIFECYCLE_PARAMS, LIFECYCLE_RULES_JSON: "[]" }, {}, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "GetBucketLifecycleConfigurationCommand"
        ? { Rules: [RULE] }
        : {};
    });

    await lifecycleStep.reconcile!(ctx);

    expect(sent.map((s) => s.name)).toEqual([
      "GetBucketLifecycleConfigurationCommand",
      "DeleteBucketLifecycleCommand",
    ]);
  });

  test("rollback restores the prior rule set exactly when one existed before", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      LIFECYCLE_PARAMS,
      { hadPriorLifecycleConfig: true, priorLifecycleRulesJson: JSON.stringify([RULE]) },
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      },
    );

    await lifecycleStep.rollback(ctx);

    expect(sent).toEqual([
      {
        name: "PutBucketLifecycleConfigurationCommand",
        input: { Bucket: "ferry-lifecycle-bucket", LifecycleConfiguration: { Rules: [RULE] } },
      },
    ]);
  });

  test("rollback does nothing when the configuration was never touched this run", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(LIFECYCLE_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await lifecycleStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

const LOGGING_PARAMS: LoggingParams = {
  S3_BUCKET_NAME: "ferry-logged-bucket",
  LOGGING_TARGET_BUCKET: "ferry-log-target",
  LOGGING_TARGET_PREFIX: "logs/",
};

describe("bucket-logging (aws/s3/enable-bucket-logging)", () => {
  test("always reconciles — captures the prior target (or none) before setting the new one", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(LOGGING_PARAMS, {}, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return {};
    });

    const outputs = await loggingStep.reconcile!(ctx);

    expect(sent.map((s) => s.name)).toEqual(["GetBucketLoggingCommand", "PutBucketLoggingCommand"]);
    expect(sent[1]!.input).toEqual({
      Bucket: "ferry-logged-bucket",
      BucketLoggingStatus: {
        LoggingEnabled: { TargetBucket: "ferry-log-target", TargetPrefix: "logs/" },
      },
    });
    expect(outputs).toEqual({ hadPriorLogging: false, priorLoggingJson: "" });
  });

  test("rollback disables logging when there was none before", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(LOGGING_PARAMS, { hadPriorLogging: false }, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return {};
    });

    await loggingStep.rollback(ctx);

    expect(sent).toEqual([
      { name: "PutBucketLoggingCommand", input: { Bucket: "ferry-logged-bucket", BucketLoggingStatus: {} } },
    ]);
  });

  test("rollback restores the prior target exactly when one existed before", async () => {
    const prior = { TargetBucket: "old-target", TargetPrefix: "old/" };
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      LOGGING_PARAMS,
      { hadPriorLogging: true, priorLoggingJson: JSON.stringify(prior) },
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      },
    );

    await loggingStep.rollback(ctx);

    expect(sent).toEqual([
      {
        name: "PutBucketLoggingCommand",
        input: { Bucket: "ferry-logged-bucket", BucketLoggingStatus: { LoggingEnabled: prior } },
      },
    ]);
  });
});

const DELETE_EMPTY_BUCKET_PARAMS: DeleteEmptyBucketParams = {
  S3_BUCKET_NAME: "ferry-doomed-bucket",
};

describe("delete-empty-bucket (aws/s3/delete-empty-bucket)", () => {
  test("a bucket already gone reads as 'exists' — the target state is already achieved", async () => {
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, {}, () =>
      Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    expect(await deleteBucketStep.check(ctx)).toBe("exists");
  });

  test("a bucket owned by another account is 'conflict'", async () => {
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, {}, () =>
      Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }),
    );
    expect(await deleteBucketStep.check(ctx)).toBe("conflict");
  });

  test("a present, non-empty bucket is 'conflict' — this step never empties it", async () => {
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, {}, (command) => {
      if (command.constructor.name === "HeadBucketCommand") return {};
      if (command.constructor.name === "ListObjectsV2Command") return { Contents: [{ Key: "a" }] };
      return {};
    });
    expect(await deleteBucketStep.check(ctx)).toBe("conflict");
  });

  test("a present, empty bucket is 'missing' — the delete still needs to happen", async () => {
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, {}, (command) => {
      if (command.constructor.name === "HeadBucketCommand") return {};
      if (command.constructor.name === "ListObjectsV2Command") return { Contents: [] };
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return { Versions: [], DeleteMarkers: [] };
      }
      return {};
    });
    expect(await deleteBucketStep.check(ctx)).toBe("missing");
  });

  test("create() deletes the bucket", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    const outputs = await deleteBucketStep.create!(ctx);

    expect(sent).toEqual(["DeleteBucketCommand"]);
    expect(outputs).toEqual({ bucketDeletedThisRun: true });
  });

  test("rollback recreates an empty bucket when this run deleted it", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, { bucketDeletedThisRun: true }, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await deleteBucketStep.rollback(ctx);

    expect(sent).toEqual(["CreateBucketCommand"]);
  });

  test("rollback does nothing when this run did not delete the bucket (it was already gone)", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_EMPTY_BUCKET_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await deleteBucketStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

const TRANSFER_PARAMS: TransferParams = {
  SOURCE_S3_BUCKET_NAME: "ferry-source-bucket",
  DESTINATION_S3_BUCKET_NAME: "ferry-destination-bucket",
};

describe("transfer-and-delete-source (aws/s3/delete-bucket-with-transfer)", () => {
  test("source already gone reads as 'exists' — the target state is already achieved", async () => {
    const ctx = iamCtx(TRANSFER_PARAMS, {}, () =>
      Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    expect(await transferStep.check(ctx)).toBe("exists");
  });

  test("source owned by another account is 'conflict'", async () => {
    const ctx = iamCtx(TRANSFER_PARAMS, {}, () =>
      Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }),
    );
    expect(await transferStep.check(ctx)).toBe("conflict");
  });

  test("source present is 'missing' — transfer + delete still needs to happen", async () => {
    const ctx = iamCtx(TRANSFER_PARAMS, {}, () => ({}));
    expect(await transferStep.check(ctx)).toBe("missing");
  });

  test("copies every key, confirms landing, then deletes the source — in that order", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(TRANSFER_PARAMS, {}, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "a" }, { Key: "b" }], IsTruncated: false };
      }
      if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 10 };
      return {};
    });

    const outputs = await transferStep.create!(ctx);

    const names = sent.map((s) => s.name);
    // Every copy+confirm for both keys happens before any source mutation.
    const firstMutationIndex = names.findIndex(
      (n) => n === "DeleteObjectsCommand" || n === "DeleteBucketCommand",
    );
    const copyIndices = names
      .map((n, i) => (n === "CopyObjectCommand" ? i : -1))
      .filter((i) => i >= 0);
    expect(copyIndices).toHaveLength(2);
    expect(copyIndices.every((i) => i < firstMutationIndex)).toBe(true);
    expect(names).toContain("DeleteObjectsCommand");
    expect(names[names.length - 1]).toBe("DeleteBucketCommand");
    expect(outputs).toEqual({ transferredKeysJson: JSON.stringify(["a", "b"]) });
  });

  test("aborts before touching the source if a copied object fails to confirm as landed", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TRANSFER_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "a" }], IsTruncated: false };
      }
      // The size-probe HeadObject (against the source, inside copyObject)
      // succeeds; only the post-copy landing check (against the
      // destination, inside objectExists) reports "not found".
      if (
        command.constructor.name === "HeadObjectCommand" &&
        command.input.Bucket === TRANSFER_PARAMS.DESTINATION_S3_BUCKET_NAME
      ) {
        return Object.assign(new Error("NotFound"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 10 };
      return {};
    });

    await expect(transferStep.create!(ctx)).rejects.toThrow(/did not confirm as landed/);

    expect(sent).not.toContain("DeleteObjectsCommand");
    expect(sent).not.toContain("DeleteBucketCommand");
  });

  test("rollback deletes only the keys this run copied, from the destination only", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(
      TRANSFER_PARAMS,
      { transferredKeysJson: JSON.stringify(["a", "b"]) },
      (command) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return {};
      },
    );

    await transferStep.rollback(ctx);

    expect(sent).toEqual([
      {
        name: "DeleteObjectsCommand",
        input: {
          Bucket: "ferry-destination-bucket",
          Delete: { Objects: [{ Key: "a" }, { Key: "b" }] },
        },
      },
    ]);
  });

  test("rollback does nothing when nothing was transferred this run", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TRANSFER_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await transferStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

describe("download-and-delete-source (aws/s3/delete-bucket-with-download)", () => {
  let downloadDir: string;

  beforeEach(async () => {
    downloadDir = await mkdtemp(path.join(tmpdir(), "ferry-download-test-"));
  });

  afterEach(async () => {
    await rm(downloadDir, { recursive: true, force: true });
  });

  function fakeBody(text: string) {
    return { transformToByteArray: async () => new TextEncoder().encode(text) };
  }

  function downloadParams(): DownloadParams {
    return {
      SOURCE_S3_BUCKET_NAME: "ferry-source-bucket",
      DOWNLOAD_DIR: downloadDir,
      PRESERVE_KEY_PREFIX_STRUCTURE: true,
    };
  }

  test("source already gone reads as 'exists' — the target state is already achieved", async () => {
    const ctx = iamCtx(downloadParams(), {}, () =>
      Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    expect(await downloadStep.check(ctx)).toBe("exists");
  });

  test("downloads every key to disk, confirms size, then deletes the source — in that order", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(downloadParams(), {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "logs/a.txt" }], IsTruncated: false };
      }
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: fakeBody("hello"), ContentLength: 5 };
      }
      return {};
    });

    const outputs = await downloadStep.create!(ctx);

    const names = sent;
    const getIndex = names.indexOf("GetObjectCommand");
    const deleteIndex = names.indexOf("DeleteObjectsCommand");
    expect(getIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(getIndex);
    expect(names[names.length - 1]).toBe("DeleteBucketCommand");

    const written = await readFile(path.join(downloadDir, "logs/a.txt"), "utf8");
    expect(written).toBe("hello");
    expect(outputs).toEqual({
      downloadedManifestJson: JSON.stringify([{ key: "logs/a.txt", size: 5 }]),
    });
  });

  test("aborts before touching the source if a downloaded file's size does not match", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(downloadParams(), {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "a.txt" }], IsTruncated: false };
      }
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: fakeBody("hello"), ContentLength: 999 };
      }
      return {};
    });

    await expect(downloadStep.create!(ctx)).rejects.toThrow(/expected 999/);

    expect(sent).not.toContain("DeleteObjectsCommand");
    expect(sent).not.toContain("DeleteBucketCommand");
  });

  test("rollback deletes only the local files this run created", async () => {
    const ctx = iamCtx(
      downloadParams(),
      { downloadedManifestJson: JSON.stringify([{ key: "logs/a.txt", size: 5 }]) },
      () => ({}),
    );
    await mkdir(path.join(downloadDir, "logs"), { recursive: true });
    await writeFile(path.join(downloadDir, "logs/a.txt"), "hello");

    await downloadStep.rollback(ctx);

    await expect(readFile(path.join(downloadDir, "logs/a.txt"), "utf8")).rejects.toThrow();
  });

  test("rollback does nothing when nothing was downloaded this run", async () => {
    const ctx = iamCtx(downloadParams(), {}, () => ({}));
    await expect(downloadStep.rollback(ctx)).resolves.toBeUndefined();
  });
});

const REGION_PARAMS: RegionParams = {
  OLD_S3_BUCKET_NAME: "ferry-old-bucket",
  NEW_S3_BUCKET_NAME: "ferry-new-bucket",
};

describe("delete-old-bucket (aws/s3/update-bucket-region)", () => {
  test("old bucket already gone reads as 'exists' — the target state is already achieved", async () => {
    const ctx = iamCtx(REGION_PARAMS, {}, () =>
      Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    expect(await deleteOldBucketStep.check(ctx)).toBe("exists");
  });

  test("old bucket owned by another account is 'conflict'", async () => {
    const ctx = iamCtx(REGION_PARAMS, {}, () =>
      Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }),
    );
    expect(await deleteOldBucketStep.check(ctx)).toBe("conflict");
  });

  test("old bucket present is 'missing' — deletion still needs to happen", async () => {
    const ctx = iamCtx(REGION_PARAMS, {}, () => ({}));
    expect(await deleteOldBucketStep.check(ctx)).toBe("missing");
  });

  test("create() empties then deletes the old bucket", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(REGION_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "a" }], IsTruncated: false };
      }
      return {};
    });

    const outputs = await deleteOldBucketStep.create!(ctx);

    expect(sent).toEqual(["ListObjectsV2Command", "DeleteObjectsCommand", "DeleteBucketCommand"]);
    expect(outputs).toEqual({ oldBucketDeletedThisRun: true });
  });

  test("rollback recreates an empty bucket when this run deleted it", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(REGION_PARAMS, { oldBucketDeletedThisRun: true }, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await deleteOldBucketStep.rollback(ctx);

    expect(sent).toEqual(["CreateBucketCommand"]);
  });

  test("rollback does nothing when this run did not delete the old bucket", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(REGION_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await deleteOldBucketStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

const SYNC_PARAMS: SyncParams = {
  SOURCE_S3_BUCKET_NAME: "ferry-sync-source",
  DESTINATION_S3_BUCKET_NAME: "ferry-sync-dest",
  KEY_PREFIX_FILTER: "",
};

describe("sync-objects (aws/s3/sync-bucket-contents)", () => {
  test("copies a key present in source but missing from destination", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(SYNC_PARAMS, {}, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "ListObjectsV2Command") {
        return command.input.Bucket === SYNC_PARAMS.SOURCE_S3_BUCKET_NAME
          ? { Contents: [{ Key: "a", Size: 5 }], IsTruncated: false }
          : { Contents: [], IsTruncated: false };
      }
      return {};
    });

    const outputs = await syncStep.reconcile!(ctx);

    expect(sent.map((s) => s.name)).toEqual([
      "ListObjectsV2Command",
      "ListObjectsV2Command",
      "CopyObjectCommand",
      "HeadObjectCommand",
    ]);
    expect(outputs).toEqual({ syncedKeysJson: JSON.stringify(["a"]) });
  });

  test("does not re-copy a key already present with the same size", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SYNC_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return { Contents: [{ Key: "a", Size: 5 }], IsTruncated: false };
      }
      return {};
    });

    const outputs = await syncStep.reconcile!(ctx);

    expect(sent).toEqual(["ListObjectsV2Command", "ListObjectsV2Command"]);
    expect(outputs).toEqual({ syncedKeysJson: JSON.stringify([]) });
  });

  test("re-copies a key whose size differs between source and destination", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SYNC_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return command.input.Bucket === SYNC_PARAMS.SOURCE_S3_BUCKET_NAME
          ? { Contents: [{ Key: "a", Size: 5 }], IsTruncated: false }
          : { Contents: [{ Key: "a", Size: 3 }], IsTruncated: false };
      }
      return {};
    });

    const outputs = await syncStep.reconcile!(ctx);

    expect(sent).toContain("CopyObjectCommand");
    expect(outputs).toEqual({ syncedKeysJson: JSON.stringify(["a"]) });
  });

  test("never sends a delete of any kind — this is non-destructive", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SYNC_PARAMS, {}, (command) => {
      sent.push(command.constructor.name);
      if (command.constructor.name === "ListObjectsV2Command") {
        return command.input.Bucket === SYNC_PARAMS.SOURCE_S3_BUCKET_NAME
          ? { Contents: [{ Key: "a", Size: 5 }], IsTruncated: false }
          : { Contents: [], IsTruncated: false };
      }
      return {};
    });

    await syncStep.reconcile!(ctx);

    expect(sent.some((n) => n.includes("Delete"))).toBe(false);
  });

  test("rollback deletes only the keys this run synced, from the destination only", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(SYNC_PARAMS, { syncedKeysJson: JSON.stringify(["a"]) }, (command) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return {};
    });

    await syncStep.rollback(ctx);

    expect(sent).toEqual([
      {
        name: "DeleteObjectsCommand",
        input: { Bucket: "ferry-sync-dest", Delete: { Objects: [{ Key: "a" }] } },
      },
    ]);
  });

  test("rollback does nothing when nothing was synced this run", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SYNC_PARAMS, { syncedKeysJson: JSON.stringify([]) }, (command) => {
      sent.push(command.constructor.name);
      return {};
    });

    await syncStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});
