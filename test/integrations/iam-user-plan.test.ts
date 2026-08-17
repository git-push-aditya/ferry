import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import {
  iamUserStep,
  iamUserExistsGuardStep,
  iamAttachUserPolicyStep,
  iamDetachUserPolicyStep,
  iamAddUserToGroupStep,
  iamRemoveUserFromGroupStep,
  iamAccessKeyStep,
  iamAccessKeyStatusStep,
} from "../../src/providers/aws/iam";
import { confirmDestructiveStep as deleteConfirmStep } from "../../integrations/aws/iam/user/delete-user/steps/confirm-destructive";
import type { Params as DeleteUserParams } from "../../integrations/aws/iam/user/delete-user/params";
import { confirmDestructiveStep as offboardConfirmStep } from "../../integrations/aws/iam/user/offboard-user/steps/confirm-destructive";
import type { Params as OffboardParams } from "../../integrations/aws/iam/user/offboard-user/params";
import { mintNewKeyStep } from "../../integrations/aws/iam/user/rotate-access-key/steps/mint-new-key";
import { cutoverOldKeyStep } from "../../integrations/aws/iam/user/rotate-access-key/steps/cutover-old-key";
import type { Params as RotateParams } from "../../integrations/aws/iam/user/rotate-access-key/params";
import { mfaDeviceProvisionStep } from "../../integrations/aws/iam/user/enforce-mfa/steps/mfa-device-provision";
import { mfaPolicyConditionStep } from "../../integrations/aws/iam/user/enforce-mfa/steps/mfa-policy-condition";
import type { Params as MfaParams } from "../../integrations/aws/iam/user/enforce-mfa/params";
import { tagsStep } from "../../integrations/aws/iam/user/tag-user/steps/tags";
import type { Params as TagUserParams } from "../../integrations/aws/iam/user/tag-user/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };
type Command = { constructor: { name: string }; input: Record<string, unknown> };

