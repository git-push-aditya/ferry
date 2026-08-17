import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { iamRoleStep, iamRoleExistsGuardStep, iamAttachRolePolicyStep, iamDetachRolePolicyStep } from "../../src/providers/aws/iam";
import { trustPolicyStep } from "../../integrations/aws/iam/role/update-trust-policy/steps/trust-policy";
import type { Params as TrustPolicyParams } from "../../integrations/aws/iam/role/update-trust-policy/params";
import { inlinePolicyStep } from "../../integrations/aws/iam/role/create-inline-policy-for-role/steps/inline-policy";
import type { Params as InlinePolicyParams } from "../../integrations/aws/iam/role/create-inline-policy-for-role/params";
import { rotatePermissionsStep } from "../../integrations/aws/iam/role/rotate-role-permissions/steps/rotate-permissions";
import type { Params as RotateParams } from "../../integrations/aws/iam/role/rotate-role-permissions/params";
import { deleteRoleStep } from "../../integrations/aws/iam/role/delete-role/steps/delete-role";
import type { Params as DeleteRoleParams } from "../../integrations/aws/iam/role/delete-role/params";
import { serviceLinkedRoleStep } from "../../integrations/aws/iam/role/create-service-linked-role/steps/service-linked-role";
import type { Params as SlrParams } from "../../integrations/aws/iam/role/create-service-linked-role/params";
import { tagsStep } from "../../integrations/aws/iam/role/tag-role/steps/tags";
import type { Params as TagRoleParams } from "../../integrations/aws/iam/role/tag-role/params";
import { auditStep } from "../../integrations/aws/iam/role/audit-unused-roles/steps/audit";
import type { Params as AuditParams } from "../../integrations/aws/iam/role/audit-unused-roles/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };
type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** dry-run context: check() only — create()/reconcile() must never run here. */
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

describe("iam/role dry-run plan: create-role (iamRoleStep)", () => {
  const TRUST_POLICY = { Version: "2012-10-17", Statement: [] };
  test("role missing -> missing", async () => {
    const ctx = iamPlanCtx({}, () => {
      throw notFound();
    });
    const step = iamRoleStep<Record<string, never>>({
      roleName: () => "r1",
      trustPolicy: () => TRUST_POLICY,
    });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("role already exists -> exists", async () => {
    const ctx = iamPlanCtx({}, () => ({ Role: { RoleName: "r1" } }));
    const step = iamRoleStep<Record<string, never>>({
      roleName: () => "r1",
      trustPolicy: () => TRUST_POLICY,
    });
    expect(await step.check(ctx)).toBe("exists");
  });
});

describe("iam/role dry-run plan: delete-role", () => {
  const params: DeleteRoleParams = { ROLE_NAME: "r1", DELETE_INSTANCE_PROFILES_TOO: false };

  test("role already gone -> exists (already achieved)", async () => {
    const ctx = iamPlanCtx(params, () => {
      throw notFound();
    });
    expect(await deleteRoleStep.check(ctx)).toBe("exists");
  });

  test("role present, not service-linked -> missing (needs teardown)", async () => {
    const ctx = iamPlanCtx(params, (cmd) => {
      if (cmd.constructor.name === "GetRoleCommand") {
        return { Role: { RoleName: "r1", Path: "/", Arn: "arn:aws:iam::123:role/r1" } };
      }
      return {};
    });
    expect(await deleteRoleStep.check(ctx)).toBe("missing");
  });

  test("service-linked role -> conflict", async () => {
    const ctx = iamPlanCtx(params, (cmd) => {
      if (cmd.constructor.name === "GetRoleCommand") {
        return {
          Role: {
            RoleName: "AWSServiceRoleForFoo",
            Path: "/aws-service-role/foo.amazonaws.com/",
            Arn: "arn:aws:iam::123:role/aws-service-role/foo.amazonaws.com/AWSServiceRoleForFoo",
          },
        };
      }
      return {};
    });
    expect(await deleteRoleStep.check(ctx)).toBe("conflict");
  });
});

describe("iam/role dry-run plan: attach/detach-policy-to-role", () => {
  const roleName = () => "r1";
  const policyArn = () => "arn:aws:iam::123:policy/p1";

  test("attach: role missing -> missing (an earlier step will create it)", async () => {
    const ctx = iamPlanCtx({}, () => {
      throw notFound();
    });
    const step = iamAttachRolePolicyStep<Record<string, never>>({ roleName, policyArn });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("attach: already attached -> exists", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AttachedPolicies: [{ PolicyArn: "arn:aws:iam::123:policy/p1" }],
    }));
    const step = iamAttachRolePolicyStep<Record<string, never>>({ roleName, policyArn });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("detach: not attached -> exists (already achieved)", async () => {
    const ctx = iamPlanCtx({}, () => ({ AttachedPolicies: [] }));
    const step = iamDetachRolePolicyStep<Record<string, never>>({ roleName, policyArn });
    expect(await step.check(ctx)).toBe("exists");
  });

  test("detach: currently attached -> missing (needs detaching)", async () => {
    const ctx = iamPlanCtx({}, () => ({
      AttachedPolicies: [{ PolicyArn: "arn:aws:iam::123:policy/p1" }],
    }));
    const step = iamDetachRolePolicyStep<Record<string, never>>({ roleName, policyArn });
    expect(await step.check(ctx)).toBe("missing");
  });

  test("guard: missing role -> conflict", async () => {
    const ctx = iamPlanCtx({}, () => {
      throw notFound();
    });
    const guard = iamRoleExistsGuardStep<Record<string, never>>({ roleName });
    expect(await guard.check(ctx)).toBe("conflict");
  });
});

describe("iam/role dry-run plan: update-trust-policy (always-reconcile)", () => {
  const params: TrustPolicyParams = {
    ROLE_NAME: "r1",
    TRUST_POLICY: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
  };

  test("check() always missing", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await trustPolicyStep.check(ctx)).toBe("missing");
  });
});

