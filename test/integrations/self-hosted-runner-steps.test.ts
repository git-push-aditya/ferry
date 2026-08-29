import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { jitConfigStep } from "../../integrations/github/self-hosted-runner-registration/steps/jit-config";
import { launchStep } from "../../integrations/github/self-hosted-runner-registration/steps/launch";
import type { Params } from "../../integrations/github/self-hosted-runner-registration/params";
import { fakeGithubClient, NO_LOG, type Call, type FakeHandler } from "../helpers/github-fake-client";
import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";

const PARAMS: Params = {
  SCOPE: "repo",
  OWNER: "acme",
  REPO: "widgets",
  ORG: undefined,
  RUNNER_NAME: "runner-1",
  RUNNER_LABELS: ["self-hosted", "linux"],
  RUNNER_GROUP_ID: 1,
  AMI_ID: "ami-123",
  INSTANCE_TYPE: "t3.medium",
  SUBNET_ID: "subnet-1",
  SECURITY_GROUP_IDS: ["sg-1"],
  KEY_PAIR_NAME: undefined,
  RUNNER_DIR: "/opt/actions-runner",
  RUNNER_USER: "ec2-user",
  IAM_ROLE_NAME: "runner-role",
  IAM_INSTANCE_PROFILE_NAME: "runner-profile",
};

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** ctx with both providers wired to fakes — this integration needs aws AND github. */
function bothCtx(
  outputs: Record<string, unknown>,
  handle: FakeHandler,
  send: (command: Command) => unknown,
  calls: Call[] = [],
  sent: Command[] = [],
): StepContext<Params> {
  return {
    params: PARAMS,
    creds: {},
    clients: {
      github: { rest: fakeGithubClient(handle, calls) },
      aws: (() => {
        const client = {
          async send(command: Command) {
            sent.push(command);
            const reply = send(command);
            if (reply instanceof Error) throw reply;
            return reply ?? {};
          },
        };
        // This integration spans EC2 and IAM, so every AWS client the steps
        // reach for has to be wired, not just ec2.
        return { ec2: client, iam: client, s3: client, sts: client, region: "ap-south-1" };
      })(),
    },
    accountId: TEST_AWS_ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  } as unknown as StepContext<Params>;
}

const NO_RUNNERS: FakeHandler = (method, path) => {
  if (method === "GET" && path.startsWith("/repos/acme/widgets/actions/runners?")) {
    return { status: 200, data: { total_count: 0, runners: [] } };
  }
  return { status: 404 };
};

