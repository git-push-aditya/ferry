import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";

import createUserIntegration from "../../integrations/aws/iam/user/create-user/integration";
import type { Params as CreateUserParams } from "../../integrations/aws/iam/user/create-user/params";

import deleteUserIntegration from "../../integrations/aws/iam/user/delete-user/integration";
import { confirmDestructiveStep as deleteConfirmDestructiveStep } from "../../integrations/aws/iam/user/delete-user/steps/confirm-destructive";
import type { Params as DeleteUserParams } from "../../integrations/aws/iam/user/delete-user/params";



import createAccessKeyIntegration from "../../integrations/aws/iam/user/create-access-key/integration";
import type { Params as CreateAccessKeyParams } from "../../integrations/aws/iam/user/create-access-key/params";

import rotateAccessKeyIntegration from "../../integrations/aws/iam/user/rotate-access-key/integration";
import { mintNewKeyStep } from "../../integrations/aws/iam/user/rotate-access-key/steps/mint-new-key";
import { cutoverOldKeyStep } from "../../integrations/aws/iam/user/rotate-access-key/steps/cutover-old-key";
import type { Params as RotateAccessKeyParams } from "../../integrations/aws/iam/user/rotate-access-key/params";


import enforceMfaIntegration from "../../integrations/aws/iam/user/enforce-mfa/integration";
import { mfaDeviceProvisionStep } from "../../integrations/aws/iam/user/enforce-mfa/steps/mfa-device-provision";
import { mfaPolicyConditionStep } from "../../integrations/aws/iam/user/enforce-mfa/steps/mfa-policy-condition";
import type { Params as EnforceMfaParams } from "../../integrations/aws/iam/user/enforce-mfa/params";




import offboardUserIntegration from "../../integrations/aws/iam/user/offboard-user/integration";
import { confirmDestructiveStep as offboardConfirmDestructiveStep } from "../../integrations/aws/iam/user/offboard-user/steps/confirm-destructive";
import type { Params as OffboardUserParams } from "../../integrations/aws/iam/user/offboard-user/params";

