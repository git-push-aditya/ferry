import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { oidcProviderAndRoleStep } from "../../integrations/github/setup-github-actions-oidc-role/steps/oidc-provider-and-role";
import { trustPolicyAndAttachStep } from "../../integrations/github/setup-github-actions-oidc-role/steps/trust-policy-and-attach";
import { oidcProviderArn, type Params } from "../../integrations/github/setup-github-actions-oidc-role/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };
type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

function oidcCtx(
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
    clients: { aws: { s3: iam, iam, sts: iam, ec2: iam, ssm: iam, secretsManager: iam, region: "us-east-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const BASE_PARAMS: Params = {
  GITHUB_OWNER: "acme",
  GITHUB_REPO: "widgets",
  SCOPE_TYPE: "branch",
  SCOPE_VALUE: "main",
  ALLOW_ANY_REF_OR_ENVIRONMENT: false,
  AWS_ROLE_NAME: "github-actions-ci",
  ROLE_DESCRIPTION: undefined,
  PERMISSION_POLICY_ARNS: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
};

const EXPECTED_ARN = oidcProviderArn(ACCOUNT);

describe("oidc-provider-and-role: check()", () => {
  test("neither provider nor role exist -> missing", async () => {
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "ListOpenIDConnectProvidersCommand") return { OpenIDConnectProviderList: [] };
      if (cmd.constructor.name === "GetRoleCommand") throw awsError("NoSuchEntityException");
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await oidcProviderAndRoleStep.check(ctx)).toBe("missing");
  });

  test("provider exists with the right client id, role missing -> missing", async () => {
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "ListOpenIDConnectProvidersCommand") {
        return { OpenIDConnectProviderList: [{ Arn: EXPECTED_ARN }] };
      }
      if (cmd.constructor.name === "GetOpenIDConnectProviderCommand") return { ClientIDList: ["sts.amazonaws.com"] };
      if (cmd.constructor.name === "GetRoleCommand") throw awsError("NoSuchEntityException");
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await oidcProviderAndRoleStep.check(ctx)).toBe("missing");
  });

  test("both provider and role already exist -> exists", async () => {
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "ListOpenIDConnectProvidersCommand") {
        return { OpenIDConnectProviderList: [{ Arn: EXPECTED_ARN }] };
      }
      if (cmd.constructor.name === "GetOpenIDConnectProviderCommand") return { ClientIDList: ["sts.amazonaws.com"] };
      if (cmd.constructor.name === "GetRoleCommand") return { Role: {} };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await oidcProviderAndRoleStep.check(ctx)).toBe("exists");
  });

  test("provider exists but with a different client id set -> conflict", async () => {
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "ListOpenIDConnectProvidersCommand") {
        return { OpenIDConnectProviderList: [{ Arn: EXPECTED_ARN }] };
      }
      if (cmd.constructor.name === "GetOpenIDConnectProviderCommand") return { ClientIDList: ["some-other-audience"] };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await oidcProviderAndRoleStep.check(ctx)).toBe("conflict");
  });
});

