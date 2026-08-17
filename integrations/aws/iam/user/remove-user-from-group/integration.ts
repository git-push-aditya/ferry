import { defineIntegration } from "../../../../../src/core/define";
import { iamRemoveUserFromGroupStep, userArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Removes a user from a group. Deliberately no `iamUserExistsGuardStep` here,
 * unlike add-user-to-group: that guard always folds "missing" into
 * "conflict", which is right for add (there is nothing sensible to add a
 * nonexistent user to) but wrong for remove — a user (or group) that's
 * already gone means the removal's target state (the user isn't a member) is
 * already achieved. `iamRemoveUserFromGroupStep`'s own check() already
 * treats NoSuchEntityException as "exists" (see src/providers/aws/iam.ts), so
 * this integration is a single step and a safe no-op whether the user, the
 * group, or the membership is missing.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/remove-user-from-group",
  schemaVersion: 1,
  summary:
    "Removes an IAM user from a group, proven with a polled read-back of the membership list. Idempotent no-op if the user or group is already gone.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamRemoveUserFromGroupStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      groupName: (p) => p.IAM_GROUP_NAME,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.IAM_USER_NAME}-remove-from-group`,

  report(ctx) {
    const p = ctx.params;
    return `# Remove User from Group — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/remove-user-from-group\`.

## Setting

- User: \`${p.IAM_USER_NAME}\` (\`${userArn(ctx.accountId, p.IAM_USER_NAME)}\`)
- Group: \`${p.IAM_GROUP_NAME}\`

## Verification

Verified — polled \`ListGroupsForUser\` until it no longer listed \`${p.IAM_GROUP_NAME}\` as a membership of \`${p.IAM_USER_NAME}\`.

Safe to re-run even if the user was already removed — idempotent no-op.
`;
  },
});
