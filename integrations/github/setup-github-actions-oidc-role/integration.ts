import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { oidcProviderAndRoleStep } from "./steps/oidc-provider-and-role";
import { trustPolicyAndAttachStep } from "./steps/trust-policy-and-attach";
import { verify } from "./verify";

/**
 * The first of two AWS+GitHub combined tasks: wires an AWS IAM role to
 * trust GitHub Actions' OIDC tokens, so a workflow can assume AWS
 * credentials with no long-lived AWS secret stored in GitHub at all — the
 * standard, AWS-and-GitHub-both-recommended replacement for static access
 * keys in CI. A natural alternative to this project's own
 * create-access-key/rotate-access-key tasks for CI use cases specifically.
 *
 * Declares credentials: ["aws"] only — the GitHub owner/repo/scope values
 * are plain strings baked into the trust policy; AWS never validates them
 * against a live GitHub API, so no GitHub token is needed to run this.
 */
export default defineIntegration<Params>({
  id: "github/setup-github-actions-oidc-role",
  schemaVersion: 1,
  summary:
    "Wires an AWS IAM role to trust GitHub Actions' OIDC tokens for a specific repo/branch or environment, proven with a trust-policy read-back.",

  // ALLOW_ANY_REF_OR_ENVIRONMENT arrives as a "true"/"false" string — same
  // ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [oidcProviderAndRoleStep, trustPolicyAndAttachStep],

  verify,

  reportName: (ctx) => `${ctx.params.AWS_ROLE_NAME}-github-oidc`,

  report(ctx) {
    const p = ctx.params;
    const providerArn = String(ctx.outputs.oidcProviderArn ?? "");
    const roleArnValue = String(ctx.outputs.roleArn ?? "");

    return `# GitHub Actions OIDC Role — \`${p.AWS_ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/setup-github-actions-oidc-role\`.

## AWS

- OIDC provider ARN: \`${providerArn}\`
- Role name: \`${p.AWS_ROLE_NAME}\`
- Role ARN: \`${roleArnValue}\`
- Attached permission policies: ${p.PERMISSION_POLICY_ARNS.length}

## Trust scope

- GitHub repo: \`${p.GITHUB_OWNER}/${p.GITHUB_REPO}\`
- Scope: \`${p.ALLOW_ANY_REF_OR_ENVIRONMENT ? "any ref/environment (wildcard)" : `${p.SCOPE_TYPE}:${p.SCOPE_VALUE}`}\`

${
  p.ALLOW_ANY_REF_OR_ENVIRONMENT
    ? "**ALLOW_ANY_REF_OR_ENVIRONMENT=true** — a deliberate, opt-in loosening of the trust condition to a wildcard `StringLike` match, materially widening which workflow runs can assume this role."
    : "Trust condition is a tight `StringEquals` match on this exact branch/environment — the default, safer form."
}

## Usage in a workflow

\`\`\`yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: ${roleArnValue}
      aws-region: <your-region>
\`\`\`

## Verification

Verified — confirmed the OIDC provider's client id list and the role's live
trust policy match what was requested. Cannot confirm a real GitHub Actions
run can successfully assume the role without dispatching one (see
\`github/trigger-workflow-dispatch\` for a natural, optional follow-up).
`;
  },
});
