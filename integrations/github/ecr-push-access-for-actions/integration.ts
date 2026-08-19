import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { awsClients, ecrRepositoryArn, iamInlinePolicyStep, iamRoleExistsGuardStep } from "../../../src/providers/aws";
import { ecrPushPolicyDocument, inlinePolicyName, paramsSchema, type Params } from "./params";
import { ecrRepoStep } from "./steps/ecr-repo";
import { verify } from "./verify";

/**
 * Lets an existing GitHub Actions OIDC role (github/setup-github-actions-
 * oidc-role, run separately — this task never mints it) push images to one
 * ECR repository. Never re-creates the OIDC provider or role — only adds
 * the ECR repo and a scoped inline policy.
 */
export default defineIntegration<Params>({
  id: "github/ecr-push-access-for-actions",
  schemaVersion: 1,
  summary:
    "Creates an ECR repository and grants an existing GitHub Actions OIDC role push access to it, proven with a read-back of both.",

  // ALLOW_DESTRUCTIVE_ROLLBACK arrives as a "true"/"false" string — same
  // ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.AWS_ROLE_NAME }),
    ecrRepoStep,
    iamInlinePolicyStep<Params>({
      roleName: (p) => p.AWS_ROLE_NAME,
      policyName: (p) => inlinePolicyName(p.ECR_REPOSITORY_NAME),
      document: (ctx) =>
        ecrPushPolicyDocument(ctx.accountId, awsClients(ctx).region, ctx.params.ECR_REPOSITORY_NAME),
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.ECR_REPOSITORY_NAME,

  report(ctx) {
    const p = ctx.params;
    const arn = ecrRepositoryArn(ctx.accountId, awsClients(ctx).region, p.ECR_REPOSITORY_NAME);

    return `# ECR Push Access for GitHub Actions — \`${p.ECR_REPOSITORY_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/ecr-push-access-for-actions\`.

## ECR

- Repository: \`${p.ECR_REPOSITORY_NAME}\`
- Repository ARN: \`${arn}\`
- Image tag mutability: \`${p.IMAGE_TAG_MUTABILITY}\`

## IAM

- Role: \`${p.AWS_ROLE_NAME}\` (pre-existing — this task does not create it)
- Inline policy: \`${inlinePolicyName(p.ECR_REPOSITORY_NAME)}\`

## Usage in a workflow

\`\`\`yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: <role arn>
      aws-region: <your-region>
  - uses: aws-actions/amazon-ecr-login@v2
  - run: docker push ${arn.replace("arn:aws:ecr:", "").split(":repository/")[0]}...
\`\`\`

## Verification

Verified — confirmed the repository exists and the role's inline policy
matches the desired document exactly.
`;
  },
});
