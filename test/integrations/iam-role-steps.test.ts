import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";

import { iamRoleStep } from "../../src/providers/aws/iam";
import type { Params as CreateRoleParams } from "../../integrations/aws/iam/role/create-role/params";

import { deleteRoleStep } from "../../integrations/aws/iam/role/delete-role/steps/delete-role";
import type { Params as DeleteRoleParams } from "../../integrations/aws/iam/role/delete-role/params";

import { iamAttachRolePolicyStep } from "../../src/providers/aws/iam";
import type { Params as AttachParams } from "../../integrations/aws/iam/role/attach-policy-to-role/params";

import { iamDetachRolePolicyStep } from "../../src/providers/aws/iam";
import type { Params as DetachParams } from "../../integrations/aws/iam/role/detach-policy-from-role/params";

import { trustPolicyStep } from "../../integrations/aws/iam/role/update-trust-policy/steps/trust-policy";
import type { Params as TrustParams } from "../../integrations/aws/iam/role/update-trust-policy/params";

import { inlinePolicyStep } from "../../integrations/aws/iam/role/create-inline-policy-for-role/steps/inline-policy";
import type { Params as InlineParams } from "../../integrations/aws/iam/role/create-inline-policy-for-role/params";

import { rotatePermissionsStep } from "../../integrations/aws/iam/role/rotate-role-permissions/steps/rotate-permissions";
import type { Params as RotateParams } from "../../integrations/aws/iam/role/rotate-role-permissions/params";

import { serviceLinkedRoleStep } from "../../integrations/aws/iam/role/create-service-linked-role/steps/service-linked-role";
import type { Params as SlrParams } from "../../integrations/aws/iam/role/create-service-linked-role/params";

import { tagsStep } from "../../integrations/aws/iam/role/tag-role/steps/tags";
import type { Params as TagParams } from "../../integrations/aws/iam/role/tag-role/params";

import { auditStep } from "../../integrations/aws/iam/role/audit-unused-roles/steps/audit";
import type { Params as AuditParams } from "../../integrations/aws/iam/role/audit-unused-roles/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

function awsError(name: string, httpStatusCode = 404): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

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

// ---------------------------------------------------------------------------
// create-role
// ---------------------------------------------------------------------------

const CREATE_ROLE_PARAMS: CreateRoleParams = {
  ROLE_NAME: "ferry-role",
  TRUST_POLICY: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
  MAX_SESSION_DURATION_SECONDS: undefined,
};