describe("iam/role dry-run plan: create-inline-policy-for-role (always-reconcile)", () => {
  const params: InlinePolicyParams = {
    ROLE_NAME: "r1",
    POLICY_NAME: "inline1",
    POLICY_DOCUMENT: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
  };

  test("check() always missing", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await inlinePolicyStep.check(ctx)).toBe("missing");
  });
});

describe("iam/role dry-run plan: rotate-role-permissions (always-reconcile)", () => {
  const params: RotateParams = {
    ROLE_NAME: "r1",
    DESIRED_POLICY_ARNS: ["arn:aws:iam::123:policy/p1"],
  };

  test("check() always missing", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await rotatePermissionsStep.check(ctx)).toBe("missing");
  });
});

describe("iam/role dry-run plan: create-service-linked-role", () => {
  const params: SlrParams = {
    AWS_SERVICE_NAME: "elasticbeanstalk.amazonaws.com",
    EXPECTED_ROLE_NAME: "AWSServiceRoleForElasticBeanstalk",
    CUSTOM_SUFFIX: undefined,
    DESCRIPTION: undefined,
  };

  test("expected role missing -> missing", async () => {
    const ctx = iamPlanCtx(params, () => {
      throw notFound();
    });
    expect(await serviceLinkedRoleStep.check(ctx)).toBe("missing");
  });

  test("expected role already present -> exists", async () => {
    const ctx = iamPlanCtx(params, () => ({
      Role: { RoleName: params.EXPECTED_ROLE_NAME, Path: "/aws-service-role/elasticbeanstalk.amazonaws.com/" },
    }));
    expect(await serviceLinkedRoleStep.check(ctx)).toBe("exists");
  });
});

describe("iam/role dry-run plan: tag-role (always-reconcile)", () => {
  const params: TagRoleParams = { ROLE_NAME: "r1", TAGS_JSON: JSON.stringify({ team: "core" }) };

  test("check() always missing", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await tagsStep.check(ctx)).toBe("missing");
  });
});

describe("iam/role dry-run plan: audit-unused-roles (read-only)", () => {
  const params: AuditParams = {
    STALE_THRESHOLD_DAYS: 90,
    INCLUDE_SERVICE_LINKED_ROLES: false,
    RUN_DEEP_ACCESS_ADVISOR_PASS: false,
    PATH_PREFIX_FILTER: undefined,
  };

  test("check() always missing (every run re-audits fresh)", async () => {
    const ctx = iamPlanCtx(params, () => ({}));
    expect(await auditStep.check(ctx)).toBe("missing");
  });
});
