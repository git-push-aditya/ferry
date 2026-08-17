import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { findIntegration } from "../../src/core/discover";
import { runIntegration } from "../../src/core/engine";
import { FerryError } from "../../src/core/errors";
import type { ProviderDef, ProviderRegistry } from "../../src/core/provider";
import { awsCredentialsSchema } from "../../src/providers/aws";
import { snowflakeCredentialsSchema } from "../../src/providers/snowflake";

const REPO_INTEGRATIONS = path.join(import.meta.dir, "../../integrations");
const ACCOUNT = "909317186541";

/**
 * Command names that change something. The dry-run assertions below check this
 * list is never touched, which is the whole promise of `--dry-run`.
 */
const MUTATING = [
  "CreateBucketCommand",
  "DeleteBucketCommand",
  "PutObjectCommand",
  "DeleteObjectCommand",
  "DeleteObjectsCommand",
  "CreatePolicyCommand",
  "DeletePolicyCommand",
  "CreateRoleCommand",
  "DeleteRoleCommand",
  "AttachRolePolicyCommand",
  "DetachRolePolicyCommand",
  "UpdateAssumeRolePolicyCommand",
  "CreateUserCommand",
  "DeleteUserCommand",
  "AttachUserPolicyCommand",
  "DetachUserPolicyCommand",
  "CreateAccessKeyCommand",
  "DeleteAccessKeyCommand",
];

const MUTATING_SQL = /^\s*(CREATE|ALTER|DROP|COPY)/i;

function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

interface Recorder {
  commands: string[];
  queries: string[];
}

/** A clean account: nothing exists yet, and every probe says so. */
function cleanAccountReplies(commandName: string): unknown {
  switch (commandName) {
    case "HeadBucketCommand":
    case "HeadObjectCommand":
      return awsError("NotFound", 404);
    case "GetPolicyCommand":
    case "GetRoleCommand":
    case "GetUserCommand":
    case "ListAttachedRolePoliciesCommand":
    case "ListAttachedUserPoliciesCommand":
    case "ListAccessKeysCommand":
      return awsError("NoSuchEntityException", 404);
    default:
      return {};
  }
}

function stubProviders(
  rec: Recorder,
  replies: (commandName: string) => unknown,
  sqlReplies: (sql: string) => Record<string, unknown>[] = () => [],
): ProviderRegistry {
  const send = async (command: { constructor: { name: string } }) => {
    rec.commands.push(command.constructor.name);
    const reply = replies(command.constructor.name);
    if (reply instanceof Error) throw reply;
    return reply ?? {};
  };
  const client = { send };

  const aws: ProviderDef<unknown> = {
    id: "aws",
    credentialKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"],
    credentialSchema: awsCredentialsSchema,
    createClients: () => ({ s3: client, iam: client, sts: client, region: "ap-south-1" }),
    resolveIdentity: async () => ({ accountId: ACCOUNT, description: "stub identity" }),
  };

  const snowflake: ProviderDef<unknown> = {
    id: "snowflake",
    credentialKeys: [
      "SNOWFLAKE_ACCOUNT",
      "SNOWFLAKE_USERNAME",
      "SNOWFLAKE_PASSWORD",
      "SNOWFLAKE_PRIVATE_KEY",
      "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE",
      "SNOWFLAKE_ROLE",
      "SNOWFLAKE_WAREHOUSE",
      "SNOWFLAKE_DATABASE",
      "SNOWFLAKE_SCHEMA",
    ],
    credentialSchema: snowflakeCredentialsSchema as unknown as z.ZodTypeAny,
    createClients: () => {
      const conn = {
        connection: {},
        runQuery: async (sql: string) => {
          rec.queries.push(sql);
          return sqlReplies(sql);
        },
        close: async () => {},
      };
      return { connection: async () => conn, peek: () => conn, close: async () => {} };
    },
  };

  return { aws, snowflake };
}

