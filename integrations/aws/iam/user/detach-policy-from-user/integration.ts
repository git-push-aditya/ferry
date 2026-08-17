import { defineIntegration } from "../../../../../src/core/define";
import { iamDetachUserPolicyStep, userArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Detaches a managed policy from a user. Deliberately no
 * `iamUserExistsGuardStep` here, unlike attach-policy-to-user: that guard
 * always folds "missing" into "conflict", which is right for attach (there is
 * nothing sensible to attach to a user that isn't there) but wrong for detach
 * — a user that's already gone means the detachment's target state (the
 * attachment doesn't exist) is already achieved. `iamDetachUserPolicyStep`'s
 * own check() already treats NoSuchEntityException on the user as "exists"
 * (see src/providers/aws/iam.ts), so this integration is a single step and is
 * a safe no-op whether the user, the policy, or the attachment is missing.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/detach-policy-from-user",
  schemaVersion: 1,
  summary:
    "Detaches a managed policy from an IAM user, proven with a polled read-back of the attachment list. Idempotent no-op if the user or policy is already gone.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamDetachUserPolicyStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      policyArn: (p) => p.IAM_POLICY_ARN,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.IAM_USER_NAME}-detach`,

  report(ctx) {
    const p = ctx.params;
    return `# Detach Policy from User — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/detach-policy-from-user\`.

## Setting

- User: \`${p.IAM_USER_NAME}\` (\`${userArn(ctx.accountId, p.IAM_USER_NAME)}\`)
- Policy ARN: \`${p.IAM_POLICY_ARN}\`

## Verification

Verified — polled \`ListAttachedUserPolicies\` until it no longer listed \`${p.IAM_POLICY_ARN}\` as attached to \`${p.IAM_USER_NAME}\`.
`;
  },
});
