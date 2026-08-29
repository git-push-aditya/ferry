import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { ecrRepoStep } from "../../integrations/github/ecr-push-access-for-actions/steps/ecr-repo";
import { ecrPushPolicyDocument, inlinePolicyName } from "../../integrations/github/ecr-push-access-for-actions/params";
import type { Params } from "../../integrations/github/ecr-push-access-for-actions/params";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 400 } });
}

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function ecrCtx(
  params: Params,
  outputs: Record<string, unknown>,
  send: (command: FakeCommand) => unknown,
): StepContext<Params> {
  const ecr = {
    async send(command: FakeCommand) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: ecr, iam: ecr, sts: ecr, ec2: ecr, ssm: ecr, secretsManager: ecr, ecr, region: "us-east-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const PARAMS: Params = {
  AWS_ROLE_NAME: "ferry-ci-role",
  ECR_REPOSITORY_NAME: "myapp",
  IMAGE_TAG_MUTABILITY: "IMMUTABLE",
  ALLOW_DESTRUCTIVE_ROLLBACK: false,
};

describe("ecr-push-access-for-actions: ecrRepoStep", () => {
  test("check() missing when RepositoryNotFoundException", async () => {
    const ctx = ecrCtx(PARAMS, {}, () => awsError("RepositoryNotFoundException"));
    expect(await ecrRepoStep.check(ctx)).toBe("missing");
  });

  test("check() exists when DescribeRepositories succeeds", async () => {
    const ctx = ecrCtx(PARAMS, {}, () => ({ repositories: [{ repositoryName: "myapp" }] }));
    expect(await ecrRepoStep.check(ctx)).toBe("exists");
  });

  test("create() sends CreateRepositoryCommand with the requested mutability", async () => {
    const sent: FakeCommand[] = [];
    const ctx = ecrCtx(PARAMS, {}, (cmd) => {
      sent.push(cmd);
      return {};
    });
    const outputs = await ecrRepoStep.create!(ctx);
    expect(outputs.ecrRepoCreatedThisRun).toBe(true);
    expect(sent[0]!.constructor.name).toBe("CreateRepositoryCommand");
    expect(sent[0]!.input).toEqual({ repositoryName: "myapp", imageTagMutability: "IMMUTABLE" });
  });

  test("rollback() is a no-op without ALLOW_DESTRUCTIVE_ROLLBACK, even for a repo this run created", async () => {
    const sent: string[] = [];
    const ctx = ecrCtx(PARAMS, { ecrRepoCreatedThisRun: true }, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await ecrRepoStep.rollback(ctx);
    expect(sent).toEqual([]);
  });

  test("rollback() deletes the repo when ALLOW_DESTRUCTIVE_ROLLBACK=true and this run created it", async () => {
    const sent: FakeCommand[] = [];
    const ctx = ecrCtx(
      { ...PARAMS, ALLOW_DESTRUCTIVE_ROLLBACK: true },
      { ecrRepoCreatedThisRun: true },
      (cmd) => {
        sent.push(cmd);
        return {};
      },
    );
    await ecrRepoStep.rollback(ctx);
    expect(sent[0]!.constructor.name).toBe("DeleteRepositoryCommand");
    expect(sent[0]!.input).toEqual({ repositoryName: "myapp", force: true });
  });

  test("rollback() never deletes a pre-existing repo this run did not create", async () => {
    const sent: string[] = [];
    const ctx = ecrCtx({ ...PARAMS, ALLOW_DESTRUCTIVE_ROLLBACK: true }, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await ecrRepoStep.rollback(ctx);
    expect(sent).toEqual([]);
  });
});

describe("ecr-push-access-for-actions: policy document", () => {
  test("hardcodes GetAuthorizationToken to Resource '*' and scopes push actions to the repo ARN", () => {
    const doc = ecrPushPolicyDocument(ACCOUNT, "us-east-1", "myapp") as {
      Statement: { Sid: string; Resource: string }[];
    };
    const authStmt = doc.Statement.find((s) => s.Sid === "EcrAuthToken");
    const pushStmt = doc.Statement.find((s) => s.Sid === "EcrPushToRepo");
    expect(authStmt?.Resource).toBe("*");
    expect(pushStmt?.Resource).toBe(`arn:aws:ecr:us-east-1:${ACCOUNT}:repository/myapp`);
  });

  test("inlinePolicyName is deterministic per repository", () => {
    expect(inlinePolicyName("myapp")).toBe("ferry-ecr-push-myapp");
  });
});
