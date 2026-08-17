import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { loadEnvLayers, parseEnvFile } from "../../src/core/env";
import { FerryError } from "../../src/core/errors";
import { allCredentialKeys } from "../../src/core/provider";
import backendIntegration from "../../integrations/aws/s3/create-backend-s3-user/integration";
import storageIntegration from "../../integrations/snowflake/create-storage-s3-integration/integration";
import { awsCredentialsSchema } from "../../src/providers/aws";
import { snowflakeCredentialsSchema } from "../../src/providers/snowflake";
import { providers } from "../../src/providers/registry";

const CREDENTIAL_KEYS = allCredentialKeys(providers);

// The composed schemas the engine builds for each integration's declared
// credential kinds. `aws/s3/create-backend-s3-user` declares ["aws"] only, which is why
// it never asks for a Snowflake variable.
const INTEGRATION_CREDS = z.intersection(awsCredentialsSchema, snowflakeCredentialsSchema);
const BACKEND_CREDS = awsCredentialsSchema;

const VALID_AWS_CREDS = {
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_REGION: "us-east-1",
};

const VALID_SNOWFLAKE_CREDS = {
  SNOWFLAKE_ACCOUNT: "acct",
  SNOWFLAKE_USERNAME: "svc_user",
  SNOWFLAKE_PASSWORD: "pw",
  SNOWFLAKE_ROLE: "ACCOUNTADMIN",
  SNOWFLAKE_WAREHOUSE: "wh",
  SNOWFLAKE_DATABASE: "db",
  SNOWFLAKE_SCHEMA: "public",
};

const VALID_INTEGRATION_PARAMS = {
  EXPORT_S3_BUCKET: "my-bucket",
  EXPORT_S3_PREFIX: "snowflake/",
  SF_STORAGE_INTEGRATION_NAME: "s3_export_int",
  SF_STAGE_NAME: "csv_stage",
  AWS_STORAGE_ROLE_NAME: "snowflake-role",
  AWS_STORAGE_POLICY_NAME: "snowflake-policy",
};

const VALID_BACKEND_PARAMS = {
  EXPORT_S3_BUCKET: "my-bucket",
  EXPORT_S3_PREFIX: "snowflake/",
  BACKEND_IAM_USER_NAME: "backend-user",
  BACKEND_IAM_POLICY_NAME: "backend-policy",
};

let originalExit: typeof process.exit;
let exitCode: number | undefined;

beforeEach(() => {
  originalExit = process.exit;
  exitCode = undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
});

function loadIntegrationEnv(
  creds: Record<string, string | undefined>,
  params: Record<string, string> = VALID_INTEGRATION_PARAMS,
) {
  return loadEnvLayers({
    credentialSource: creds,
    folderSource: params,
    folderEnvPath: "integrations/snowflake/create-storage-s3-integration/.env",
    credentialKeys: CREDENTIAL_KEYS,
    credentialSchema: INTEGRATION_CREDS,
    paramsSchema: storageIntegration.params,
  });
}

function loadBackendEnv(
  creds: Record<string, string | undefined>,
  params: Record<string, string> = VALID_BACKEND_PARAMS,
) {
  return loadEnvLayers({
    credentialSource: creds,
    folderSource: params,
    folderEnvPath: "integrations/aws/s3/create-backend-s3-user/.env",
    credentialKeys: CREDENTIAL_KEYS,
    credentialSchema: BACKEND_CREDS,
    paramsSchema: backendIntegration.params,
  });
}

const ALL_INTEGRATION_CREDS = { ...VALID_AWS_CREDS, ...VALID_SNOWFLAKE_CREDS };

describe("snowflake/create-storage-s3-integration env", () => {
  test("accepts a fully valid environment", () => {
    const { creds, params } = loadIntegrationEnv(ALL_INTEGRATION_CREDS);
    expect(params.EXPORT_S3_BUCKET).toBe("my-bucket");
    expect(params.SF_STAGE_NAME).toBe("csv_stage");
    expect(creds.AWS_REGION).toBe("us-east-1");
  });

  test("exits non-zero and lists every missing key when env is empty", () => {
    expect(() => loadIntegrationEnv({}, {})).toThrow();
    expect(exitCode).toBe(1);
  });

  test("accepts SNOWFLAKE_PRIVATE_KEY in place of SNOWFLAKE_PASSWORD", () => {
    const { SNOWFLAKE_PASSWORD, ...rest } = ALL_INTEGRATION_CREDS;
    const { creds } = loadIntegrationEnv({
      ...rest,
      SNOWFLAKE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
    });
    expect(creds.SNOWFLAKE_PRIVATE_KEY).toBeDefined();
  });

  test("rejects when neither SNOWFLAKE_PASSWORD nor SNOWFLAKE_PRIVATE_KEY is set", () => {
    const { SNOWFLAKE_PASSWORD, ...rest } = ALL_INTEGRATION_CREDS;
    expect(() => loadIntegrationEnv(rest)).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_PREFIX that does not end with '/'", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        EXPORT_S3_PREFIX: "snowflake",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_BUCKET with an s3:// prefix", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        EXPORT_S3_BUCKET: "s3://my-bucket",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_BUCKET with a trailing slash", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        EXPORT_S3_BUCKET: "my-bucket/",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects a blank required value, not just a missing one", () => {
    expect(() =>
      loadIntegrationEnv({ ...ALL_INTEGRATION_CREDS, SNOWFLAKE_WAREHOUSE: "" }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects a hyphen in SF_STORAGE_INTEGRATION_NAME — Snowflake reads '-' as subtraction, not a name", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        SF_STORAGE_INTEGRATION_NAME: "my-integration",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects a hyphen in SF_STAGE_NAME", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        SF_STAGE_NAME: "my-stage",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an identifier starting with a digit", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        SF_STAGE_NAME: "1stage",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("accepts underscores in SF_STORAGE_INTEGRATION_NAME / SF_STAGE_NAME", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        SF_STORAGE_INTEGRATION_NAME: "testing_script_integration_sf",
        SF_STAGE_NAME: "testing_script_stage_sf",
      }),
    ).not.toThrow();
  });
});

