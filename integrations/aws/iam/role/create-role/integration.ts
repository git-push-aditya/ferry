import { defineIntegration } from "../../../../../src/core/define";
import { iamRoleStep, roleArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * The root of the dependency graph for every other aws/iam/role/* task: a
 * bare role with a trust policy, and nothing else attached. Managed/inline
 * policies, tags, and trust-policy updates are separate, composable tasks
 * that assume this one already ran.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/create-role",
  schemaVersion: 1,
  summary:
    "Creates an IAM role with the given trust policy, proven by re-reading it back and comparing documents.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamRoleStep<Params>({
      roleName: (p) => p.ROLE_NAME,
      trustPolicy: (p) => JSON.parse(p.TRUST_POLICY),
      path: (p) => p.PATH,
      description: (p) => p.DESCRIPTION,
      maxSessionDurationSeconds: (p) => p.MAX_SESSION_DURATION_SECONDS,
      permissionsBoundaryArn: (p) => p.PERMISSIONS_BOUNDARY_ARN,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const arn = String(ctx.outputs.roleArn ?? roleArn(ctx.accountId, p.ROLE_NAME));
    const trustPolicy = JSON.parse(p.TRUST_POLICY);

    return `# IAM Role — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/create-role\`.

## AWS IAM

- Role name: \`${p.ROLE_NAME}\`
- Role ARN: \`${arn}\`
- Path: \`${p.PATH ?? "/"}\`
- Description: ${p.DESCRIPTION ? `\`${p.DESCRIPTION}\`` : "(none)"}
- Max session duration: ${p.MAX_SESSION_DURATION_SECONDS ? `${p.MAX_SESSION_DURATION_SECONDS}s` : "AWS default (3600s)"}
- Permissions boundary: ${p.PERMISSIONS_BOUNDARY_ARN ? `\`${p.PERMISSIONS_BOUNDARY_ARN}\`` : "(none)"}

## Trust policy

\`\`\`json
${JSON.stringify(trustPolicy, null, 2)}
\`\`\`

## Verification

Verified — re-read the role's trust policy and confirmed it deep-equals the
document above.
`;
  },
});
