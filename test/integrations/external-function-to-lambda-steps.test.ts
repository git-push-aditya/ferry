import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { apiRoleStep } from "../../integrations/snowflake/external-function-to-lambda/steps/api-role";
import { apiIntegrationStep } from "../../integrations/snowflake/external-function-to-lambda/steps/api-integration";
import { externalFunctionStep } from "../../integrations/snowflake/external-function-to-lambda/steps/external-function";
import { finalTrustPolicy, functionSignature } from "../../integrations/snowflake/external-function-to-lambda/params";
import type { Params } from "../../integrations/snowflake/external-function-to-lambda/params";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 400 } });
}

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function iamCtx(
  params: Params,
  outputs: Record<string, unknown>,
  send: (command: FakeCommand) => unknown,
): StepContext<Params> {
  const iam = {
    async send(command: FakeCommand) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: iam, iam, sts: iam, ec2: iam, ssm: iam, secretsManager: iam, ecr: iam, region: "us-east-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

function snowflakeCtx(
  params: Params,
  outputs: Record<string, unknown>,
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>,
): StepContext<Params> {
  const conn = { connection: {}, runQuery, close: async () => {} };
  return {
    params,
    creds: {},
    clients: { snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const PARAMS: Params = {
  SF_API_INTEGRATION_NAME: "ferry_api_int",
  AWS_API_ROLE_NAME: "ferry-api-role",
  API_GATEWAY_INVOKE_URL: "https://abc123.execute-api.us-east-1.amazonaws.com/prod/",
  SF_EXTERNAL_FUNCTION_NAME: "ferry_echo",
  SF_FUNCTION_ARG_TYPES: "VARCHAR",
  SF_FUNCTION_RETURNS: "VARCHAR",
  SMOKE_TEST_ARGS: "'hello'",
};

describe("external-function-to-lambda: apiRoleStep", () => {
  test("create() sends a placeholder trust policy trusting only this account's root", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(PARAMS, {}, (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === "GetRoleCommand") return awsError("NoSuchEntityException");
      return {};
    });
    expect(await apiRoleStep.check(ctx)).toBe("missing");
    const outputs = await apiRoleStep.create!(ctx);
    expect(outputs.apiRoleCreatedThisRun).toBe(true);
    const createCall = sent.find((c) => c.constructor.name === "CreateRoleCommand")!;
    const trust = JSON.parse(createCall.input.AssumeRolePolicyDocument as string);
    expect(trust.Statement[0].Principal).toEqual({ AWS: `arn:aws:iam::${ACCOUNT}:root` });
  });

  test("rollback() only deletes a role this run created", async () => {
    const sent: string[] = [];
    const notCreated = iamCtx(PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await apiRoleStep.rollback(notCreated);
    expect(sent).toEqual([]);

    const created = iamCtx(PARAMS, { apiRoleCreatedThisRun: true }, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await apiRoleStep.rollback(created);
    expect(sent).toEqual(["DeleteRoleCommand"]);
  });
});

describe("external-function-to-lambda: finalTrustPolicy", () => {
  test("gates the real principal on the external id", () => {
    const doc = finalTrustPolicy("arn:aws:iam::123:user/snowflake", "ext-id-123") as {
      Statement: { Principal: object; Condition: object }[];
    };
    expect(doc.Statement[0]!.Principal).toEqual({ AWS: "arn:aws:iam::123:user/snowflake" });
    expect(doc.Statement[0]!.Condition).toEqual({ StringEquals: { "sts:ExternalId": "ext-id-123" } });
  });
});

describe("external-function-to-lambda: apiIntegrationStep", () => {
  test("check() missing/exists via SHOW INTEGRATIONS exact match", async () => {
    const missing = snowflakeCtx(PARAMS, {}, async () => []);
    expect(await apiIntegrationStep.check(missing)).toBe("missing");

    const exists = snowflakeCtx(PARAMS, {}, async () => [{ name: "FERRY_API_INT" }]);
    expect(await apiIntegrationStep.check(exists)).toBe("exists");
  });

  test("create() uses CREATE ... IF NOT EXISTS, never CREATE OR REPLACE", async () => {
    const sent: string[] = [];
    const ctx = snowflakeCtx(PARAMS, {}, async (sql) => {
      sent.push(sql);
      return [];
    });
    await apiIntegrationStep.create!(ctx);
    expect(sent[0]).toContain("CREATE API INTEGRATION IF NOT EXISTS");
    expect(sent[0]).not.toContain("CREATE OR REPLACE");
  });
});

describe("external-function-to-lambda: externalFunctionStep", () => {
  test("functionSignature joins the name and arg types for DROP FUNCTION", () => {
    expect(functionSignature(PARAMS)).toBe("ferry_echo(VARCHAR)");
  });

  test("rollback() drops using the full signature, only if this run created it", async () => {
    const sent: string[] = [];
    const ctx = snowflakeCtx(PARAMS, { externalFunctionCreatedThisRun: true }, async (sql) => {
      sent.push(sql);
      return [];
    });
    await externalFunctionStep.rollback(ctx);
    expect(sent).toEqual(["DROP FUNCTION IF EXISTS ferry_echo(VARCHAR);"]);
  });
});
