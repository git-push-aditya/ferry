import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";
import { jsonArrayParam } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  // Plain strings baked into the trust policy's `sub` claim — AWS never
  // validates these against a live GitHub API, so no "github" credential is
  // declared by this integration at all (see README).
  GITHUB_OWNER: githubOwner,
  GITHUB_REPO: githubRepoName,
  SCOPE_TYPE: z.enum(["branch", "environment"]),
  SCOPE_VALUE: nonEmpty,
  // Deliberate opt-in loosening, default false: widens which workflow runs
  // can assume this role from "this exact branch/environment" to "anything
  // in this repo."
  ALLOW_ANY_REF_OR_ENVIRONMENT: boolFlag("false"),

  AWS_ROLE_NAME: nonEmpty,
  ROLE_DESCRIPTION: z.string().optional(),
  PERMISSION_POLICY_ARNS: jsonArrayParam("PERMISSION_POLICY_ARNS", z.string()),
});

export type Params = z.infer<typeof paramsSchema>;

export const OIDC_PROVIDER_URL = "https://token.actions.githubusercontent.com";
export const OIDC_PROVIDER_HOST = "token.actions.githubusercontent.com";
export const OIDC_AUDIENCE = "sts.amazonaws.com";

export function oidcProviderArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:oidc-provider/${OIDC_PROVIDER_HOST}`;
}

/** repo:OWNER/REPO:ref:refs/heads/BRANCH, or the :environment:NAME variant — confirmed formats. */
function subClaim(p: Params): string {
  if (p.ALLOW_ANY_REF_OR_ENVIRONMENT) return `repo:${p.GITHUB_OWNER}/${p.GITHUB_REPO}:*`;
  return p.SCOPE_TYPE === "branch"
    ? `repo:${p.GITHUB_OWNER}/${p.GITHUB_REPO}:ref:refs/heads/${p.SCOPE_VALUE}`
    : `repo:${p.GITHUB_OWNER}/${p.GITHUB_REPO}:environment:${p.SCOPE_VALUE}`;
}

/**
 * Builds the trust policy trusting GitHub Actions' OIDC tokens for this
 * repo's scope. `StringLike` + wildcard only when ALLOW_ANY_REF_OR_ENVIRONMENT
 * is explicitly opted into; `StringEquals` (the tight, default form)
 * otherwise.
 */
export function githubOidcTrustPolicy(accountId: string, p: Params): object {
  const sub = subClaim(p);
  const condition = p.ALLOW_ANY_REF_OR_ENVIRONMENT
    ? { StringLike: { [`${OIDC_PROVIDER_HOST}:sub`]: sub, [`${OIDC_PROVIDER_HOST}:aud`]: OIDC_AUDIENCE } }
    : { StringEquals: { [`${OIDC_PROVIDER_HOST}:aud`]: OIDC_AUDIENCE, [`${OIDC_PROVIDER_HOST}:sub`]: sub } };

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: oidcProviderArn(accountId) },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: condition,
      },
    ],
  };
}