function iamPlanCtx<P>(params: P, send: (command: Command) => unknown): StepContext<P> {
  const iam = {
    async send(command: Command) {
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
    outputs: {},
    dryRun: true,
    log: NO_LOG,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { name: "NoSuchEntityException" });
}

describe("iam/user dry-run plan: create-user (iamUserStep)", () => {
  const userName = () => "alice";

  test("user missing -> missing", async () => {
    const ctx = iamPlanCtx({}, () => {
      throw notFound();
    });
    const step = iamUserStep<Record<string, never>>({ userName });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("user already exists -> exists", async () => {
    const ctx = iamPlanCtx({}, () => ({ User: { UserName: "alice" } }));
    const step = iamUserStep<Record<string, never>>({ userName });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("guard: missing user -> conflict", async () => {
    const ctx = iamPlanCtx({}, () => {
      throw notFound();
    });
    const guard = iamUserExistsGuardStep<Record<string, never>>({ userName });
    expect(await guard.check(ctx)).toBe("conflict");
  });
});

describe("iam/user dry-run plan: attach/detach-policy-to-user", () => {
  const userName = () => "alice";
  const policyArn = () => "arn:aws:iam::123:policy/p1";

  test("attach: not attached -> missing", async () => {
    const ctx = iamPlanCtx({}, () => ({ AttachedPolicies: [] }));
    const step = iamAttachUserPolicyStep<Record<string, never>>({ userName, policyArn });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("attach: already attached -> exists", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AttachedPolicies: [{ PolicyArn: "arn:aws:iam::123:policy/p1" }],
    }));
    const step = iamAttachUserPolicyStep<Record<string, never>>({ userName, policyArn });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("detach: not attached -> exists (already achieved)", async () => {
    const ctx = iamPlanCtx({}, () => ({ AttachedPolicies: [] }));
    const step = iamDetachUserPolicyStep<Record<string, never>>({ userName, policyArn });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("detach: currently attached -> missing", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AttachedPolicies: [{ PolicyArn: "arn:aws:iam::123:policy/p1" }],
    }));
    const step = iamDetachUserPolicyStep<Record<string, never>>({ userName, policyArn });
    expect(await step.check(ctx)).toBe("missing");
  });
});

describe("iam/user dry-run plan: add/remove-user-from-group", () => {
  const userName = () => "alice";
  const groupName = () => "developers";

  test("add: not a member -> missing", async () => {
    const ctx = iamPlanCtx({}, () => ({ Groups: [] }));
    const step = iamAddUserToGroupStep<Record<string, never>>({ userName, groupName });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("add: already a member -> exists", async () => {
    const ctx = iamPlanCtx({}, () => ({ Groups: [{ GroupName: "developers" }] }));
    const step = iamAddUserToGroupStep<Record<string, never>>({ userName, groupName });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("remove: not a member -> exists (already achieved)", async () => {
    const ctx = iamPlanCtx({}, () => ({ Groups: [] }));
    const step = iamRemoveUserFromGroupStep<Record<string, never>>({ userName, groupName });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("remove: currently a member -> missing", async () => {
    const ctx = iamPlanCtx({}, () => ({ Groups: [{ GroupName: "developers" }] }));
    const step = iamRemoveUserFromGroupStep<Record<string, never>>({ userName, groupName });
    expect(await step.check(ctx)).toBe("missing");
  });
});

describe("iam/user dry-run plan: create-access-key (2-key cap)", () => {
  const userName = () => "alice";

  test("0 keys -> missing", async () => {
    const ctx = iamPlanCtx({}, () => ({ AccessKeyMetadata: [] }));
    const step = iamAccessKeyStep<Record<string, never>>({ userName });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("1 key, ALLOW_SECOND_KEY unset -> exists (left alone)", async () => {
    const ctx = iamPlanCtx({}, () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }] }));
    const step = iamAccessKeyStep<Record<string, never>>({ userName });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("1 key, allowSecondKey true -> missing (mint the second)", async () => {
    const ctx = iamPlanCtx({}, () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }] }));
    const step = iamAccessKeyStep<Record<string, never>>({ userName, allowSecondKey: () => true });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("2 keys -> always exists, regardless of the flag", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }, { AccessKeyId: "AKIA2" }],
    }));
    const step = iamAccessKeyStep<Record<string, never>>({ userName, allowSecondKey: () => true });
    expect(await step.check(ctx)).toBe("exists");
  });
});

describe("iam/user dry-run plan: deactivate-access-key / rotate-access-key cutover (iamAccessKeyStatusStep)", () => {
  const userName = () => "alice";
  const accessKeyId = () => "AKIA1";

  test("key currently Active, desired Inactive -> missing", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AccessKeyMetadata: [{ AccessKeyId: "AKIA1", Status: "Active" }],
    }));
    const step = iamAccessKeyStatusStep<Record<string, never>>({
      userName,
      accessKeyId,
      desired: () => "Inactive",
    });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("key already Inactive, desired Inactive -> exists", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AccessKeyMetadata: [{ AccessKeyId: "AKIA1", Status: "Inactive" }],
    }));
    const step = iamAccessKeyStatusStep<Record<string, never>>({
      userName,
      accessKeyId,
      desired: () => "Inactive",
    });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("key already gone -> missing (nothing to toggle, per the factory's own contract)", async () => {
    const ctx = iamPlanCtx({}, () => ({ AccessKeyMetadata: [] }));
    const step = iamAccessKeyStatusStep<Record<string, never>>({
      userName,
      accessKeyId,
      desired: () => "Inactive",
    });
    expect(await step.check(ctx)).toBe("missing");
  });
});

describe("iam/user dry-run plan: delete-user / offboard-user destructive-confirm guard", () => {
  test("delete-user: ALLOW_DESTRUCTIVE_TEARDOWN false -> conflict", async () => {
    const params: DeleteUserParams = { IAM_USER_NAME: "alice", ALLOW_DESTRUCTIVE_TEARDOWN: false };
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await deleteConfirmStep.check(ctx)).toBe("conflict");
  });

  test("delete-user: ALLOW_DESTRUCTIVE_TEARDOWN true -> exists (proceed)", async () => {
    const params: DeleteUserParams = { IAM_USER_NAME: "alice", ALLOW_DESTRUCTIVE_TEARDOWN: true };
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await deleteConfirmStep.check(ctx)).toBe("exists");
  });

  test("offboard-user: ALLOW_DESTRUCTIVE_TEARDOWN false -> conflict", async () => {
    const params: OffboardParams = {
      IAM_USER_NAME: "alice",
      ALLOW_DESTRUCTIVE_TEARDOWN: false,
      OFFBOARD_REASON: undefined,
    };
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await offboardConfirmStep.check(ctx)).toBe("conflict");
  });
});