describe("oidc-provider-and-role: create()", () => {
  test("creates the provider (no ThumbprintList) and the role with the GitHub OIDC trust policy when both are missing", async () => {
    const sent: string[] = [];
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListOpenIDConnectProvidersCommand") return { OpenIDConnectProviderList: [] };
      if (cmd.constructor.name === "CreateOpenIDConnectProviderCommand") {
        expect(cmd.input.ThumbprintList).toBeUndefined();
        expect(cmd.input.ClientIDList).toEqual(["sts.amazonaws.com"]);
        return {};
      }
      if (cmd.constructor.name === "GetRoleCommand") throw awsError("NoSuchEntityException");
      if (cmd.constructor.name === "CreateRoleCommand") {
        const doc = JSON.parse(cmd.input.AssumeRolePolicyDocument as string);
        expect(doc.Statement[0].Principal.Federated).toBe(EXPECTED_ARN);
        expect(doc.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]).toBe(
          "repo:acme/widgets:ref:refs/heads/main",
        );
        return { Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/github-actions-ci` } };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await oidcProviderAndRoleStep.create!(ctx);
    expect(outputs.oidcProviderCreatedThisRun).toBe(true);
    expect(outputs.roleCreatedThisRun).toBe(true);
    expect(sent).toContain("CreateOpenIDConnectProviderCommand");
    expect(sent).toContain("CreateRoleCommand");
  });

  test("reuses an existing provider without re-creating it", async () => {
    const sent: string[] = [];
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListOpenIDConnectProvidersCommand") {
        return { OpenIDConnectProviderList: [{ Arn: EXPECTED_ARN }] };
      }
      if (cmd.constructor.name === "GetRoleCommand") throw awsError("NoSuchEntityException");
      if (cmd.constructor.name === "CreateRoleCommand") return { Role: {} };
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await oidcProviderAndRoleStep.create!(ctx);
    expect(outputs.oidcProviderCreatedThisRun).toBeUndefined();
    expect(sent).not.toContain("CreateOpenIDConnectProviderCommand");
  });
});

describe("oidc-provider-and-role: rollback()", () => {
  test("deletes the role and the provider ONLY if this run created them", async () => {
    const sent: string[] = [];
    const ctx = oidcCtx(BASE_PARAMS, { roleCreatedThisRun: true, oidcProviderCreatedThisRun: true }, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await oidcProviderAndRoleStep.rollback(ctx);
    expect(sent).toEqual(["DeleteRoleCommand", "DeleteOpenIDConnectProviderCommand"]);
  });

  test("never deletes a pre-existing, shared provider", async () => {
    const sent: string[] = [];
    const ctx = oidcCtx(BASE_PARAMS, { roleCreatedThisRun: true, oidcProviderCreatedThisRun: false }, (cmd) => {
      sent.push(cmd.constructor.name);
      return {};
    });
    await oidcProviderAndRoleStep.rollback(ctx);
    expect(sent).toEqual(["DeleteRoleCommand"]);
  });
});

describe("trust-policy-and-attach: reconcile()", () => {
  test("PUTs a new trust policy and attaches missing permission policies", async () => {
    const sent: string[] = [];
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") {
        return { Role: { AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify({ Version: "2012-10-17", Statement: [] })) } };
      }
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") return { AttachedPolicies: [] };
      return {};
    });
    const outputs = await trustPolicyAndAttachStep.reconcile!(ctx);
    expect(outputs.trustPolicyChanged).toBe(true);
    expect(JSON.parse(outputs.attachedPolicyArnsThisRun as string)).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
    expect(sent).toContain("UpdateAssumeRolePolicyCommand");
    expect(sent).toContain("AttachRolePolicyCommand");
  });

  test("no-op when the trust policy already matches and the policy is already attached", async () => {
    const sent: string[] = [];
    const ctx = oidcCtx(BASE_PARAMS, {}, (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetRoleCommand") {
        const doc = {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Federated: EXPECTED_ARN },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: {
                StringEquals: {
                  "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                  "token.actions.githubusercontent.com:sub": "repo:acme/widgets:ref:refs/heads/main",
                },
              },
            },
          ],
        };
        return { Role: { AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(doc)) } };
      }
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") {
        return { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess" }] };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const outputs = await trustPolicyAndAttachStep.reconcile!(ctx);
    expect(outputs.trustPolicyChanged).toBe(false);
    expect(sent).not.toContain("UpdateAssumeRolePolicyCommand");
    expect(sent).not.toContain("AttachRolePolicyCommand");
  });

  test("ALLOW_ANY_REF_OR_ENVIRONMENT=true builds a StringLike wildcard sub condition", async () => {
    const params: Params = { ...BASE_PARAMS, ALLOW_ANY_REF_OR_ENVIRONMENT: true };
    let capturedDoc: any;
    const ctx = oidcCtx(params, {}, (cmd) => {
      if (cmd.constructor.name === "GetRoleCommand") return { Role: {} };
      if (cmd.constructor.name === "ListAttachedRolePoliciesCommand") return { AttachedPolicies: [] };
      if (cmd.constructor.name === "UpdateAssumeRolePolicyCommand") {
        capturedDoc = JSON.parse(cmd.input.PolicyDocument as string);
      }
      return {};
    });
    await trustPolicyAndAttachStep.reconcile!(ctx);
    expect(capturedDoc.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"]).toBe(
      "repo:acme/widgets:*",
    );
  });
});

describe("trust-policy-and-attach: rollback()", () => {
  test("detaches everything attached this run, then restores the prior trust policy", async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const outputs = {
      trustPolicyChanged: true,
      priorTrustPolicy: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
      attachedPolicyArnsThisRun: JSON.stringify(["arn:aws:iam::aws:policy/ReadOnlyAccess"]),
    };
    const ctx = oidcCtx(BASE_PARAMS, outputs, (cmd) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return {};
    });
    await trustPolicyAndAttachStep.rollback(ctx);
    expect(sent.map((s) => s.name)).toEqual(["DetachRolePolicyCommand", "UpdateAssumeRolePolicyCommand"]);
  });
});