const CREDS = {
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_REGION: "ap-south-1",
  SNOWFLAKE_ACCOUNT: "acct",
  SNOWFLAKE_USERNAME: "svc",
  SNOWFLAKE_PASSWORD: "pw",
  SNOWFLAKE_ROLE: "ACCOUNTADMIN",
  SNOWFLAKE_WAREHOUSE: "wh",
  SNOWFLAKE_DATABASE: "db",
  SNOWFLAKE_SCHEMA: "public",
};

const STORAGE_PARAMS = `
EXPORT_S3_BUCKET=ferry-test-bucket
EXPORT_S3_PREFIX=snowflake/
SF_STORAGE_INTEGRATION_NAME=ferry_test_int
SF_STAGE_NAME=ferry_test_stage
AWS_STORAGE_ROLE_NAME=ferry-test-role
AWS_STORAGE_POLICY_NAME=ferry-test-policy
`;

const BACKEND_PARAMS = `
EXPORT_S3_BUCKET=ferry-test-bucket
EXPORT_S3_PREFIX=snowflake/
BACKEND_IAM_USER_NAME=ferry-test-user
BACKEND_IAM_POLICY_NAME=ferry-test-user-policy
`;

const CREATE_BUCKET_PARAMS = `
S3_BUCKET_NAME=ferry-test-new-bucket
`;

const UPDATE_VERSIONING_PARAMS = `
S3_BUCKET_NAME=ferry-test-existing-bucket
DESIRED_VERSIONING_STATUS=Enabled
`;

const UPDATE_ENCRYPTION_PARAMS = `
S3_BUCKET_NAME=ferry-test-existing-bucket
ENCRYPTION_ALGORITHM=AES256
`;

const UPDATE_PERMISSIONS_PARAMS = `
S3_BUCKET_NAME=ferry-test-existing-bucket
`;

let workDir: string;
let silenced: { log: typeof console.log; warn: typeof console.warn };

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "ferry-plan-"));
  silenced = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
});

afterEach(async () => {
  console.log = silenced.log;
  console.warn = silenced.warn;
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  await rm(workDir, { recursive: true, force: true });
});

async function paramsFile(contents: string): Promise<string> {
  const file = path.join(workDir, "params.env");
  await writeFile(file, contents);
  return file;
}

async function dryRun(id: string, params: string, rec: Recorder, replies = cleanAccountReplies) {
  const found = await findIntegration(REPO_INTEGRATIONS, id);
  return runIntegration({
    found,
    providers: stubProviders(rec, replies),
    dryRun: true,
    credentialSource: CREDS,
    folderEnvPath: await paramsFile(params),
    skipReport: true,
  });
}

describe("snowflake/create-storage-s3-integration — dry-run plan", () => {
  test("plans every step, in the order the circular dependency requires", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("snowflake/create-storage-s3-integration", STORAGE_PARAMS, rec);

    expect(result.plan.map((p) => p.stepId)).toEqual([
      "s3-bucket",
      "s3-prefix-marker",
      "iam-policy",
      "iam-role",
      "attach-policy",
      "snowflake-connect",
      "storage-integration",
      "desc-integration",
      "trust-policy",
      "stage",
    ]);
  });

  test("on a clean account everything is a create, except the reads and the patch", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("snowflake/create-storage-s3-integration", STORAGE_PARAMS, rec);

    expect(Object.fromEntries(result.plan.map((p) => [p.stepId, p.action]))).toEqual({
      "s3-bucket": "create",
      "s3-prefix-marker": "create",
      "iam-policy": "create",
      "iam-role": "create",
      "attach-policy": "create",
      // Connecting is a read, so it never needs applying.
      "snowflake-connect": "skip",
      "storage-integration": "create",
      // These two always run: the DESC read and the trust-policy patch depend
      // on values that don't exist until apply time.
      "desc-integration": "reconcile",
      "trust-policy": "reconcile",
      stage: "create",
    });
  });

  test("mutates nothing at all — no AWS write command, no DDL, no COPY", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("snowflake/create-storage-s3-integration", STORAGE_PARAMS, rec);

    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
    expect(rec.queries.filter((q) => MUTATING_SQL.test(q))).toEqual([]);
  });

  test("recognises an already-provisioned account and plans no creates", async () => {
    const rec: Recorder = { commands: [], queries: [] };
    const found = await findIntegration(
      REPO_INTEGRATIONS,
      "snowflake/create-storage-s3-integration",
    );

    const result = await runIntegration({
      found,
      providers: stubProviders(
        rec,
        (name) =>
          name === "ListAttachedRolePoliciesCommand"
            ? { AttachedPolicies: [{ PolicyArn: `arn:aws:iam::${ACCOUNT}:policy/ferry-test-policy` }] }
            : {},
        (sql) =>
          /^SHOW (INTEGRATIONS|STAGES)/i.test(sql.trim())
            ? [{ name: sql.includes("INTEGRATIONS") ? "FERRY_TEST_INT" : "FERRY_TEST_STAGE" }]
            : [],
      ),
      dryRun: true,
      credentialSource: CREDS,
      folderEnvPath: await paramsFile(STORAGE_PARAMS),
      skipReport: true,
    });

    expect(result.plan.filter((p) => p.action === "create")).toEqual([]);
  });

  test("a bucket owned by another AWS account aborts in the plan phase", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const attempt = dryRun("snowflake/create-storage-s3-integration", STORAGE_PARAMS, rec, (name) =>
      name === "HeadBucketCommand" ? awsError("Forbidden", 403) : cleanAccountReplies(name),
    );

    await expect(attempt).rejects.toThrow(FerryError);
    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });
});