import { iamUserTeardownStep } from "../../src/providers/aws/iam";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function iamCtx<P>(
  params: P,
  outputs: Record<string, unknown>,
  send: (command: FakeCommand) => unknown,
): StepContext<P> {
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
    clients: { aws: { s3: iam, iam, sts: iam, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

function nse(): Error {
  return Object.assign(new Error("no such entity"), { name: "NoSuchEntityException" });
}

function names(sent: FakeCommand[]): string[] {
  return sent.map((c) => c.constructor.name);
}

// ---------------------------------------------------------------------------
// create-user
// ---------------------------------------------------------------------------

describe("create-user", () => {
  const params: CreateUserParams = { IAM_USER_NAME: "alice", IAM_USER_PATH: undefined, IAM_PERMISSIONS_BOUNDARY_ARN: undefined };
  const [userStep] = createUserIntegration.steps as [import("../../src/core/define").Step<CreateUserParams>];

  test("happy path: missing user -> create sends CreateUserCommand", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      if (c.constructor.name === "GetUserCommand") return nse();
      if (c.constructor.name === "CreateUserCommand") return { User: { Arn: `arn:aws:iam::${ACCOUNT}:user/alice` } };
      return {};
    });

    expect(await userStep.check(ctx)).toBe("missing");
    const outputs = await userStep.create!(ctx);

    expect(names(sent)).toEqual(["GetUserCommand", "CreateUserCommand"]);
    expect(outputs).toEqual({
      userArn: `arn:aws:iam::${ACCOUNT}:user/alice`,
      userCreatedThisRun: true,
    });
  });

  test("idempotency: existing user -> check reports exists, no mutation planned", async () => {
    const ctx = iamCtx(params, {}, () => ({}));
    expect(await userStep.check(ctx)).toBe("exists");
  });

  test("rollback deletes the user created this run", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, { userCreatedThisRun: true }, (c) => {
      sent.push(c);
      return {};
    });

    await userStep.rollback(ctx);

    expect(names(sent)).toEqual(["DeleteUserCommand"]);
    expect(sent[0].input).toEqual({ UserName: "alice" });
  });

  test("rollback tolerates the user already being gone", async () => {
    const ctx = iamCtx(params, {}, () => nse());
    await expect(userStep.rollback(ctx)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// attach-policy-to-user
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// detach-policy-from-user
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// add-user-to-group / remove-user-from-group
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// create-access-key: 2-key cap logic
// ---------------------------------------------------------------------------

describe("create-access-key", () => {
  function accessKeyStep(): import("../../src/core/define").Step<CreateAccessKeyParams> {
    return createAccessKeyIntegration.steps[1] as import("../../src/core/define").Step<CreateAccessKeyParams>;
  }

  test("0 keys -> missing (create)", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: false };
    const ctx = iamCtx(params, {}, () => ({ AccessKeyMetadata: [] }));
    expect(await accessKeyStep().check(ctx)).toBe("missing");
  });

  test("1 key, ALLOW_SECOND_KEY=false -> exists (leave alone)", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: false };
    const ctx = iamCtx(params, {}, () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }] }));
    expect(await accessKeyStep().check(ctx)).toBe("exists");
  });

  test("1 key, ALLOW_SECOND_KEY=true -> missing (mint a second)", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: true };
    const ctx = iamCtx(params, {}, () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }] }));
    expect(await accessKeyStep().check(ctx)).toBe("missing");
  });

  test("2 keys -> always exists, even with ALLOW_SECOND_KEY=true (hard cap)", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: true };
    const ctx = iamCtx(params, {}, () => ({
      AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }, { AccessKeyId: "AKIA2" }],
    }));
    expect(await accessKeyStep().check(ctx)).toBe("exists");
  });

  test("happy path create sends CreateAccessKeyCommand and returns id+secret", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: false };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      return { AccessKey: { AccessKeyId: "AKIANEW", SecretAccessKey: "shh" } };
    });

    const outputs = await accessKeyStep().create!(ctx);

    expect(names(sent)).toEqual(["CreateAccessKeyCommand"]);
    expect(outputs).toEqual({
      accessKeyId: "AKIANEW",
      secretAccessKey: "shh",
      accessKeyCreatedThisRun: true,
    });
  });

  test("rollback deletes the key created this run", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: false };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, { accessKeyId: "AKIANEW" }, (c) => {
      sent.push(c);
      return {};
    });

    await accessKeyStep().rollback(ctx);

    expect(names(sent)).toEqual(["DeleteAccessKeyCommand"]);
    expect(sent[0].input).toEqual({ UserName: "dave", AccessKeyId: "AKIANEW" });
  });

  test("rollback is a no-op when nothing was created this run", async () => {
    const params: CreateAccessKeyParams = { IAM_USER_NAME: "dave", ALLOW_SECOND_KEY: false };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      return {};
    });

    await accessKeyStep().rollback(ctx);

    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rotate-access-key: mint-only vs cutover phases
// ---------------------------------------------------------------------------