describe("self-hosted-runner-registration — jit-config step", () => {
  test("check() reports missing when no runner has that name", async () => {
    const ctx = bothCtx({}, NO_RUNNERS, () => ({}));
    expect(await jitConfigStep.check(ctx)).toBe("missing");
  });

  test("check() reports exists when a runner with that name is registered", async () => {
    const ctx = bothCtx({}, (method, path) => {
      if (method === "GET" && path.includes("/actions/runners?")) {
        return {
          status: 200,
          data: { total_count: 1, runners: [{ id: 7, name: "runner-1", status: "online", busy: false, labels: [] }] },
        };
      }
      return { status: 404 };
    }, () => ({}));
    expect(await jitConfigStep.check(ctx)).toBe("exists");
  });

  /**
   * The load-bearing test for this integration. generate-jitconfig is mutating
   * and single-use; the engine calls check() during --dry-run, so a check()
   * that touched it would register a real runner while planning.
   */
  test("check() NEVER calls generate-jitconfig", async () => {
    const calls: Call[] = [];
    const ctx = bothCtx({}, NO_RUNNERS, () => ({}), calls);
    await jitConfigStep.check(ctx);
    expect(calls.some((c) => c.path.includes("generate-jitconfig"))).toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("create() posts to generate-jitconfig and captures the runner id", async () => {
    const calls: Call[] = [];
    const ctx = bothCtx({}, (method, path) => {
      if (method === "POST" && path.endsWith("/generate-jitconfig")) {
        return {
          status: 201,
          data: {
            encoded_jit_config: "BASE64CONFIG",
            runner: { id: 42, name: "runner-1", status: "offline", busy: false, labels: [] },
          },
        };
      }
      return { status: 404 };
    }, () => ({}), calls);

    const outputs = await jitConfigStep.create!(ctx);
    expect(outputs).toEqual({ runnerId: 42, runnerJitConfig: "BASE64CONFIG" });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/repos/acme/widgets/actions/runners/generate-jitconfig");
    expect(post.body).toMatchObject({ name: "runner-1", runner_group_id: 1, labels: ["self-hosted", "linux"] });
  });

  test("rollback() deregisters the runner this run created", async () => {
    const calls: Call[] = [];
    const ctx = bothCtx({ runnerId: 42 }, () => ({ status: 204 }), () => ({}), calls);
    await jitConfigStep.rollback!(ctx);
    expect(calls).toContainEqual({ method: "DELETE", path: "/repos/acme/widgets/actions/runners/42", body: undefined });
  });

  test("rollback() is a no-op when this run registered nothing", async () => {
    const calls: Call[] = [];
    const ctx = bothCtx({}, () => ({ status: 204 }), () => ({}), calls);
    await jitConfigStep.rollback!(ctx);
    expect(calls).toEqual([]);
  });
});

describe("self-hosted-runner-registration — launch step", () => {
  test("create() passes the JIT config as base64 UserData and attaches the instance profile", async () => {
    const sent: Command[] = [];
    const ctx = bothCtx(
      { runnerJitConfig: "BASE64CONFIG", instanceProfileArn: "arn:aws:iam::123:instance-profile/runner-profile" },
      () => ({ status: 404 }),
      (cmd) => {
        if (cmd.constructor.name === "RunInstancesCommand") {
          return { Instances: [{ InstanceId: "i-new", PrivateIpAddress: "10.0.0.5", Placement: { AvailabilityZone: "us-east-1a" } }] };
        }
        if (cmd.constructor.name === "DescribeInstancesCommand") {
          return { Reservations: [{ Instances: [{ State: { Name: "running" }, PrivateIpAddress: "10.0.0.5", Placement: { AvailabilityZone: "us-east-1a" } }] }] };
        }
        return {};
      },
      [],
      sent,
    );

    const outputs = await launchStep.create!(ctx);
    expect(outputs.instanceId).toBe("i-new");

    const run = sent.find((c) => c.constructor.name === "RunInstancesCommand")!;
    expect(run.input.IamInstanceProfile).toEqual({ Arn: "arn:aws:iam::123:instance-profile/runner-profile" });

    const userData = Buffer.from(String(run.input.UserData), "base64").toString("utf-8");
    expect(userData).toContain("./run.sh --jitconfig 'BASE64CONFIG'");
    expect(userData).toContain("cd /opt/actions-runner");
    expect(userData).toContain("sudo -u ec2-user");
  });

  test("check() matches on this integration's own tag pair, not launch-instance's", async () => {
    const sent: Command[] = [];
    const ctx = bothCtx({}, () => ({ status: 404 }), () => ({ Reservations: [] }), [], sent);
    await launchStep.check(ctx);

    const describe_ = sent.find((c) => c.constructor.name === "DescribeInstancesCommand")!;
    const filters = describe_.input.Filters as Array<{ Name: string; Values: string[] }>;
    expect(filters).toContainEqual({
      Name: "tag:ferry:integration-id",
      Values: ["github/self-hosted-runner-registration"],
    });
  });
});

/**
 * The dry-run guarantee, at the level this integration's siblings test it:
 * running every step's check() must issue no mutating call to either provider.
 * The GitHub half matters most here — generate-jitconfig is mutating, single-
 * use, and irreversible.
 */
describe("self-hosted-runner-registration — dry-run plan", () => {
  const MUTATING_AWS = [
    "RunInstancesCommand",
    "TerminateInstancesCommand",
    "CreateInstanceProfileCommand",
    "DeleteInstanceProfileCommand",
    "AddRoleToInstanceProfileCommand",
    "RemoveRoleFromInstanceProfileCommand",
    "CreateRoleCommand",
    "DeleteRoleCommand",
  ];

  test("every step's check() mutates nothing, on either provider", async () => {
    const calls: Call[] = [];
    const sent: Command[] = [];

    const noSuchEntity = Object.assign(new Error("NoSuchEntityException"), {
      name: "NoSuchEntityException",
    });

    const ctx = bothCtx(
      {},
      NO_RUNNERS,
      (cmd) => {
        if (cmd.constructor.name === "DescribeInstancesCommand") return { Reservations: [] };
        if (cmd.constructor.name === "GetInstanceProfileCommand") return noSuchEntity;
        if (cmd.constructor.name === "GetRoleCommand") return noSuchEntity;
        return {};
      },
      calls,
      sent,
    );

    const { instanceProfileStep, instanceRoleStep } = await import(
      "../../integrations/github/self-hosted-runner-registration/steps/instance-role"
    );

    for (const step of [instanceRoleStep, instanceProfileStep, jitConfigStep, launchStep]) {
      expect(await step.check(ctx)).toBe("missing");
    }

    expect(sent.map((c) => c.constructor.name).filter((n) => MUTATING_AWS.includes(n))).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(calls.some((c) => c.path.includes("generate-jitconfig"))).toBe(false);
  });
});
