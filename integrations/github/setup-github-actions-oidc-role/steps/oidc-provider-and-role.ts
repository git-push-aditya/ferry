import {
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  DeleteOpenIDConnectProviderCommand,
  DeleteRoleCommand,
  GetOpenIDConnectProviderCommand,
  ListOpenIDConnectProvidersCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, isNoSuchEntity, roleArn, roleState } from "../../../../src/providers/aws";
import { githubOidcTrustPolicy, oidcProviderArn, OIDC_AUDIENCE, OIDC_PROVIDER_URL, type Params } from "../params";

/**
 * Two independent AWS-side resources, checked jointly — same "two pieces of
 * state" shape as assign-elastic-ip. This step only ensures BARE existence
 * of both: the OIDC provider (account-scoped, shared, one-per-URL-per-
 * account per the fetched OIDC docs — no ownership ambiguity the way S3
 * bucket names have) and the role (with its real trust policy computed
 * immediately, since — unlike the Snowflake storage-integration case —
 * nothing external needs to mint an id first; the provider's ARN is
 * deterministic from accountId + a fixed URL). Trust-policy correctness on
 * an ALREADY-EXISTING role, and policy attachment, are the next step's job.
 */
export const oidcProviderAndRoleStep: Step<Params> = {
  id: "oidc-provider-and-role",
  title: "Ensure the GitHub OIDC provider and IAM role exist",

  async check(ctx) {
    const { iam } = awsClients(ctx);
    const expectedArn = oidcProviderArn(ctx.accountId);

    const providers = await iam.send(new ListOpenIDConnectProvidersCommand({}));
    const match = (providers.OpenIDConnectProviderList ?? []).find((p) => p.Arn === expectedArn);

    let providerState: "missing" | "exists" | "conflict" = "missing";
    if (match) {
      const details = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: expectedArn }));
      const clientIds = details.ClientIDList ?? [];
      providerState = clientIds.includes(OIDC_AUDIENCE) ? "exists" : "conflict";
      if (providerState === "conflict") {
        ctx.log.warn(
          `OIDC provider ${expectedArn} already exists but its ClientIDList (${clientIds.join(", ")}) ` +
            `does not include "${OIDC_AUDIENCE}" — refusing to reuse a differently-configured provider.`,
        );
      }
    }
    if (providerState === "conflict") return "conflict";

    const roleState_ = await roleState(iam, ctx.params.AWS_ROLE_NAME);
    if (providerState === "exists" && roleState_ === "exists") return "exists";
    return "missing";
  },

  async create(ctx) {
    const { iam } = awsClients(ctx);
    const expectedArn = oidcProviderArn(ctx.accountId);
    const outputs: Record<string, unknown> = {};

    const providers = await iam.send(new ListOpenIDConnectProvidersCommand({}));
    const providerAlreadyThere = (providers.OpenIDConnectProviderList ?? []).some((p) => p.Arn === expectedArn);
    if (!providerAlreadyThere) {
      // Modern AWS accounts no longer require a manually-supplied thumbprint
      // for GitHub's provider (AWS validates GitHub's certificate chain
      // automatically) — flagged in the README as the lowest-confidence
      // fact in this integration, worth re-confirming against the live SDK
      // version before relying on this in a new AWS account.
      await iam.send(
        new CreateOpenIDConnectProviderCommand({ Url: OIDC_PROVIDER_URL, ClientIDList: [OIDC_AUDIENCE] }),
      );
      outputs.oidcProviderCreatedThisRun = true;
      ctx.log.success(`Created OIDC provider ${expectedArn}`);
    } else {
      ctx.log.info(`OIDC provider ${expectedArn} already exists — reusing`);
    }
    outputs.oidcProviderArn = expectedArn;

    const existingRoleState = await roleState(iam, ctx.params.AWS_ROLE_NAME);
    if (existingRoleState === "missing") {
      const created = await iam.send(
        new CreateRoleCommand({
          RoleName: ctx.params.AWS_ROLE_NAME,
          AssumeRolePolicyDocument: JSON.stringify(githubOidcTrustPolicy(ctx.accountId, ctx.params)),
          Description: ctx.params.ROLE_DESCRIPTION,
        }),
      );
      outputs.roleArn = created.Role?.Arn ?? roleArn(ctx.accountId, ctx.params.AWS_ROLE_NAME);
      outputs.roleCreatedThisRun = true;
      ctx.log.success(`Created role "${ctx.params.AWS_ROLE_NAME}" with the GitHub OIDC trust policy`);
    } else {
      outputs.roleArn = roleArn(ctx.accountId, ctx.params.AWS_ROLE_NAME);
      ctx.log.info(`Role "${ctx.params.AWS_ROLE_NAME}" already exists — trust policy reconciled next`);
    }

    return outputs;
  },

  /**
   * The OIDC provider is NOT deleted unless this run created it fresh — a
   * shared provider may be relied on by other, unrelated roles in the same
   * account, so deleting it as a side effect of rolling back one role's
   * setup would be a much wider blast radius than this task's own scope.
   */
  async rollback(ctx) {
    const { iam } = awsClients(ctx);

    if (ctx.outputs.roleCreatedThisRun === true) {
      try {
        await iam.send(new DeleteRoleCommand({ RoleName: ctx.params.AWS_ROLE_NAME }));
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }

    if (ctx.outputs.oidcProviderCreatedThisRun === true) {
      try {
        await iam.send(
          new DeleteOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: oidcProviderArn(ctx.accountId) }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_oidc_role",
      name: ctx.params.AWS_ROLE_NAME,
      attributes: {
        providerArn: String(ctx.outputs.oidcProviderArn ?? oidcProviderArn(ctx.accountId)),
        roleArn: String(ctx.outputs.roleArn ?? roleArn(ctx.accountId, ctx.params.AWS_ROLE_NAME)),
        githubRepo: `${ctx.params.GITHUB_OWNER}/${ctx.params.GITHUB_REPO}`,
      },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_role",
      address: "aws_iam_role.github_actions_oidc",
      importId: (ctx) => ctx.params.AWS_ROLE_NAME,
    },
  },
};
