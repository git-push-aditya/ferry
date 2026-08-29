import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { executionRoleStep } from "../../integrations/github/cloudformation-deploy-role-for-actions/steps/execution-role";
import { ciRoleCfnPolicyDocument } from "../../integrations/github/cloudformation-deploy-role-for-actions/params";
import type { Params } from "../../integrations/github/cloudformation-deploy-role-for-actions/params";
import { iamConvergePolicyAttachmentsStep } from "../../src/providers/aws";

const executionPoliciesStep = iamConvergePolicyAttachmentsStep<Params>({
  roleName: (p) => p.CFN_EXECUTION_ROLE_NAME,
  desiredArns: (p) => p.EXECUTION_POLICY_ARNS,
});

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

const PARAMS: Params = {
  AWS_ROLE_NAME: "ferry-ci-role",
  CFN_EXECUTION_ROLE_NAME: "ferry-cfn-exec",
  EXECUTION_POLICY_ARNS: ["arn:aws:iam::aws:policy/AmazonS3FullAccess"],
  STACK_NAME_PREFIX: "myapp-",
  ALLOW_DESTRUCTIVE_ROLLBACK: false,
};

describe("cloudformation-deploy-role-for-actions: executionRoleStep", () => {
  test("check() missing -> create() sends CreateRoleCommand trusting cloudformation.amazonaws.com", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(PARAMS, {}, (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === "GetRoleCommand") return awsError("NoSuchEntityException");
      if (cmd.constructor.name === "CreateRoleCommand") return { Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/ferry-cfn-exec` } };
      return {};
    });
    expect(await executionRoleStep.check(ctx)).toBe("missing");
    const outputs = await executionRoleStep.create!(ctx);
    expect(outputs.executionRoleCreatedThisRun).toBe(true);
    const createCall = sent.find((c) => c.constructor.name === "CreateRoleCommand")!;
    const trust = JSON.parse(createCall.input.AssumeRolePolicyDocument as string);
    expect(trust.Statement[0].Principal).toEqual({ Service: "cloudformation.amazonaws.com" });
  });

  test("rollback() is a no-op without ALLOW_DESTRUCTIVE_ROLLBACK, even for a role this run created", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(PARAMS, { executionRoleCreatedThisRun: true }, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await executionRoleStep.rollback(ctx);
    expect(sent).toEqual([]);
  });

  test("rollback() deletes the role when ALLOW_DESTRUCTIVE_ROLLBACK=true and this run created it", async () => {
    const sent: string[] = [];
    const ctx = iamCtx({ ...PARAMS, ALLOW_DESTRUCTIVE_ROLLBACK: true }, { executionRoleCreatedThisRun: true }, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await executionRoleStep.rollback(ctx);
    expect(sent).toEqual(["DeleteRoleCommand"]);
  });
});

describe("cloudformation-deploy-role-for-actions: executionPoliciesStep", () => {
  test("reconcile() attaches missing and detaches extra policies to match exactly", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(PARAMS, {}, (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") {
        return { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }] };
      }
      return {};
    });
    const outputs = await executionPoliciesStep.reconcile!(ctx);
    expect(JSON.parse(outputs.executedAttach as string)).toEqual([
      "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    ]);
    expect(JSON.parse(outputs.executedDetach as string)).toEqual([
      "arn:aws:iam::aws:policy/AdministratorAccess",
    ]);
  });

  test("reconcile() is a no-op when the attached set already matches", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(PARAMS, {}, (cmd) => {
      sent.push(cmd);
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") {
        return { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AmazonS3FullAccess" }] };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    await executionPoliciesStep.reconcile!(ctx);
    expect(sent).toHaveLength(1);
  });
});

describe("cloudformation-deploy-role-for-actions: CI role policy document", () => {
  test("scopes cloudformation:* to the stack-name-prefix ARN and PassRole to the execution role, gated on PassedToService", () => {
    const doc = ciRoleCfnPolicyDocument(ACCOUNT, "us-east-1", PARAMS) as {
      Statement: { Sid: string; Resource: string; Condition?: object }[];
    };
    const cfnStmt = doc.Statement.find((s) => s.Sid === "CloudFormationDeploy");
    const passRoleStmt = doc.Statement.find((s) => s.Sid === "PassExecutionRoleToCloudFormation");
    expect(cfnStmt?.Resource).toBe(`arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/myapp-*/*`);
    expect(passRoleStmt?.Resource).toBe(`arn:aws:iam::${ACCOUNT}:role/ferry-cfn-exec`);
    expect(passRoleStmt?.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
    });
  });
});
