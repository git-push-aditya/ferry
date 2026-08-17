import { GetOpenIDConnectProviderCommand, GetRoleCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../src/core/define";
import { awsClients } from "../../../src/providers/aws";
import { githubOidcTrustPolicy, oidcProviderArn, OIDC_AUDIENCE, type Params } from "./params";

/**
 * Confirms the OIDC provider exists with the expected ClientIDList, and the
 * role's live trust policy matches field-for-field. Does NOT confirm a real
 * GitHub Actions run can successfully assume the role — that would require
 * dispatching a workflow (github/trigger-workflow-dispatch) configured to
 * attempt the assumption, a natural but optional composition this task
 * does not build automatically (forcing a live workflow run on every apply
 * would be a surprising, possibly costly side effect).
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const expectedArn = oidcProviderArn(ctx.accountId);

  const provider = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: expectedArn }));
  if (!(provider.ClientIDList ?? []).includes(OIDC_AUDIENCE)) {
    throw new Error(`OIDC provider ${expectedArn} does not list "${OIDC_AUDIENCE}" as a client id`);
  }

  const role = await iam.send(new GetRoleCommand({ RoleName: ctx.params.AWS_ROLE_NAME }));
  const rawDoc = role.Role?.AssumeRolePolicyDocument;
  if (!rawDoc) throw new Error(`Could not read the trust policy of ${ctx.params.AWS_ROLE_NAME}`);
  const live = JSON.parse(decodeURIComponent(rawDoc));
  const desired = githubOidcTrustPolicy(ctx.accountId, ctx.params);
  if (JSON.stringify(live) !== JSON.stringify(desired)) {
    throw new Error(`Trust policy on "${ctx.params.AWS_ROLE_NAME}" does not match the desired GitHub OIDC document`);
  }

  ctx.log.success(
    `Confirmed OIDC provider + role "${ctx.params.AWS_ROLE_NAME}" trust policy — cannot confirm a live ` +
      `GitHub Actions run can actually assume it without dispatching one`,
  );
}
