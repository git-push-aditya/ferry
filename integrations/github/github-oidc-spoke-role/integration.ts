import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { iamConvergePolicyAttachmentsStep, iamRoleStep, iamTrustPolicyStep, roleArn } from "../../../src/providers/aws";
import { paramsSchema, spokeTrustPolicy, type Params } from "./params";
import { verify } from "./verify";

/**
 * The cross-account "N environments, one repo" case. An IAM OIDC provider
 * is account-scoped (confirmed against the CreateOpenIDConnectProvider API
 * reference — a provider URL can only be registered once per account), so
 * a real multi-AWS-account rollout can't share the single provider/role
 * github/setup-github-actions-oidc-role already creates. This integration
 * adopts hub-and-spoke instead of N independent providers: one account
 * (the hub) holds the OIDC provider + a hub role; every other account gets
 * a spoke role trusting the HUB ROLE's ARN via ordinary sts:AssumeRole, not
 * OIDC directly — keeping the OIDC trust surface in exactly one place.
 *
 * Deliberately does not hold multiple AWS credential sets in one run: run
 * this once per target AWS account, with that account's own root .env, same
 * "N secrets = N runs" granularity convention already used elsewhere in
 * this project (see README).
 */
export default defineIntegration<Params>({
  id: "github/github-oidc-spoke-role",
  schemaVersion: 1,
  summary:
    "Creates a role in this AWS account that trusts a hub account's OIDC role via ordinary AssumeRole, proven with a read-back of its trust policy and attached permissions.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    iamRoleStep<Params>({
      roleName: (p) => p.SPOKE_ROLE_NAME,
      trustPolicy: (p) => spokeTrustPolicy(p.HUB_ROLE_ARN),
      description: (p) => p.ROLE_DESCRIPTION,
    }),
    iamTrustPolicyStep<Params>({
      roleName: (p) => p.SPOKE_ROLE_NAME,
      document: (ctx) => spokeTrustPolicy(ctx.params.HUB_ROLE_ARN),
    }),
    iamConvergePolicyAttachmentsStep<Params>({
      roleName: (p) => p.SPOKE_ROLE_NAME,
      desiredArns: (p) => p.SPOKE_PERMISSION_POLICY_ARNS,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.SPOKE_ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const spokeArn = roleArn(ctx.accountId, p.SPOKE_ROLE_NAME);

    return `# GitHub OIDC Spoke Role — \`${p.SPOKE_ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/github-oidc-spoke-role\`.

## Roles

- This account's spoke role: \`${p.SPOKE_ROLE_NAME}\` (\`${spokeArn}\`)
- Trusts (assumes-from): \`${p.HUB_ROLE_ARN}\`

## Attached permissions

${p.SPOKE_PERMISSION_POLICY_ARNS.length ? p.SPOKE_PERMISSION_POLICY_ARNS.map((a) => `- \`${a}\``).join("\n") : "(none)"}

## Usage in a workflow (two-hop assume-role chain)

\`\`\`yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: ${p.HUB_ROLE_ARN}
      aws-region: <hub-region>
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: ${spokeArn}
      role-chaining: true
      aws-region: <this-account-region>
\`\`\`

## Verification

Verified — confirmed this role's trust policy matches the hub role ARN
exactly and its attached policies match \`SPOKE_PERMISSION_POLICY_ARNS\`
exactly.
`;
  },
});
