import { defineIntegration } from "../../../../../src/core/define";
import {
  iamAttachUserPolicyStep,
  iamUserExistsGuardStep,
  userArn,
} from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Attaches a managed policy to a user that already exists — does not create
 * the user. Run `aws/iam/user/create-user` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/attach-policy-to-user",
  schemaVersion: 1,
  summary:
    "Attaches a managed policy to an existing IAM user, proven with a polled read-back of the attachment list.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamUserExistsGuardStep<Params>({ userName: (p) => p.IAM_USER_NAME }),
    iamAttachUserPolicyStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      policyArn: (p) => p.IAM_POLICY_ARN,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.IAM_USER_NAME}-attach`,

  report(ctx) {
    const p = ctx.params;
    return `# Attach Policy to User — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/attach-policy-to-user\`.

## Setting

- User: \`${p.IAM_USER_NAME}\` (\`${userArn(ctx.accountId, p.IAM_USER_NAME)}\`)
- Policy ARN: \`${p.IAM_POLICY_ARN}\`

## Verification

Verified — polled \`ListAttachedUserPolicies\` until it listed \`${p.IAM_POLICY_ARN}\` as attached to \`${p.IAM_USER_NAME}\`.
`;
  },
});
