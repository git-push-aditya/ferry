import { defineIntegration } from "../../../../../src/core/define";
import {
  iamAttachRolePolicyStep,
  iamRoleExistsGuardStep,
  roleArn,
} from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Attaches a managed policy to a role that already exists — does not create
 * the role. Run `aws/iam/role/create-role` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/attach-policy-to-role",
  schemaVersion: 1,
  summary:
    "Attaches a managed policy to an existing IAM role, proven with a polled read-back of the attachment list.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.ROLE_NAME }),
    iamAttachRolePolicyStep<Params>({
      roleName: (p) => p.ROLE_NAME,
      policyArn: (p) => p.POLICY_ARN,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.ROLE_NAME}-attach`,

  report(ctx) {
    const p = ctx.params;
    return `# Attach Policy to Role — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/attach-policy-to-role\`.

## Setting

- Role: \`${p.ROLE_NAME}\` (\`${roleArn(ctx.accountId, p.ROLE_NAME)}\`)
- Policy ARN: \`${p.POLICY_ARN}\`

## Verification

Verified — polled \`ListAttachedRolePolicies\` until it listed \`${p.POLICY_ARN}\` as attached to \`${p.ROLE_NAME}\`.
`;
  },
});