describe("rotate-access-key", () => {
  test("mint-only phase (CONFIRM_CUTOVER=false): mints new key, zero mutations to old key", async () => {
    const params: RotateAccessKeyParams = {
      IAM_USER_NAME: "erin",
      CONFIRM_CUTOVER: false,
      ROTATION_SOAK_MINUTES: 0,
    };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      if (c.constructor.name === "ListAccessKeysCommand") {
        return { AccessKeyMetadata: [{ AccessKeyId: "AKIAOLD" }] };
      }
      if (c.constructor.name === "CreateAccessKeyCommand") {
        return { AccessKey: { AccessKeyId: "AKIANEW", SecretAccessKey: "shh" } };
      }
      return {};
    });

    expect(await mintNewKeyStep.check(ctx)).toBe("missing");
    const mintOutputs = await mintNewKeyStep.create!(ctx);
    expect(mintOutputs).toEqual({
      oldAccessKeyId: "AKIAOLD",
      newAccessKeyId: "AKIANEW",
      newSecretAccessKey: "shh",
      newKeyMintedThisRun: true,
    });

    // No calls that mutate the old key at all during mint phase.
    expect(names(sent).filter((n) => n.includes("Delete") || n.includes("Update"))).toEqual([]);

    // cutover step: CONFIRM_CUTOVER is false -> exists (no-op), no sends.
    const cutoverCtx = iamCtx(params, mintOutputs, (c) => {
      sent.push(c);
      return {};
    });
    const preCutoverSentLength = sent.length;
    expect(await cutoverOldKeyStep.check(cutoverCtx)).toBe("exists");
    expect(sent.length).toBe(preCutoverSentLength); // check() made no sends

    expect(names(sent).includes("DeleteAccessKeyCommand")).toBe(false);
    expect(names(sent).includes("UpdateAccessKeyCommand")).toBe(false);
  });

  test("cutover phase (CONFIRM_CUTOVER=true): deactivates + deletes the old key", async () => {
    const params: RotateAccessKeyParams = {
      IAM_USER_NAME: "erin",
      CONFIRM_CUTOVER: true,
      ROTATION_SOAK_MINUTES: 0,
    };
    const outputs = { oldAccessKeyId: "AKIAOLD", newAccessKeyId: "AKIANEW" };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      if (c.constructor.name === "ListAccessKeysCommand") {
        return { AccessKeyMetadata: [{ AccessKeyId: "AKIAOLD", Status: "Active" }] };
      }
      return {};
    });

    expect(await cutoverOldKeyStep.check(ctx)).toBe("missing");
    const reconcileOutputs = await cutoverOldKeyStep.reconcile!(ctx);

    expect(names(sent)).toEqual([
      "ListAccessKeysCommand",
      "UpdateAccessKeyCommand",
      "DeleteAccessKeyCommand",
    ]);
    const updateCall = sent.find((c) => c.constructor.name === "UpdateAccessKeyCommand")!;
    expect(updateCall.input).toEqual({ UserName: "erin", AccessKeyId: "AKIAOLD", Status: "Inactive" });
    const deleteCall = sent.find((c) => c.constructor.name === "DeleteAccessKeyCommand")!;
    expect(deleteCall.input).toEqual({ UserName: "erin", AccessKeyId: "AKIAOLD" });
    expect(reconcileOutputs).toEqual({ oldKeyDeactivatedThisRun: true, oldKeyDeletedThisRun: true });
  });

  test("idempotency: cutover already done (old key gone) -> exists", async () => {
    const params: RotateAccessKeyParams = {
      IAM_USER_NAME: "erin",
      CONFIRM_CUTOVER: true,
      ROTATION_SOAK_MINUTES: 0,
    };
    const outputs = { oldAccessKeyId: "AKIAOLD" };
    const ctx = iamCtx(params, outputs, () => ({ AccessKeyMetadata: [] }));
    expect(await cutoverOldKeyStep.check(ctx)).toBe("exists");
  });

  test("mint-new-key rollback deletes the newly minted key, never the old one", async () => {
    const params: RotateAccessKeyParams = {
      IAM_USER_NAME: "erin",
      CONFIRM_CUTOVER: false,
      ROTATION_SOAK_MINUTES: 0,
    };
    const outputs = { newAccessKeyId: "AKIANEW", oldAccessKeyId: "AKIAOLD", newKeyMintedThisRun: true };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      return {};
    });

    await mintNewKeyStep.rollback(ctx);

    expect(names(sent)).toEqual(["DeleteAccessKeyCommand"]);
    expect(sent[0].input).toEqual({ UserName: "erin", AccessKeyId: "AKIANEW" });
  });

  test("cutover rollback reactivates the old key if only deactivated (not deleted)", async () => {
    const params: RotateAccessKeyParams = {
      IAM_USER_NAME: "erin",
      CONFIRM_CUTOVER: true,
      ROTATION_SOAK_MINUTES: 0,
    };
    const outputs = { oldAccessKeyId: "AKIAOLD", oldKeyDeactivatedThisRun: true };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      return {};
    });

    await cutoverOldKeyStep.rollback(ctx);

    expect(names(sent)).toEqual(["UpdateAccessKeyCommand"]);
    expect(sent[0].input).toEqual({ UserName: "erin", AccessKeyId: "AKIAOLD", Status: "Active" });
  });

  test("cutover rollback is a no-op (but warns) once the old key was actually deleted", async () => {
    const params: RotateAccessKeyParams = {
      IAM_USER_NAME: "erin",
      CONFIRM_CUTOVER: true,
      ROTATION_SOAK_MINUTES: 0,
    };
    const outputs = { oldAccessKeyId: "AKIAOLD", oldKeyDeletedThisRun: true };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      return {};
    });

    await cutoverOldKeyStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deactivate-access-key
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// enforce-mfa
// ---------------------------------------------------------------------------