describe("create-role", () => {
  const step = iamRoleStep<CreateRoleParams>({
    roleName: (p) => p.ROLE_NAME,
    trustPolicy: (p) => JSON.parse(p.TRUST_POLICY),
  });

  test("check() missing -> create() sends CreateRoleCommand with the trust policy", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(CREATE_ROLE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") return awsError("NoSuchEntityException");
      if (cmd.constructor.name === "CreateRoleCommand") {
        expect(cmd.input.RoleName).toBe("ferry-role");
        expect(cmd.input.AssumeRolePolicyDocument).toBe(CREATE_ROLE_PARAMS.TRUST_POLICY);
        return { Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/ferry-role` } };
      }
      return {};
    });

    const state = await step.check(ctx);
    expect(state).toBe("missing");

    const outputs = await step.create!(ctx);
    expect(outputs).toEqual({
      roleArn: `arn:aws:iam::${ACCOUNT}:role/ferry-role`,
      roleCreatedThisRun: true,
    });
    expect(sent).toEqual(["GetRoleCommand", "CreateRoleCommand"]);
  });

  test("idempotency: check() returns exists when the role is already there, no mutation", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(CREATE_ROLE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") return { Role: {} };
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });

    const state = await step.check(ctx);
    expect(state).toBe("exists");
    expect(sent).toEqual(["GetRoleCommand"]);
  });

  test("rollback() deletes exactly the role, tolerating already-gone", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(CREATE_ROLE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "DeleteRoleCommand") {
        expect(cmd.input.RoleName).toBe("ferry-role");
        return {};
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
    await step.rollback(ctx);
    expect(sent).toEqual(["DeleteRoleCommand"]);

    // Tolerates NoSuchEntity without throwing.
    const ctx2 = iamCtx(CREATE_ROLE_PARAMS, {}, () => awsError("NoSuchEntityException"));
    await expect(step.rollback(ctx2)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// delete-role
// ---------------------------------------------------------------------------

const DELETE_ROLE_PARAMS: DeleteRoleParams = {
  ROLE_NAME: "ferry-role",
  DELETE_INSTANCE_PROFILES_TOO: false,
};

describe("delete-role", () => {
  test("check() already gone -> exists (no-op, idempotent-delete branch)", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_ROLE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return awsError("NoSuchEntityException");
    });
    const state = await deleteRoleStep.check(ctx);
    expect(state).toBe("exists");
    expect(sent).toEqual(["GetRoleCommand"]);
  });

  test("check() flags a service-linked role as conflict, refusing DeleteRole", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_ROLE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") {
        return { Role: { Path: "/aws-service-role/foo.amazonaws.com/", RoleName: "ferry-role" } };
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
    const state = await deleteRoleStep.check(ctx);
    expect(state).toBe("conflict");
  });

  test("check() present ordinary role -> missing (still needs deletion)", async () => {
    const ctx = iamCtx(DELETE_ROLE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "GetRoleCommand") return { Role: { Path: "/", RoleName: "ferry-role" } };
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
    const state = await deleteRoleStep.check(ctx);
    expect(state).toBe("missing");
  });

  test("create() detaches/deletes everything attached, then deletes the role", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_ROLE_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      sent.push(name);
      switch (name) {
        case "GetRoleCommand":
          return {
            Role: {
              AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Version: "2012-10-17" })),
              Path: "/",
              Description: "d",
              MaxSessionDuration: 3600,
              Tags: [],
            },
          };
        case "ListAttachedRolePoliciesCommand":
          return { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess" }] };
        case "ListRolePoliciesCommand":
          return { PolicyNames: ["inline-1"] };
        case "GetRolePolicyCommand":
          return { PolicyDocument: encodeURIComponent(JSON.stringify({ Statement: [] })) };
        case "ListInstanceProfilesForRoleCommand":
          return { InstanceProfiles: [{ InstanceProfileName: "profile-1" }] };
        case "DetachRolePolicyCommand":
        case "DeleteRolePolicyCommand":
        case "RemoveRoleFromInstanceProfileCommand":
        case "DeleteRoleCommand":
          return {};
        default:
          throw new Error(`unexpected command ${name}`);
      }
    });

    const outputs = await deleteRoleStep.create!(ctx);
    expect(outputs.roleDeletedThisRun).toBe(true);
    expect(outputs.detachedPolicyArns).toEqual(["arn:aws:iam::aws:policy/ReadOnlyAccess"]);
    expect((outputs.deletedInlinePolicies as { policyName: string }[]).map((p) => p.policyName)).toEqual([
      "inline-1",
    ]);
    expect(outputs.removedInstanceProfileNames).toEqual(["profile-1"]);
    expect(outputs.deletedInstanceProfileNames).toEqual([]); // DELETE_INSTANCE_PROFILES_TOO=false

    expect(sent).toContain("DetachRolePolicyCommand");
    expect(sent).toContain("DeleteRolePolicyCommand");
    expect(sent).toContain("RemoveRoleFromInstanceProfileCommand");
    expect(sent).toContain("DeleteRoleCommand");
    expect(sent).not.toContain("DeleteInstanceProfileCommand");
  });

  test("rollback() recreates exactly the captured snapshot and re-attaches captured attachments, not more", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const outputs = {
      roleDeletedThisRun: true,
      priorRoleSnapshot: {
        assumeRolePolicyDocument: JSON.stringify({ Version: "2012-10-17" }),
        path: "/",
        description: "d",
        maxSessionDuration: 3600,
        tags: [],
      },
      detachedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      deletedInlinePolicies: [{ policyName: "inline-1", document: JSON.stringify({ Statement: [] }) }],
      removedInstanceProfileNames: ["profile-1"],
      deletedInstanceProfileNames: [],
    };
    const ctx = iamCtx(DELETE_ROLE_PARAMS, outputs, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });

    await deleteRoleStep.rollback(ctx);

    expect(sent.map((s) => s.name)).toEqual([
      "CreateRoleCommand",
      "AttachRolePolicyCommand",
      "PutRolePolicyCommand",
      "AddRoleToInstanceProfileCommand",
    ]);
    expect(sent[1]!.input.PolicyArn).toBe("arn:aws:iam::aws:policy/ReadOnlyAccess");
    expect(sent[2]!.input.PolicyName).toBe("inline-1");
    expect(sent[3]!.input.InstanceProfileName).toBe("profile-1");
  });

  test("rollback() is a no-op when the role was never deleted this run", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DELETE_ROLE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await deleteRoleStep.rollback(ctx);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// attach-policy-to-role
// ---------------------------------------------------------------------------

const ATTACH_PARAMS: AttachParams = {
  ROLE_NAME: "ferry-role",
  POLICY_ARN: "arn:aws:iam::aws:policy/ReadOnlyAccess",
};

describe("attach-policy-to-role", () => {
  const step = iamAttachRolePolicyStep<AttachParams>({
    roleName: (p) => p.ROLE_NAME,
    policyArn: (p) => p.POLICY_ARN,
  });

  test("check() missing -> create() sends AttachRolePolicyCommand", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(ATTACH_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") return { AttachedPolicies: [] };
      if (cmd.constructor.name === "AttachRolePolicyCommand") {
        expect(cmd.input.RoleName).toBe("ferry-role");
        expect(cmd.input.PolicyArn).toBe(ATTACH_PARAMS.POLICY_ARN);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await step.check(ctx)).toBe("missing");
    const outputs = await step.create!(ctx);
    expect(outputs).toEqual({ policyAttachedThisRun: true });
    expect(sent).toEqual(["ListAttachedRolePoliciesCommand", "AttachRolePolicyCommand"]);
  });

  test("idempotency: already attached -> exists, no mutating call", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(ATTACH_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return { AttachedPolicies: [{ PolicyArn: ATTACH_PARAMS.POLICY_ARN }] };
    });
    expect(await step.check(ctx)).toBe("exists");
    expect(sent).toEqual(["ListAttachedRolePoliciesCommand"]);
  });

  test("rollback() detaches exactly the attached policy", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(ATTACH_PARAMS, { policyAttachedThisRun: true }, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await step.rollback(ctx);
    expect(sent).toEqual([
      {
        name: "DetachRolePolicyCommand",
        input: { RoleName: "ferry-role", PolicyArn: ATTACH_PARAMS.POLICY_ARN },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// detach-policy-from-role
// ---------------------------------------------------------------------------

const DETACH_PARAMS: DetachParams = {
  ROLE_NAME: "ferry-role",
  POLICY_ARN: "arn:aws:iam::aws:policy/ReadOnlyAccess",
};

describe("detach-policy-from-role", () => {
  const step = iamDetachRolePolicyStep<DetachParams>({
    roleName: (p) => p.ROLE_NAME,
    policyArn: (p) => p.POLICY_ARN,
  });

  test("check() attached -> missing, then create() detaches", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DETACH_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") {
        return { AttachedPolicies: [{ PolicyArn: DETACH_PARAMS.POLICY_ARN }] };
      }
      if (cmd.constructor.name === "DetachRolePolicyCommand") return {};
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await step.check(ctx)).toBe("missing");
    const outputs = await step.create!(ctx);
    expect(outputs).toEqual({ policyDetachedThisRun: true });
    expect(sent).toEqual(["ListAttachedRolePoliciesCommand", "DetachRolePolicyCommand"]);
  });

  test("idempotency: already detached -> exists, zero mutating calls", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(DETACH_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return { AttachedPolicies: [] };
    });
    expect(await step.check(ctx)).toBe("exists");
    expect(sent).toEqual(["ListAttachedRolePoliciesCommand"]);
  });

  test("check() role already gone -> exists (target state already achieved)", async () => {
    const ctx = iamCtx(DETACH_PARAMS, {}, () => awsError("NoSuchEntityException"));
    expect(await step.check(ctx)).toBe("exists");
  });

  test("rollback() re-attaches exactly the detached policy", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = iamCtx(DETACH_PARAMS, { policyDetachedThisRun: true }, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await step.rollback(ctx);
    expect(sent).toEqual([
      {
        name: "AttachRolePolicyCommand",
        input: { RoleName: "ferry-role", PolicyArn: DETACH_PARAMS.POLICY_ARN },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// update-trust-policy
// ---------------------------------------------------------------------------

const TRUST_DOC = { Version: "2012-10-17", Statement: [{ Effect: "Allow" }] };
const TRUST_PARAMS: TrustParams = {
  ROLE_NAME: "ferry-role",
  TRUST_POLICY: JSON.stringify(TRUST_DOC),
};

describe("update-trust-policy", () => {
  test("reconcile() replaces a differing trust policy and captures the prior document", async () => {
    const sent: string[] = [];
    const priorDoc = { Version: "2012-10-17", Statement: [] };
    const ctx = iamCtx(TRUST_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") {
        return { Role: { AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(priorDoc)) } };
      }
      if (cmd.constructor.name === "UpdateAssumeRolePolicyCommand") {
        expect(JSON.parse(cmd.input.PolicyDocument as string)).toEqual(TRUST_DOC);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await trustPolicyStep.reconcile!(ctx);
    expect(outputs.changed).toBe(true);
    expect(JSON.parse(outputs.priorTrustPolicy as string)).toEqual(priorDoc);
    expect(sent).toEqual(["GetRoleCommand", "UpdateAssumeRolePolicyCommand"]);
  });

  test("idempotent no-op: matching desired trust policy makes zero mutating calls", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TRUST_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") {
        return { Role: { AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(TRUST_DOC)) } };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await trustPolicyStep.reconcile!(ctx);
    expect(outputs).toEqual({});
    expect(sent).toEqual(["GetRoleCommand"]);
  });

  test("rollback() restores exactly the prior document when changed, no-op otherwise", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const priorDoc = JSON.stringify({ Version: "2012-10-17", Statement: [] });
    const ctx = iamCtx(TRUST_PARAMS, { priorTrustPolicy: priorDoc }, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await trustPolicyStep.rollback(ctx);
    expect(sent).toEqual([
      { name: "UpdateAssumeRolePolicyCommand", input: { RoleName: "ferry-role", PolicyDocument: priorDoc } },
    ]);

    const sent2: string[] = [];
    const noopCtx = iamCtx(TRUST_PARAMS, {}, (cmd) => {
      sent2.push(cmd.constructor.name);
      return {};
    });
    await trustPolicyStep.rollback(noopCtx);
    expect(sent2).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// create-inline-policy-for-role
// ---------------------------------------------------------------------------

const INLINE_DOC = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject" }] };
const INLINE_PARAMS: InlineParams = {
  ROLE_NAME: "ferry-role",
  POLICY_NAME: "inline-1",
  POLICY_DOCUMENT: JSON.stringify(INLINE_DOC),
};

describe("create-inline-policy-for-role", () => {
  test("reconcile() puts a new inline policy when none existed", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(INLINE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRolePolicyCommand") return awsError("NoSuchEntityException");
      if (cmd.constructor.name === "PutRolePolicyCommand") {
        expect(cmd.input.PolicyName).toBe("inline-1");
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await inlinePolicyStep.reconcile!(ctx);
    expect(outputs.changed).toBe(true);
    expect(outputs.hadExistingInlinePolicy).toBe(false);
    expect(sent).toEqual(["GetRolePolicyCommand", "PutRolePolicyCommand"]);
  });

  test("idempotent no-op: matching existing inline policy makes zero mutating calls", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(INLINE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRolePolicyCommand") {
        return { PolicyDocument: encodeURIComponent(JSON.stringify(INLINE_DOC)) };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await inlinePolicyStep.reconcile!(ctx);
    expect(outputs).toEqual({});
    expect(sent).toEqual(["GetRolePolicyCommand"]);
  });

  test("rollback() deletes a newly-created inline policy, restores a replaced one", async () => {
    const sentDelete: string[] = [];
    const ctxCreated = iamCtx(
      INLINE_PARAMS,
      { hadExistingInlinePolicy: false },
      (cmd) => {
        sentDelete.push(cmd.constructor.name);
        return {};
      },
    );
    await inlinePolicyStep.rollback(ctxCreated);
    expect(sentDelete).toEqual(["DeleteRolePolicyCommand"]);

    const priorDoc = JSON.stringify({ Version: "2012-10-17", Statement: [] });
    const sentPut: { name: string; input: Record<string, unknown> }[] = [];
    const ctxReplaced = iamCtx(
      INLINE_PARAMS,
      { hadExistingInlinePolicy: true, priorInlinePolicyDocument: priorDoc },
      (cmd) => {
        sentPut.push({ name: cmd.constructor.name, input: cmd.input });
        return {};
      },
    );
    await inlinePolicyStep.rollback(ctxReplaced);
    expect(sentPut).toEqual([
      {
        name: "PutRolePolicyCommand",
        input: { RoleName: "ferry-role", PolicyName: "inline-1", PolicyDocument: priorDoc },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// rotate-role-permissions
// ---------------------------------------------------------------------------

const ROTATE_PARAMS: RotateParams = {
  ROLE_NAME: "ferry-role",
  DESIRED_POLICY_ARNS: ["arn:aws:iam::aws:policy/A", "arn:aws:iam::aws:policy/B"],
};

describe("rotate-role-permissions", () => {
  test("reconcile() attaches missing and detaches extra, attach before detach", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(ROTATE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") {
        return { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/A" }, { PolicyArn: "arn:aws:iam::aws:policy/C" }] };
      }
      return {};
    });
    const outputs = await rotatePermissionsStep.reconcile!(ctx);
    expect(JSON.parse(outputs.executedAttach as string)).toEqual(["arn:aws:iam::aws:policy/B"]);
    expect(JSON.parse(outputs.executedDetach as string)).toEqual(["arn:aws:iam::aws:policy/C"]);
    // attach happens before detach
    const attachIdx = sent.indexOf("AttachRolePolicyCommand");
    const detachIdx = sent.indexOf("DetachRolePolicyCommand");
    expect(attachIdx).toBeGreaterThan(-1);
    expect(detachIdx).toBeGreaterThan(attachIdx);
  });

  test("idempotent no-op: current set already matches desired, zero mutating calls", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(ROTATE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {
        AttachedPolicies: ROTATE_PARAMS.DESIRED_POLICY_ARNS.map((PolicyArn) => ({ PolicyArn })),
      };
    });
    const outputs = await rotatePermissionsStep.reconcile!(ctx);
    expect(JSON.parse(outputs.executedAttach as string)).toEqual([]);
    expect(JSON.parse(outputs.executedDetach as string)).toEqual([]);
    expect(sent).toEqual(["ListAttachedRolePoliciesCommand"]);
  });

  test("rollback() inverts exactly the executed attach/detach lists", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const outputs = {
      executedAttach: JSON.stringify(["arn:aws:iam::aws:policy/B"]),
      executedDetach: JSON.stringify(["arn:aws:iam::aws:policy/C"]),
    };
    const ctx = iamCtx(ROTATE_PARAMS, outputs, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await rotatePermissionsStep.rollback(ctx);
    expect(sent).toEqual([
      { name: "AttachRolePolicyCommand", input: { RoleName: "ferry-role", PolicyArn: "arn:aws:iam::aws:policy/C" } },
      { name: "DetachRolePolicyCommand", input: { RoleName: "ferry-role", PolicyArn: "arn:aws:iam::aws:policy/B" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// create-service-linked-role
// ---------------------------------------------------------------------------

const SLR_PARAMS: SlrParams = {
  AWS_SERVICE_NAME: "elasticbeanstalk.amazonaws.com",
  EXPECTED_ROLE_NAME: "AWSServiceRoleForElasticBeanstalk",
};

describe("create-service-linked-role", () => {
  test("check() missing -> create() sends CreateServiceLinkedRoleCommand", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SLR_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") return awsError("NoSuchEntityException");
      if (cmd.constructor.name === "CreateServiceLinkedRoleCommand") {
        expect(cmd.input.AWSServiceName).toBe(SLR_PARAMS.AWS_SERVICE_NAME);
        return {
          Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/aws-service-role/x/AWSServiceRoleForElasticBeanstalk`, RoleName: SLR_PARAMS.EXPECTED_ROLE_NAME },
        };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await serviceLinkedRoleStep.check(ctx)).toBe("missing");
    const outputs = await serviceLinkedRoleStep.create!(ctx);
    expect(outputs.serviceLinkedRoleCreatedThisRun).toBe(true);
    expect(outputs.roleName).toBe(SLR_PARAMS.EXPECTED_ROLE_NAME);
    expect(sent).toEqual(["GetRoleCommand", "CreateServiceLinkedRoleCommand"]);
  });

  test("idempotency: EXPECTED_ROLE_NAME already exists -> exists, no create call", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SLR_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return { Role: {} };
    });
    expect(await serviceLinkedRoleStep.check(ctx)).toBe("exists");
    expect(sent).toEqual(["GetRoleCommand"]);
  });

  test("rollback() starts async deletion and polls to a SUCCEEDED status", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(SLR_PARAMS, { roleName: SLR_PARAMS.EXPECTED_ROLE_NAME }, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "DeleteServiceLinkedRoleCommand") return { DeletionTaskId: "task-1" };
      if (cmd.constructor.name === "GetServiceLinkedRoleDeletionStatusCommand") return { Status: "SUCCEEDED" };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    await serviceLinkedRoleStep.rollback(ctx);
    expect(sent).toEqual(["DeleteServiceLinkedRoleCommand", "GetServiceLinkedRoleDeletionStatusCommand"]);
  });
});

