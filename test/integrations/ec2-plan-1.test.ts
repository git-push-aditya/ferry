import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { ec2LaunchStep } from "../../src/providers/aws";
import { groupStep } from "../../integrations/aws/ec2/create-security-group/steps/group";
import type { Params as GroupParams } from "../../integrations/aws/ec2/create-security-group/params";
import { reconcileRulesStep } from "../../integrations/aws/ec2/update-security-group-rules/steps/reconcile-rules";
import type { Params as RulesParams } from "../../integrations/aws/ec2/update-security-group-rules/params";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";

type LaunchParams = {
  LOGICAL_NAME: string;
  AMI_ID: string;
  INSTANCE_TYPE: string;
  SUBNET_ID: string;
  SECURITY_GROUP_IDS: string[];
  KEY_PAIR_NAME: string | undefined;
  CLIENT_TOKEN_OVERRIDE: string | undefined;
  TAGS: Record<string, string>;
};

/**
 * The former aws/ec2/launch-instance integration's step, now the shared
 * `ec2LaunchStep` factory. Wired here with the same accessors that
 * integration used, so this file keeps proving the same behavior.
 */
const launchStep = ec2LaunchStep<LaunchParams>({
  integrationId: "aws/ec2/launch-instance",
  logicalName: (p) => p.LOGICAL_NAME,
  amiId: (p) => p.AMI_ID,
  instanceType: (p) => p.INSTANCE_TYPE,
  subnetId: (p) => p.SUBNET_ID,
  securityGroupIds: (p) => p.SECURITY_GROUP_IDS,
  keyPairName: (p) => p.KEY_PAIR_NAME,
  clientTokenOverride: (p) => p.CLIENT_TOKEN_OVERRIDE,
  tags: (p) => p.TAGS,
});

const ACCOUNT = TEST_AWS_ACCOUNT;
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** dry-run context: check() only — create()/reconcile() must never be invoked by these tests. */
function ec2PlanCtx<P>(params: P, send: (command: Command) => unknown): StepContext<P> {
  const ec2 = {
    async send(command: Command) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: ec2, iam: ec2, sts: ec2, ec2, ssm: ec2, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs: {},
    dryRun: true,
    log: NO_LOG,
  };
}

describe("ec2 dry-run plan: launch-instance", () => {
  const params: LaunchParams = {
    LOGICAL_NAME: "web-1",
    AMI_ID: "ami-123",
    INSTANCE_TYPE: "t3.micro",
    SUBNET_ID: "subnet-123",
    SECURITY_GROUP_IDS: ["sg-1"],
    KEY_PAIR_NAME: undefined,
    CLIENT_TOKEN_OVERRIDE: undefined,
    TAGS: {},
  };

  test("no tagged instance found -> missing", async () => {
    const ctx = ec2PlanCtx(params, () => ({ Reservations: [] }));
    expect(await launchStep.check(ctx)).toBe("missing");
  });

  test("tagged instance already running -> exists", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      Reservations: [{ Instances: [{ State: { Name: "running" } }] }],
    }));
    expect(await launchStep.check(ctx)).toBe("exists");
  });
});

describe("ec2 dry-run plan: create-security-group", () => {
  const params: GroupParams = {
    GROUP_NAME: "web-sg",
    GROUP_DESCRIPTION: "web tier",
    VPC_ID: "vpc-1",
    INGRESS_RULES: [],
    EGRESS_RULES: [],
  };

  test("no group by that name/vpc -> missing", async () => {
    const ctx = ec2PlanCtx(params, () => ({ SecurityGroups: [] }));
    expect(await groupStep.check(ctx)).toBe("missing");
  });

  test("group exists, tagged ours -> exists", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      SecurityGroups: [
        { GroupId: "sg-1", Tags: [{ Key: "ferry:integration-id", Value: "aws/ec2/create-security-group" }] },
      ],
    }));
    expect(await groupStep.check(ctx)).toBe("exists");
  });

  test("group exists, untagged (name collision) -> conflict", async () => {
    const ctx = ec2PlanCtx(params, () => ({ SecurityGroups: [{ GroupId: "sg-1", Tags: [] }] }));
    expect(await groupStep.check(ctx)).toBe("conflict");
  });
});

describe("ec2 dry-run plan: update-security-group-rules", () => {
  const params: RulesParams = {
    GROUP_ID: "sg-123",
    DESIRED_INGRESS_RULES: [],
    DESIRED_EGRESS_RULES: [],
  };

  test("group exists -> missing (reconcile still needs to run)", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      SecurityGroups: [{ GroupId: "sg-123", IpPermissions: [], IpPermissionsEgress: [] }],
    }));
    expect(await reconcileRulesStep.check(ctx)).toBe("missing");
  });

  test("group doesn't exist -> conflict", async () => {
    const ctx = ec2PlanCtx(params, () => ({ SecurityGroups: [] }));
    expect(await reconcileRulesStep.check(ctx)).toBe("conflict");
  });
});