describe("enforce-mfa: device-provision", () => {
  const params: EnforceMfaParams = {
    IAM_USER_NAME: "grace",
    IAM_POLICY_ARN: `arn:aws:iam::${ACCOUNT}:policy/require-mfa`,
    MFA_CONDITION_MAX_AGE_SECONDS: undefined,
    PROVISION_VIRTUAL_DEVICE: true,
  };

  test("no device, provisioning on -> creates device, output never claims 'enabled'", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      if (c.constructor.name === "ListMFADevicesCommand") return { MFADevices: [] };
      if (c.constructor.name === "CreateVirtualMFADeviceCommand") {
        return {
          VirtualMFADevice: {
            SerialNumber: `arn:aws:iam::${ACCOUNT}:mfa/grace`,
            Base32StringSeed: Buffer.from("SEED"),
          },
        };
      }
      return {};
    });

    expect(await mfaDeviceProvisionStep.check(ctx)).toBe("missing");
    const outputs = await mfaDeviceProvisionStep.create!(ctx);

    expect(outputs.mfaAwaitingHumanEnablement).toBe(true);
    expect(outputs).not.toHaveProperty("mfaEnabled");
    expect(names(sent)).toEqual(["ListMFADevicesCommand", "CreateVirtualMFADeviceCommand"]);

    const resource = mfaDeviceProvisionStep.resource!(iamCtx(params, outputs, () => ({})));
    expect(resource.attributes?.status).toBe("awaiting-human-enablement");
    expect(resource.attributes?.status).not.toBe("enabled");
  });

  test("device already present -> exists (a human enabled it out of band)", async () => {
    const ctx = iamCtx(params, {}, () => ({
      MFADevices: [{ SerialNumber: `arn:aws:iam::${ACCOUNT}:mfa/grace` }],
    }));
    expect(await mfaDeviceProvisionStep.check(ctx)).toBe("exists");
  });

  test("no device, provisioning off -> exists (opted out)", async () => {
    const offParams = { ...params, PROVISION_VIRTUAL_DEVICE: false };
    const ctx = iamCtx(offParams, {}, () => ({ MFADevices: [] }));
    expect(await mfaDeviceProvisionStep.check(ctx)).toBe("exists");
  });

  test("rollback deletes the device created this run when still un-enabled", async () => {
    const sent: FakeCommand[] = [];
    const serial = `arn:aws:iam::${ACCOUNT}:mfa/grace`;
    const outputs = { mfaDeviceSerialNumber: serial };
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      if (c.constructor.name === "ListMFADevicesCommand") return { MFADevices: [] };
      return {};
    });

    await mfaDeviceProvisionStep.rollback(ctx);

    expect(names(sent)).toEqual(["ListMFADevicesCommand", "DeleteVirtualMFADeviceCommand"]);
    expect(sent[1].input).toEqual({ SerialNumber: serial });
  });

  test("rollback leaves the device alone if a human enabled it since", async () => {
    const sent: FakeCommand[] = [];
    const serial = `arn:aws:iam::${ACCOUNT}:mfa/grace`;
    const outputs = { mfaDeviceSerialNumber: serial };
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      if (c.constructor.name === "ListMFADevicesCommand") return { MFADevices: [{ SerialNumber: serial }] };
      return {};
    });

    await mfaDeviceProvisionStep.rollback(ctx);

    expect(names(sent)).toEqual(["ListMFADevicesCommand"]);
  });
});