// ---------------------------------------------------------------------------
// tag-role
// ---------------------------------------------------------------------------

const TAG_PARAMS: TagParams = {
  ROLE_NAME: "ferry-role",
  TAGS_JSON: JSON.stringify({ env: "prod" }),
};

describe("tag-role", () => {
  test("reconcile() sets tags that differ from the current set", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TAG_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListRoleTagsCommand") return { Tags: [{ Key: "env", Value: "dev" }] };
      if (cmd.constructor.name === "TagRoleCommand") {
        expect(cmd.input.Tags).toEqual([{ Key: "env", Value: "prod" }]);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await tagsStep.reconcile!(ctx);
    expect(JSON.parse(outputs.priorTags as string)).toEqual({ env: "dev" });
    expect(sent).toEqual(["ListRoleTagsCommand", "TagRoleCommand"]);
  });

  test("idempotent no-op: desired tags already match, zero mutating calls", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TAG_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return { Tags: [{ Key: "env", Value: "prod" }] };
    });
    const outputs = await tagsStep.reconcile!(ctx);
    expect(JSON.parse(outputs.priorTags as string)).toEqual({ env: "prod" });
    expect(sent).toEqual(["ListRoleTagsCommand"]);
  });

  test("reconcile() with TAGS_JSON unset leaves tags untouched", async () => {
    const sent: string[] = [];
    const ctx = iamCtx({ ...TAG_PARAMS, TAGS_JSON: "" }, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    const outputs = await tagsStep.reconcile!(ctx);
    expect(outputs).toEqual({});
    expect(sent).toEqual([]);
  });

  test("rollback() strips introduced keys and restores overwritten ones, nothing else", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const params: TagParams = { ROLE_NAME: "ferry-role", TAGS_JSON: JSON.stringify({ env: "prod", team: "x" }) };
    const priorTags = JSON.stringify({ env: "dev" }); // "team" is introduced, "env" is overwritten
    const ctx = iamCtx(params, { priorTags }, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await tagsStep.rollback(ctx);
    expect(sent).toEqual([
      { name: "UntagRoleCommand", input: { RoleName: "ferry-role", TagKeys: ["team"] } },
      { name: "TagRoleCommand", input: { RoleName: "ferry-role", Tags: [{ Key: "env", Value: "dev" }] } },
    ]);
  });

  test("rollback() no-ops when nothing was touched this run", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(TAG_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await tagsStep.rollback(ctx);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// audit-unused-roles
// ---------------------------------------------------------------------------

const AUDIT_PARAMS: AuditParams = {
  STALE_THRESHOLD_DAYS: 90,
  INCLUDE_SERVICE_LINKED_ROLES: false,
  RUN_DEEP_ACCESS_ADVISOR_PASS: false,
  PATH_PREFIX_FILTER: undefined,
};

const MUTATING_COMMANDS = new Set([
  "CreateRoleCommand",
  "DeleteRoleCommand",
  "AttachRolePolicyCommand",
  "DetachRolePolicyCommand",
  "PutRolePolicyCommand",
  "DeleteRolePolicyCommand",
  "TagRoleCommand",
  "UntagRoleCommand",
  "UpdateAssumeRolePolicyCommand",
  "CreateServiceLinkedRoleCommand",
  "DeleteServiceLinkedRoleCommand",
]);

describe("audit-unused-roles", () => {
  test("check() always returns missing so create() re-audits every run", async () => {
    const ctx = iamCtx(AUDIT_PARAMS, {}, () => ({}));
    expect(await auditStep.check(ctx)).toBe("missing");
  });

  test("create() never sends a mutating command and produces a well-formed report", async () => {
    const now = Date.now();
    const staleDate = new Date(now - 200 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000);
    const sent: string[] = [];
    const ctx = iamCtx(AUDIT_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      expect(MUTATING_COMMANDS.has(cmd.constructor.name)).toBe(false);
      if (cmd.constructor.name === "ListRolesCommand") {
        return {
          Roles: [
            {
              RoleName: "never-used-role",
              Arn: `arn:aws:iam::${ACCOUNT}:role/never-used-role`,
              Path: "/",
              CreateDate: new Date(now - 400 * 24 * 60 * 60 * 1000),
            },
            {
              RoleName: "stale-role",
              Arn: `arn:aws:iam::${ACCOUNT}:role/stale-role`,
              Path: "/",
              CreateDate: new Date(now - 400 * 24 * 60 * 60 * 1000),
              RoleLastUsed: { LastUsedDate: staleDate, Region: "ap-south-1" },
            },
            {
              RoleName: "active-role",
              Arn: `arn:aws:iam::${ACCOUNT}:role/active-role`,
              Path: "/",
              CreateDate: new Date(now - 400 * 24 * 60 * 60 * 1000),
              RoleLastUsed: { LastUsedDate: recentDate, Region: "ap-south-1" },
            },
            {
              RoleName: "AWSServiceRoleForFoo",
              Arn: `arn:aws:iam::${ACCOUNT}:role/aws-service-role/foo/AWSServiceRoleForFoo`,
              Path: "/aws-service-role/foo.amazonaws.com/",
              CreateDate: new Date(now),
            },
          ],
          IsTruncated: false,
        };
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });

    const outputs = await auditStep.create!(ctx);
    const rows = JSON.parse(outputs.auditReport as string) as {
      roleName: string;
      category: string;
      ageDays: number;
    }[];

    // Service-linked role excluded by default.
    expect(rows.map((r) => r.roleName).sort()).toEqual(["active-role", "never-used-role", "stale-role"]);

    const byName = Object.fromEntries(rows.map((r) => [r.roleName, r]));
    expect(byName["never-used-role"]!.category).toBe("never used");
    expect(byName["stale-role"]!.category).toBe("stale candidate");
    expect(byName["active-role"]!.category).toBe("active, not a candidate");
    expect(typeof byName["never-used-role"]!.ageDays).toBe("number");

    expect(sent).toEqual(["ListRolesCommand"]);
  });

  test("rollback() is a true no-op", async () => {
    const sent: string[] = [];
    const ctx = iamCtx(AUDIT_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await auditStep.rollback(ctx);
    expect(sent).toEqual([]);
  });
});
