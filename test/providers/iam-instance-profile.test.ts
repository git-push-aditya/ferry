import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { iamInstanceProfileStep } from "../../src/providers/aws";
import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";

const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };
type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

type P = { PROFILE: string; ROLE: string };
const PARAMS: P = { PROFILE: "runner-profile", ROLE: "runner-role" };

function iamCtx(
  outputs: Record<string, unknown>,
  send: (command: FakeCommand) => unknown,
  sent: FakeCommand[] = [],
): StepContext<P> {
  const iam = {
    async send(command: FakeCommand) {
      sent.push(command);
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params: PARAMS,
    creds: {},
    clients: { aws: { s3: iam, iam, sts: iam, region: "ap-south-1" } },
    accountId: TEST_AWS_ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  } as unknown as StepContext<P>;
}

const step = iamInstanceProfileStep<P>({
  profileName: (p) => p.PROFILE,
  roleName: (p) => p.ROLE,
});

function noSuchEntity() {
  const err = new Error("not found") as Error & { name: string };
  err.name = "NoSuchEntityException";
  return err;
}

describe("iamInstanceProfileStep", () => {
  test("check() reports missing when the profile does not exist", async () => {
    const ctx = iamCtx({}, () => noSuchEntity());
    expect(await step.check(ctx)).toBe("missing");
  });

  /**
   * A profile with no role in it is useless, so a half-finished earlier run
   * (or one made by hand in the console) must not read as done.
   */
  test("check() reports missing when the profile exists but has no role attached", async () => {
    const ctx = iamCtx({}, () => ({
      InstanceProfile: { Arn: "arn:aws:iam::x:instance-profile/runner-profile", Roles: [] },
    }));
    expect(await step.check(ctx)).toBe("missing");
  });

  test("check() reports exists only when the profile holds the role", async () => {
    const ctx = iamCtx({}, () => ({
      InstanceProfile: {
        Arn: "arn:aws:iam::x:instance-profile/runner-profile",
        Roles: [{ RoleName: "runner-role" }],
      },
    }));
    expect(await step.check(ctx)).toBe("exists");
  });

  test("create() creates the profile then attaches the role", async () => {
    const sent: FakeCommand[] = [];
    let created = false;
    const ctx = iamCtx(
      {},
      (cmd) => {
        if (cmd.constructor.name === "GetInstanceProfileCommand") {
          if (!created) return noSuchEntity();
          return { InstanceProfile: { Arn: "arn:profile", Roles: [] } };
        }
        if (cmd.constructor.name === "CreateInstanceProfileCommand") {
          created = true;
          return { InstanceProfile: { Arn: "arn:profile" } };
        }
        return {};
      },
      sent,
    );

    const outputs = await step.create!(ctx);
    expect(outputs).toMatchObject({
      instanceProfileArn: "arn:profile",
      instanceProfileName: "runner-profile",
      instanceProfileCreatedThisRun: true,
    });

    const names = sent.map((c) => c.constructor.name);
    expect(names.indexOf("CreateInstanceProfileCommand")).toBeLessThan(
      names.indexOf("AddRoleToInstanceProfileCommand"),
    );
  });

  test("create() tolerates a pre-existing profile and only attaches the role", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(
      {},
      () => ({ InstanceProfile: { Arn: "arn:existing", Roles: [] } }),
      sent,
    );

    const outputs = await step.create!(ctx);
    expect(outputs.instanceProfileCreatedThisRun).toBe(false);
    expect(sent.map((c) => c.constructor.name)).not.toContain("CreateInstanceProfileCommand");
    expect(sent.map((c) => c.constructor.name)).toContain("AddRoleToInstanceProfileCommand");
  });

  /** AWS refuses to delete a profile that still holds a role. */
  test("rollback() detaches before deleting", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx({ instanceProfileCreatedThisRun: true }, () => ({}), sent);
    await step.rollback!(ctx);

    const names = sent.map((c) => c.constructor.name);
    expect(names.indexOf("RemoveRoleFromInstanceProfileCommand")).toBeLessThan(
      names.indexOf("DeleteInstanceProfileCommand"),
    );
  });

  /** A profile that already existed may be attached to instances we know nothing about. */
  test("rollback() detaches but never deletes a profile it did not create", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx({ instanceProfileCreatedThisRun: false }, () => ({}), sent);
    await step.rollback!(ctx);

    const names = sent.map((c) => c.constructor.name);
    expect(names).toContain("RemoveRoleFromInstanceProfileCommand");
    expect(names).not.toContain("DeleteInstanceProfileCommand");
  });
});