describe("enforce-mfa: policy-condition (whole-document replace)", () => {
  const params: EnforceMfaParams = {
    IAM_USER_NAME: "grace",
    IAM_POLICY_ARN: `arn:aws:iam::${ACCOUNT}:policy/require-mfa`,
    MFA_CONDITION_MAX_AGE_SECONDS: undefined,
    PROVISION_VIRTUAL_DEVICE: true,
  };
  const rawDoc = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "s3:*", Resource: "*" }],
  });

  test("always applies (check always 'missing')", async () => {
    const ctx = iamCtx(params, {}, () => ({}));
    expect(await mfaPolicyConditionStep.check(ctx)).toBe("missing");
  });

  test("reconcile adds the condition to every statement via CreatePolicyVersion", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      switch (c.constructor.name) {
        case "GetPolicyCommand":
          return { Policy: { DefaultVersionId: "v1" } };
        case "GetPolicyVersionCommand":
          return { PolicyVersion: { Document: rawDoc } };
        case "ListPolicyVersionsCommand":
          return { Versions: [{ VersionId: "v1", IsDefaultVersion: true }] };
        default:
          return {};
      }
    });

    const outputs = await mfaPolicyConditionStep.reconcile!(ctx);

    const createCall = sent.find((c) => c.constructor.name === "CreatePolicyVersionCommand")!;
    const doc = JSON.parse(createCall.input.PolicyDocument as string);
    expect(doc.Statement[0].Condition.Bool["aws:MultiFactorAuthPresent"]).toBe("true");
    expect(createCall.input.SetAsDefault).toBe(true);
    expect(outputs.priorPolicyVersionId).toBe("v1");
    expect(outputs.mfaPolicyChangedThisRun).toBe(true);
  });

  test("reconcile is a no-op when every statement already enforces MFA", async () => {
    const enforcedDoc = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "s3:*", Resource: "*", Condition: { Bool: { "aws:MultiFactorAuthPresent": "true" } } },
      ],
    });
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      switch (c.constructor.name) {
        case "GetPolicyCommand":
          return { Policy: { DefaultVersionId: "v1" } };
        case "GetPolicyVersionCommand":
          return { PolicyVersion: { Document: enforcedDoc } };
        default:
          return {};
      }
    });

    const outputs = await mfaPolicyConditionStep.reconcile!(ctx);

    expect(names(sent)).not.toContain("CreatePolicyVersionCommand");
    expect(outputs).toEqual({});
  });

  test("rollback restores the prior default version via SetDefaultPolicyVersion", async () => {
    const sent: FakeCommand[] = [];
    const outputs = { priorPolicyVersionId: "v1" };
    const ctx = iamCtx(params, outputs, (c) => {
      sent.push(c);
      if (c.constructor.name === "ListPolicyVersionsCommand") {
        // After SetDefaultPolicyVersion(v1), v1 is default again and v2 (this
        // run's created version) is the sole non-default, deletable version.
        return { Versions: [{ VersionId: "v1", IsDefaultVersion: true }, { VersionId: "v2", IsDefaultVersion: false }] };
      }
      return {};
    });

    await mfaPolicyConditionStep.rollback(ctx);

    expect(sent[0].constructor.name).toBe("SetDefaultPolicyVersionCommand");
    expect(sent[0].input).toEqual({ PolicyArn: params.IAM_POLICY_ARN, VersionId: "v1" });
    const deleteCall = sent.find((c) => c.constructor.name === "DeletePolicyVersionCommand");
    expect(deleteCall?.input).toEqual({ PolicyArn: params.IAM_POLICY_ARN, VersionId: "v2" });
  });

  test("rollback is a no-op when nothing changed this run", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      return {};
    });

    await mfaPolicyConditionStep.rollback(ctx);

    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tag-user: additive vs prune
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// delete-user / offboard-user: iamUserTeardownStep
// ---------------------------------------------------------------------------