describe("iam/user dry-run plan: rotate-access-key two-step state machine", () => {
  test("mint step: 0 keys -> conflict (rotation presumes an existing key)", async () => {
    const params: RotateParams = { IAM_USER_NAME: "alice", CONFIRM_CUTOVER: false, ROTATION_SOAK_MINUTES: 0 };
    const ctx = iamPlanCtx(params, () => ({ AccessKeyMetadata: [] }));
    expect(await mintNewKeyStep.check(ctx)).toBe("conflict");
  });

  test("mint step: 1 key -> missing (mint the second)", async () => {
    const params: RotateParams = { IAM_USER_NAME: "alice", CONFIRM_CUTOVER: false, ROTATION_SOAK_MINUTES: 0 };
    const ctx = iamPlanCtx(params, () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIA1", Status: "Active" }] }));
    expect(await mintNewKeyStep.check(ctx)).toBe("missing");
  });

  test("cutover step: CONFIRM_CUTOVER false -> exists (waiting on manual confirmation)", async () => {
    const params: RotateParams = { IAM_USER_NAME: "alice", CONFIRM_CUTOVER: false, ROTATION_SOAK_MINUTES: 0 };
    const ctx = iamPlanCtx(params, () => ({
      AccessKeyMetadata: [
        { AccessKeyId: "AKIA1", Status: "Active" },
        { AccessKeyId: "AKIA2", Status: "Active" },
      ],
    }));
    ctx.outputs.oldAccessKeyId = "AKIA1";
    expect(await cutoverOldKeyStep.check(ctx)).toBe("exists");
  });

  test("cutover step: CONFIRM_CUTOVER true, old key still Active -> missing", async () => {
    const params: RotateParams = { IAM_USER_NAME: "alice", CONFIRM_CUTOVER: true, ROTATION_SOAK_MINUTES: 0 };
    const ctx = iamPlanCtx(params, () => ({
      AccessKeyMetadata: [
        { AccessKeyId: "AKIA1", Status: "Active" },
        { AccessKeyId: "AKIA2", Status: "Active" },
      ],
    }));
    ctx.outputs.oldAccessKeyId = "AKIA1";
    expect(await cutoverOldKeyStep.check(ctx)).toBe("missing");
  });
});

describe("iam/user dry-run plan: enforce-mfa two independent steps", () => {
  const params: MfaParams = {
    IAM_USER_NAME: "alice",
    IAM_POLICY_ARN: "arn:aws:iam::123:policy/mfa",
    MFA_CONDITION_MAX_AGE_SECONDS: undefined,
    PROVISION_VIRTUAL_DEVICE: true,
  };

  test("device-provision: no device, opted in -> missing", async () => {
    const ctx = iamPlanCtx(params, () => ({ MFADevices: [] }));
    expect(await mfaDeviceProvisionStep.check(ctx)).toBe("missing");
  });

  test("device-provision: device already present -> exists", async () => {
    const ctx = iamPlanCtx(params, () => ({ MFADevices: [{ SerialNumber: "arn:aws:iam::123:mfa/alice" }] }));
    expect(await mfaDeviceProvisionStep.check(ctx)).toBe("exists");
  });

  test("device-provision: not opted in -> exists (this half is opted out)", async () => {
    const ctx = iamPlanCtx({ ...params, PROVISION_VIRTUAL_DEVICE: false }, () => ({ MFADevices: [] }));
    expect(await mfaDeviceProvisionStep.check(ctx)).toBe("exists");
  });

  test("policy-condition: always missing (always-reconcile)", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await mfaPolicyConditionStep.check(ctx)).toBe("missing");
  });
});

describe("iam/user dry-run plan: tag-user (always-reconcile)", () => {
  const params: TagUserParams = {
    IAM_USER_NAME: "alice",
    TAGS_JSON: JSON.stringify({ team: "core" }),
    PRUNE_UNMANAGED_TAGS: false,
  };

  test("check() always missing", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await tagsStep.check(ctx)).toBe("missing");
  });
});