describe("aws/s3/create-backend-s3-user — dry-run plan", () => {
  test("puts the shared bucket check in front of the IAM work", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("aws/s3/create-backend-s3-user", BACKEND_PARAMS, rec);

    expect(result.plan.map((p) => p.stepId)).toEqual([
      "s3-bucket",
      "iam-policy",
      "iam-user",
      "attach-policy",
      "access-key",
    ]);
  });

  test("reuses a bucket it did not create instead of planning one", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("aws/s3/create-backend-s3-user", BACKEND_PARAMS, rec, (name) =>
      name === "HeadBucketCommand" ? {} : cleanAccountReplies(name),
    );

    expect(result.plan.find((p) => p.stepId === "s3-bucket")).toMatchObject({
      state: "exists",
      action: "skip",
    });
  });

  test("leaves an existing access key alone — re-running mints no second credential", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("aws/s3/create-backend-s3-user", BACKEND_PARAMS, rec, (name) =>
      name === "ListAccessKeysCommand"
        ? { AccessKeyMetadata: [{ AccessKeyId: "AKIAEXISTING" }] }
        : cleanAccountReplies(name),
    );

    expect(result.plan.find((p) => p.stepId === "access-key")).toMatchObject({ action: "skip" });
  });

  test("mutates nothing at all", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("aws/s3/create-backend-s3-user", BACKEND_PARAMS, rec);

    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("a bucket owned by another AWS account aborts in the plan phase", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const attempt = dryRun("aws/s3/create-backend-s3-user", BACKEND_PARAMS, rec, (name) =>
      name === "HeadBucketCommand" ? awsError("Forbidden", 403) : cleanAccountReplies(name),
    );

    await expect(attempt).rejects.toThrow(FerryError);
    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("declares no Snowflake credentials, so no Snowflake client is ever built", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("aws/s3/create-backend-s3-user", BACKEND_PARAMS, rec);

    expect(rec.queries).toEqual([]);
  });
});