describe("delete-user", () => {
  const params: DeleteUserParams = { IAM_USER_NAME: "ivan", ALLOW_DESTRUCTIVE_TEARDOWN: true };
  const teardownStep = iamUserTeardownStep<DeleteUserParams>({ userName: (p) => p.IAM_USER_NAME });

  test("confirm-destructive gate blocks when flag is false", async () => {
    const blockedParams = { ...params, ALLOW_DESTRUCTIVE_TEARDOWN: false };
    const ctx = iamCtx(blockedParams, {}, () => ({}));
    expect(await deleteConfirmDestructiveStep.check(ctx)).toBe("conflict");
  });

  test("confirm-destructive gate passes when flag is true", async () => {
    const ctx = iamCtx(params, {}, () => ({}));
    expect(await deleteConfirmDestructiveStep.check(ctx)).toBe("exists");
  });

  test("full teardown: everything attached is cleaned up in sequence, then DeleteUser", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      switch (c.constructor.name) {
        case "GetUserCommand":
          return {};
        case "ListAccessKeysCommand":
          return { AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }, { AccessKeyId: "AKIA2" }] };
        case "GetLoginProfileCommand":
          return {};
        case "ListMFADevicesCommand":
          return { MFADevices: [{ SerialNumber: `arn:aws:iam::${ACCOUNT}:mfa/ivan` }] };
        case "ListGroupsForUserCommand":
          return { Groups: [{ GroupName: "developers" }] };
        case "ListAttachedUserPoliciesCommand":
          return { AttachedPolicies: [{ PolicyArn: `arn:aws:iam::${ACCOUNT}:policy/p1` }] };
        case "ListUserPoliciesCommand":
          return { PolicyNames: ["inline1"] };
        case "ListSigningCertificatesCommand":
          return { Certificates: [{ CertificateId: "cert1" }] };
        case "ListSSHPublicKeysCommand":
          return { SSHPublicKeys: [{ SSHPublicKeyId: "ssh1" }] };
        case "ListServiceSpecificCredentialsCommand":
          return { ServiceSpecificCredentials: [{ ServiceSpecificCredentialId: "cred1" }] };
        default:
          return {};
      }
    });

    expect(await teardownStep.check(ctx)).toBe("missing"); // user present -> needs teardown
    const outputs = await teardownStep.create!(ctx);

    const order = names(sent);
    expect(order).toEqual([
      "GetUserCommand",
      "ListAccessKeysCommand",
      "DeleteAccessKeyCommand",
      "DeleteAccessKeyCommand",
      "GetLoginProfileCommand",
      "DeleteLoginProfileCommand",
      "ListMFADevicesCommand",
      "DeactivateMFADeviceCommand",
      "DeleteVirtualMFADeviceCommand",
      "ListGroupsForUserCommand",
      "RemoveUserFromGroupCommand",
      "ListAttachedUserPoliciesCommand",
      "DetachUserPolicyCommand",
      "ListUserPoliciesCommand",
      "DeleteUserPolicyCommand",
      "ListSigningCertificatesCommand",
      "DeleteSigningCertificateCommand",
      "ListSSHPublicKeysCommand",
      "DeleteSSHPublicKeyCommand",
      "ListServiceSpecificCredentialsCommand",
      "DeleteServiceSpecificCredentialCommand",
      "DeleteUserCommand",
    ]);

    expect(outputs.userTornDownThisRun).toBe(true);
    const summary = JSON.parse(outputs.userTeardownSummary as string);
    expect(summary).toEqual({
      deactivatedKeyCount: 0,
      deletedKeyCount: 2,
      hadLoginProfile: true,
      mfaDeviceCount: 1,
      groupCount: 1,
      attachedPolicyCount: 1,
      inlinePolicyCount: 1,
      signingCertCount: 1,
      sshKeyCount: 1,
      serviceSpecificCredCount: 1,
    });
  });

  test("a user with nothing attached still completes cleanly (empty lists everywhere)", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      switch (c.constructor.name) {
        case "GetUserCommand":
          return {};
        case "ListAccessKeysCommand":
          return { AccessKeyMetadata: [] };
        case "GetLoginProfileCommand":
          return nse();
        case "ListMFADevicesCommand":
          return { MFADevices: [] };
        case "ListGroupsForUserCommand":
          return { Groups: [] };
        case "ListAttachedUserPoliciesCommand":
          return { AttachedPolicies: [] };
        case "ListUserPoliciesCommand":
          return { PolicyNames: [] };
        case "ListSigningCertificatesCommand":
          return { Certificates: [] };
        case "ListSSHPublicKeysCommand":
          return { SSHPublicKeys: [] };
        case "ListServiceSpecificCredentialsCommand":
          return { ServiceSpecificCredentials: [] };
        default:
          return {};
      }
    });

    const outputs = await teardownStep.create!(ctx);

    expect(names(sent)).toEqual([
      "ListAccessKeysCommand",
      "GetLoginProfileCommand",
      "ListMFADevicesCommand",
      "ListGroupsForUserCommand",
      "ListAttachedUserPoliciesCommand",
      "ListUserPoliciesCommand",
      "ListSigningCertificatesCommand",
      "ListSSHPublicKeysCommand",
      "ListServiceSpecificCredentialsCommand",
      "DeleteUserCommand",
    ]);

    const summary = JSON.parse(outputs.userTeardownSummary as string);
    expect(summary).toEqual({
      deactivatedKeyCount: 0,
      deletedKeyCount: 0,
      hadLoginProfile: false,
      mfaDeviceCount: 0,
      groupCount: 0,
      attachedPolicyCount: 0,
      inlinePolicyCount: 0,
      signingCertCount: 0,
      sshKeyCount: 0,
      serviceSpecificCredCount: 0,
    });
  });

  test("idempotency: user already gone -> check reports exists (nothing to do)", async () => {
    const ctx = iamCtx(params, {}, () => nse());
    expect(await teardownStep.check(ctx)).toBe("exists");
  });

  test("rollback recreates a bare user shell (unrecoverable secrets are gone)", async () => {
    const summary = {
      deletedKeyCount: 2,
      hadLoginProfile: true,
      mfaDeviceCount: 1,
      groupCount: 1,
      attachedPolicyCount: 1,
      inlinePolicyCount: 1,
      signingCertCount: 0,
      sshKeyCount: 0,
      serviceSpecificCredCount: 0,
    };
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, { userTeardownSummary: JSON.stringify(summary) }, (c) => {
      sent.push(c);
      return {};
    });

    await teardownStep.rollback(ctx);

    expect(names(sent)).toEqual(["CreateUserCommand"]);
    expect(sent[0].input).toEqual({ UserName: "ivan" });
  });
});