describe("aws/s3/create-backend-s3-user env", () => {
  test("accepts a fully valid environment", () => {
    const { params } = loadBackendEnv(VALID_AWS_CREDS);
    expect(params.BACKEND_IAM_USER_NAME).toBe("backend-user");
  });

  test("does not require any Snowflake variables", () => {
    expect(() => loadBackendEnv(VALID_AWS_CREDS)).not.toThrow();
  });

  test("exits non-zero and lists every missing key when env is empty", () => {
    expect(() => loadBackendEnv({}, {})).toThrow();
    expect(exitCode).toBe(1);
  });

  test("rejects an EXPORT_S3_PREFIX that does not end with '/'", () => {
    expect(() =>
      loadBackendEnv(VALID_AWS_CREDS, {
        ...VALID_BACKEND_PARAMS,
        EXPORT_S3_PREFIX: "no-trailing-slash",
      }),
    ).toThrow();
    expect(exitCode).toBe(1);
  });
});

describe("layering: root credentials vs folder params", () => {
  test("a folder .env may not set a credential key", () => {
    expect(() =>
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        AWS_ACCESS_KEY_ID: "AKIA_SNEAKY",
      }),
    ).toThrow(FerryError);
  });

  test("the error names the offending key and the file it came from", () => {
    try {
      loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
        ...VALID_INTEGRATION_PARAMS,
        SNOWFLAKE_PASSWORD: "hunter2",
      });
      throw new Error("expected loadEnvLayers to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(FerryError);
      const details = (err as FerryError).details.join("\n");
      expect(details).toContain("SNOWFLAKE_PASSWORD");
      expect(details).toContain("integrations/snowflake/create-storage-s3-integration/.env");
    }
  });

  test("rejects a credential key belonging to a provider this integration does not even declare", () => {
    // The backend integration declares ["aws"], but a Snowflake key in its
    // folder .env is still an error — the rule is registry-wide, not per-run.
    expect(() =>
      loadBackendEnv(VALID_AWS_CREDS, {
        ...VALID_BACKEND_PARAMS,
        SNOWFLAKE_ACCOUNT: "acct",
      }),
    ).toThrow(FerryError);
  });

  test("params are never inherited from the root layer", () => {
    // Every param present in the credential source and absent from the folder
    // source — the loader must still fail, not silently pick them up.
    expect(() =>
      loadIntegrationEnv({ ...ALL_INTEGRATION_CREDS, ...VALID_INTEGRATION_PARAMS }, {}),
    ).toThrow();
    expect(exitCode).toBe(1);
  });

  test("credentials are never read from the folder layer", () => {
    expect(() => loadIntegrationEnv({}, VALID_INTEGRATION_PARAMS)).toThrow();
    expect(exitCode).toBe(1);
  });

  test("lists offending keys from BOTH layers in one pass", () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      expect(() => loadIntegrationEnv({}, {})).toThrow();
    } finally {
      console.error = originalError;
    }
    const output = lines.join("\n");
    expect(output).toContain("AWS_ACCESS_KEY_ID");
    expect(output).toContain("SF_STAGE_NAME");
  });

  test("two integrations each declaring EXPORT_S3_BUCKET stay independent", () => {
    const a = loadIntegrationEnv(ALL_INTEGRATION_CREDS, {
      ...VALID_INTEGRATION_PARAMS,
      EXPORT_S3_BUCKET: "bucket-a",
    });
    const b = loadBackendEnv(VALID_AWS_CREDS, {
      ...VALID_BACKEND_PARAMS,
      EXPORT_S3_BUCKET: "bucket-b",
    });
    expect(a.params.EXPORT_S3_BUCKET).toBe("bucket-a");
    expect(b.params.EXPORT_S3_BUCKET).toBe("bucket-b");
  });
});

describe("parseEnvFile", () => {
  test("reads plain KEY=value lines", () => {
    expect(parseEnvFile("A=1\nB=two\n")).toEqual({ A: "1", B: "two" });
  });

  test("ignores blank lines and comments", () => {
    expect(parseEnvFile("# a comment\n\nA=1\n")).toEqual({ A: "1" });
  });

  test("strips an `export ` prefix", () => {
    expect(parseEnvFile("export A=1\n")).toEqual({ A: "1" });
  });

  test("strips surrounding quotes and keeps inner '#'", () => {
    expect(parseEnvFile('A="a#b"\n')).toEqual({ A: "a#b" });
  });

  test("drops an unquoted trailing comment", () => {
    expect(parseEnvFile("A=value # trailing\n")).toEqual({ A: "value" });
  });

  test("keeps a value containing '=' intact", () => {
    expect(parseEnvFile("A=SFCRole=1_abc=\n")).toEqual({ A: "SFCRole=1_abc=" });
  });
});
