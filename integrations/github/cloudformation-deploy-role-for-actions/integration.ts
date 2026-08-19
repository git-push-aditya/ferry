import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { awsClients, iamConvergePolicyAttachmentsStep, iamInlinePolicyStep, iamRoleExistsGuardStep, roleArn } from "../../../src/providers/aws";
import { ciRoleCfnPolicyDocument, ciRolePolicyName, paramsSchema, type Params } from "./params";
import { executionRoleStep } from "./steps/execution-role";
import { verify } from "./verify";

/**
 * A deliberate two-role split, not a single broad CI role: the CI role
 * (OIDC-trusted, what GitHub Actions actually assumes) is only ever allowed
 * to call cloudformation:* and iam:PassRole — nothing else. A separate
 * execution role (trusted by cloudformation.amazonaws.com, not GitHub) holds
 * the actual resource-creation permissions CloudFormation needs mid-deploy.
 * This exists so a compromised or over-broad CI token can't directly create
 * arbitrary AWS resources — it can only ask CloudFormation to, and
 * CloudFormation's own execution role is the real permission boundary.
 *
 * Never mints AWS_ROLE_NAME itself — run
 * github/setup-github-actions-oidc-role first.
 */
export default defineIntegration<Params>({
  id: "github/cloudformation-deploy-role-for-actions",
  schemaVersion: 1,
  summary:
    "Creates a CloudFormation execution role and grants an existing GitHub Actions OIDC role a PassRole-gated deploy policy, proven with a read-back of both.",

  // ALLOW_DESTRUCTIVE_ROLLBACK arrives as a "true"/"false" string — same
  // ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.AWS_ROLE_NAME }),
    executionRoleStep,
    iamConvergePolicyAttachmentsStep<Params>({
      roleName: (p) => p.CFN_EXECUTION_ROLE_NAME,
      desiredArns: (p) => p.EXECUTION_POLICY_ARNS,
      id: "execution-role-policies",
      title: "Converge the execution role's managed-policy attachments",
    }),
    iamInlinePolicyStep<Params>({
      roleName: (p) => p.AWS_ROLE_NAME,
      policyName: () => ciRolePolicyName(),
      document: (ctx) => ciRoleCfnPolicyDocument(ctx.accountId, awsClients(ctx).region, ctx.params),
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.CFN_EXECUTION_ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const execArn = roleArn(ctx.accountId, p.CFN_EXECUTION_ROLE_NAME);
    const ciArn = roleArn(ctx.accountId, p.AWS_ROLE_NAME);

    return `# CloudFormation Deploy Role for GitHub Actions — \`${p.CFN_EXECUTION_ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/cloudformation-deploy-role-for-actions\`.

## Roles

| Role | Trust | Purpose |
| --- | --- | --- |
| \`${p.AWS_ROLE_NAME}\` (\`${ciArn}\`) | GitHub Actions OIDC (pre-existing) | what CI assumes — can only call cloudformation:* + PassRole to the execution role below |
| \`${p.CFN_EXECUTION_ROLE_NAME}\` (\`${execArn}\`) | \`cloudformation.amazonaws.com\` | what CloudFormation assumes mid-deploy — holds the real resource-creation permissions |

## Execution role permissions

${p.EXECUTION_POLICY_ARNS.map((a) => `- \`${a}\``).join("\n")}

## Scope

- CI role's cloudformation:* actions are scoped to stacks matching \`${p.STACK_NAME_PREFIX}*\`
- CI role's PassRole is scoped to \`${execArn}\` only, gated on \`iam:PassedToService == cloudformation.amazonaws.com\`

## Verification

Verified — confirmed the execution role's trust policy and attached
policies match exactly, and the CI role's inline policy matches the
desired CFN+PassRole document exactly.
`;
  },
});
