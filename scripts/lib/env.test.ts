import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadBackendEnv, loadIntegrationEnv } from "./env";

const VALID_INTEGRATION_ENV = {
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_REGION: "us-east-1",
  EXPORT_S3_BUCKET: "my-bucket",
  EXPORT_S3_PREFIX: "snowflake/",
  SNOWFLAKE_ACCOUNT: "acct",
  SNOWFLAKE_USERNAME: "svc_user",
  SNOWFLAKE_PASSWORD: "pw",
  SNOWFLAKE_ROLE: "ACCOUNTADMIN",
  SNOWFLAKE_WAREHOUSE: "wh",
  SNOWFLAKE_DATABASE: "db",
  SNOWFLAKE_SCHEMA: "public",
  SF_STORAGE_INTEGRATION_NAME: "s3_export_int",
  SF_STAGE_NAME: "csv_stage",
  AWS_STORAGE_ROLE_NAME: "snowflake-role",
  AWS_STORAGE_POLICY_NAME: "snowflake-policy",
};

const VALID_BACKEND_ENV = {
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_REGION: "us-east-1",
  EXPORT_S3_BUCKET: "my-bucket",
  EXPORT_S3_PREFIX: "snowflake/",
  BACKEND_IAM_USER_NAME: "backend-user",
  BACKEND_IAM_POLICY_NAME: "backend-policy",
};

let originalEnv: NodeJS.ProcessEnv;
let originalExit: typeof process.exit;
let exitCode: number | undefined;

beforeEach(() => {
  originalEnv = { ...process.env };
  originalExit = process.exit;
  exitCode = undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.env = originalEnv;
  process.exit = originalExit;
});

function setEnv(vars: Record<string, string | undefined>): void {
  process.env = { ...vars } as NodeJS.ProcessEnv;
}

describe("loadIntegrationEnv", () => {
  test("accepts a fully valid environment", () => {
    setEnv(VALID_INTEGRATION_ENV);
    const env = loadIntegrationEnv();
    expect(env.EXPORT_S3_BUCKET).toBe("my-bucket");
    expect(env.SF_STAGE_NAME).toBe("csv_stage");
  });

  test("exits non-zero and lists every missing key when env is empty", () => {
    setEnv({});
    expect(() => loadIntegrationEnv()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("accepts SNOWFLAKE_PRIVATE_KEY in place of SNOWFLAKE_PASSWORD", () => {
    const { SNOWFLAKE_PASSWORD, ...rest } = VALID_INTEGRATION_ENV;
    setEnv({ ...rest, SNOWFLAKE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" });
    const env = loadIntegrationEnv();
    expect(env.SNOWFLAKE_PRIVATE_KEY).toBeDefined();
  });

  test("rejects when neither SNOWFLAKE_PASSWORD nor SNOWFLAKE_PRIVATE_KEY is set", () => {
    const { SNOWFLAKE_PASSWORD, ...rest } = VALID_INTEGRATION_ENV;
    setEnv(rest);
    expect(() => loadIntegrationEnv()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_PREFIX that does not end with '/'", () => {
    setEnv({ ...VALID_INTEGRATION_ENV, EXPORT_S3_PREFIX: "snowflake" });
    expect(() => loadIntegrationEnv()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_BUCKET with an s3:// prefix", () => {
    setEnv({ ...VALID_INTEGRATION_ENV, EXPORT_S3_BUCKET: "s3://my-bucket" });
    expect(() => loadIntegrationEnv()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_BUCKET with a trailing slash", () => {
    setEnv({ ...VALID_INTEGRATION_ENV, EXPORT_S3_BUCKET: "my-bucket/" });
    expect(() => loadIntegrationEnv()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects a blank required value, not just a missing one", () => {
    setEnv({ ...VALID_INTEGRATION_ENV, SNOWFLAKE_WAREHOUSE: "" });
    expect(() => loadIntegrationEnv()).toThrow();
    expect(exitCode).toBe(1);
  });
});

describe("loadBackendEnv", () => {
  test("accepts a fully valid environment", () => {
    setEnv(VALID_BACKEND_ENV);
    const env = loadBackendEnv();
    expect(env.BACKEND_IAM_USER_NAME).toBe("backend-user");
  });

  test("does not require any Snowflake variables", () => {
    setEnv(VALID_BACKEND_ENV);
    expect(() => loadBackendEnv()).not.toThrow();
  });

  test("exits non-zero and lists every missing key when env is empty", () => {
    setEnv({});
    expect(() => loadBackendEnv()).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_PREFIX that does not end with '/'", () => {
    setEnv({ ...VALID_BACKEND_ENV, EXPORT_S3_PREFIX: "no-trailing-slash" });
    expect(() => loadBackendEnv()).toThrow();
    expect(exitCode).toBe(1);
  });
});