describe("offboard-user", () => {
  const params: OffboardUserParams = {
    IAM_USER_NAME: "judy",
    ALLOW_DESTRUCTIVE_TEARDOWN: true,
    OFFBOARD_REASON: "resignation",
  };
  const teardownStep = iamUserTeardownStep<OffboardUserParams>({ userName: (p) => p.IAM_USER_NAME });

  test("confirm-destructive gate blocks when flag is false", async () => {
    const blockedParams = { ...params, ALLOW_DESTRUCTIVE_TEARDOWN: false };
    const ctx = iamCtx(blockedParams, {}, () => ({}));
    expect(await offboardConfirmDestructiveStep.check(ctx)).toBe("conflict");
  });

  test("shares the identical teardown sequence with delete-user: empty user completes cleanly", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      switch (c.constructor.name) {
        case "GetUserCommand":
          return {};
        case "ListAccessKeysCommand":
          return { AccessKeyMetadata: [] };
        case "GetLoginProfileCommand":
          return nse();
        case "ListMFADevicesCommand":
          return { MFADevices: [] };
        case "ListGroupsForUserCommand":
          return { Groups: [] };
        case "ListAttachedUserPoliciesCommand":
          return { AttachedPolicies: [] };
        case "ListUserPoliciesCommand":
          return { PolicyNames: [] };
        case "ListSigningCertificatesCommand":
          return { Certificates: [] };
        case "ListSSHPublicKeysCommand":
          return { SSHPublicKeys: [] };
        case "ListServiceSpecificCredentialsCommand":
          return { ServiceSpecificCredentials: [] };
        default:
          return {};
      }
    });

    await teardownStep.create!(ctx);

    expect(names(sent)[names(sent).length - 1]).toBe("DeleteUserCommand");
    expect(names(sent)).not.toContain("DeleteAccessKeyCommand");
  });

  test("teardown with everything attached calls all cleanup APIs then DeleteUser", async () => {
    const sent: FakeCommand[] = [];
    const ctx = iamCtx(params, {}, (c) => {
      sent.push(c);
      switch (c.constructor.name) {
        case "GetUserCommand":
          return {};
        case "ListAccessKeysCommand":
          return { AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }] };
        case "GetLoginProfileCommand":
          return {};
        case "ListMFADevicesCommand":
          return { MFADevices: [{ SerialNumber: "arn:aws:iam::123:mfa/judy" }] };
        case "ListGroupsForUserCommand":
          return { Groups: [{ GroupName: "g1" }] };
        case "ListAttachedUserPoliciesCommand":
          return { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::123:policy/p1" }] };
        case "ListUserPoliciesCommand":
          return { PolicyNames: ["inline1"] };
        case "ListSigningCertificatesCommand":
          return { Certificates: [] };
        case "ListSSHPublicKeysCommand":
          return { SSHPublicKeys: [] };
        case "ListServiceSpecificCredentialsCommand":
          return { ServiceSpecificCredentials: [] };
        default:
          return {};
      }
    });

    const outputs = await teardownStep.create!(ctx);

    expect(names(sent)).toContain("DeleteAccessKeyCommand");
    expect(names(sent)).toContain("DeleteLoginProfileCommand");
    expect(names(sent)).toContain("DeactivateMFADeviceCommand");
    expect(names(sent)).toContain("DeleteVirtualMFADeviceCommand");
    expect(names(sent)).toContain("RemoveUserFromGroupCommand");
    expect(names(sent)).toContain("DetachUserPolicyCommand");
    expect(names(sent)).toContain("DeleteUserPolicyCommand");
    expect(names(sent)[names(sent).length - 1]).toBe("DeleteUserCommand");
    expect(outputs.userTornDownThisRun).toBe(true);
  });
});

// Silence "unused" complaints for imported integrations that are only used
// to pluck out steps above (keeps a compile-time link to the real modules).
void deleteUserIntegration;
void offboardUserIntegration;
void enforceMfaIntegration;
void rotateAccessKeyIntegration;
