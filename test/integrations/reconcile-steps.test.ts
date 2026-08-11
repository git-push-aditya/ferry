import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { accessKeyStep } from "../../integrations/aws/create-backend-s3-user/steps/access-key";
import type { Params as BackendParams } from "../../integrations/aws/create-backend-s3-user/params";
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