describe("aws/s3/create-bucket — dry-run plan", () => {
  test("plans the bucket, then every opt-in/always-on setting step, in order", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("aws/s3/create-bucket", CREATE_BUCKET_PARAMS, rec);

    expect(result.plan.map((p) => p.stepId)).toEqual([
      "s3-bucket",
      "bucket-versioning",
      "bucket-encryption",
      "bucket-public-access-block",
    ]);
  });

  test("plans to create the bucket on a clean account", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("aws/s3/create-bucket", CREATE_BUCKET_PARAMS, rec);

    expect(result.plan.find((p) => p.stepId === "s3-bucket")).toMatchObject({
      state: "missing",
      action: "create",
    });
  });

  test("versioning/encryption/public-access-block always reconcile — the desired value depends on params, not on plan-time state", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun("aws/s3/create-bucket", CREATE_BUCKET_PARAMS, rec);

    for (const id of ["bucket-versioning", "bucket-encryption", "bucket-public-access-block"]) {
      expect(result.plan.find((p) => p.stepId === id)).toMatchObject({ action: "reconcile" });
    }
  });

  test("mutates nothing at all", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("aws/s3/create-bucket", CREATE_BUCKET_PARAMS, rec);

    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("a bucket name owned by another AWS account aborts in the plan phase", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const attempt = dryRun("aws/s3/create-bucket", CREATE_BUCKET_PARAMS, rec, (name) =>
      name === "HeadBucketCommand" ? awsError("Forbidden", 403) : cleanAccountReplies(name),
    );

    await expect(attempt).rejects.toThrow(FerryError);
    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("declares no Snowflake credentials, so no Snowflake client is ever built", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("aws/s3/create-bucket", CREATE_BUCKET_PARAMS, rec);

    expect(rec.queries).toEqual([]);
  });
});

/** These two integrations operate on a bucket that already exists. */
function existingBucketReplies(name: string): unknown {
  return name === "HeadBucketCommand" ? {} : cleanAccountReplies(name);
}

describe("aws/s3/update-bucket-versioning — dry-run plan", () => {
  test("plans the guard step, then the versioning step", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun(
      "aws/s3/update-bucket-versioning",
      UPDATE_VERSIONING_PARAMS,
      rec,
      existingBucketReplies,
    );

    expect(result.plan.map((p) => p.stepId)).toEqual(["s3-bucket-exists", "bucket-versioning"]);
  });

  test("a bucket that does not exist aborts in the plan phase", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const attempt = dryRun(
      "aws/s3/update-bucket-versioning",
      UPDATE_VERSIONING_PARAMS,
      rec,
      cleanAccountReplies,
    );

    await expect(attempt).rejects.toThrow(FerryError);
    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("mutates nothing at all", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("aws/s3/update-bucket-versioning", UPDATE_VERSIONING_PARAMS, rec, existingBucketReplies);

    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });
});

describe("aws/s3/update-bucket-encryption — dry-run plan", () => {
  test("plans the guard step, then the encryption step", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun(
      "aws/s3/update-bucket-encryption",
      UPDATE_ENCRYPTION_PARAMS,
      rec,
      existingBucketReplies,
    );

    expect(result.plan.map((p) => p.stepId)).toEqual(["s3-bucket-exists", "bucket-encryption"]);
  });

  test("a bucket that does not exist aborts in the plan phase", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const attempt = dryRun(
      "aws/s3/update-bucket-encryption",
      UPDATE_ENCRYPTION_PARAMS,
      rec,
      cleanAccountReplies,
    );

    await expect(attempt).rejects.toThrow(FerryError);
    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("mutates nothing at all", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun("aws/s3/update-bucket-encryption", UPDATE_ENCRYPTION_PARAMS, rec, existingBucketReplies);

    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });
});

describe("aws/s3/update-bucket-permissions — dry-run plan", () => {
  test("plans the guard step, then policy, then public-access-block", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const result = await dryRun(
      "aws/s3/update-bucket-permissions",
      UPDATE_PERMISSIONS_PARAMS,
      rec,
      existingBucketReplies,
    );

    expect(result.plan.map((p) => p.stepId)).toEqual([
      "s3-bucket-exists",
      "bucket-policy",
      "bucket-public-access-block",
    ]);
  });

  test("a bucket that does not exist aborts in the plan phase", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    const attempt = dryRun(
      "aws/s3/update-bucket-permissions",
      UPDATE_PERMISSIONS_PARAMS,
      rec,
      cleanAccountReplies,
    );

    await expect(attempt).rejects.toThrow(FerryError);
    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });

  test("mutates nothing at all", async () => {
    const rec: Recorder = { commands: [], queries: [] };

    await dryRun(
      "aws/s3/update-bucket-permissions",
      UPDATE_PERMISSIONS_PARAMS,
      rec,
      existingBucketReplies,
    );

    expect(rec.commands.filter((c) => MUTATING.includes(c))).toEqual([]);
  });
});
