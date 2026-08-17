import { defineIntegration } from "../../../../../src/core/define";
import { iamDetachRolePolicyStep, roleArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Detaches a managed policy from a role. Deliberately no
 * `iamRoleExistsGuardStep` here, unlike attach-policy-to-role: that guard
 * always folds "missing" into "conflict", which is right for attach (there is
 * nothing sensible to attach to a role that isn't there) but wrong for detach
 * — a role that's already gone means the detachment's target state (the
 * attachment doesn't exist) is already achieved. `iamDetachRolePolicyStep`'s
 * own check() already treats NoSuchEntityException on the role as "exists"
 * (see src/providers/aws/iam.ts), so this integration is a single step and is
 * a safe no-op whether the role, the policy, or the attachment is missing.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/detach-policy-from-role",
  schemaVersion: 1,
  summary:
    "Detaches a managed policy from an IAM role, proven with a polled read-back of the attachment list. Idempotent no-op if the role or policy is already gone.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamDetachRolePolicyStep<Params>({
      roleName: (p) => p.ROLE_NAME,
      policyArn: (p) => p.POLICY_ARN,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.ROLE_NAME}-detach`,

  report(ctx) {
    const p = ctx.params;
    return `# Detach Policy from Role — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/detach-policy-from-role\`.

## Setting

- Role: \`${p.ROLE_NAME}\` (\`${roleArn(ctx.accountId, p.ROLE_NAME)}\`)
- Policy ARN: \`${p.POLICY_ARN}\`

## Verification

Verified — polled \`ListAttachedRolePolicies\` until it no longer listed \`${p.POLICY_ARN}\` as attached to \`${p.ROLE_NAME}\`.
`;
  },
});
