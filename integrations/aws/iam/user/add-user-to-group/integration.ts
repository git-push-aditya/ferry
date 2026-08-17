import { defineIntegration } from "../../../../../src/core/define";
import {
  iamAddUserToGroupStep,
  iamUserExistsGuardStep,
  userArn,
} from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Adds a user to a group that already exists — does not create the user or
 * the group. Run `aws/iam/user/create-user` first if the user doesn't exist
 * yet. Group lifecycle is out of scope for this task (not among the tasks in
 * the plan), so a missing group is not guarded against here: it will surface
 * as a plain `NoSuchEntityException` from `AddUserToGroupCommand` during
 * apply, which the engine handles as a normal step failure.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/add-user-to-group",
  schemaVersion: 1,
  summary:
    "Adds an existing IAM user to an existing IAM group, proven with a polled read-back of the membership list.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamUserExistsGuardStep<Params>({ userName: (p) => p.IAM_USER_NAME }),
    iamAddUserToGroupStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      groupName: (p) => p.IAM_GROUP_NAME,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.IAM_USER_NAME}-add-to-group`,

  report(ctx) {
    const p = ctx.params;
    return `# Add User to Group — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/add-user-to-group\`.

## Setting

- User: \`${p.IAM_USER_NAME}\` (\`${userArn(ctx.accountId, p.IAM_USER_NAME)}\`)
- Group: \`${p.IAM_GROUP_NAME}\`

## Verification

Verified — polled \`ListGroupsForUser\` until it listed \`${p.IAM_GROUP_NAME}\` as a membership of \`${p.IAM_USER_NAME}\`.

## Note

IAM caps group membership at 10 groups per user by default. If this user is
already near that cap, the 11th \`AddUserToGroup\` call fails with
\`LimitExceeded\` — this integration does not pre-check the count, it simply
surfaces that AWS-side error if it happens.
`;
  },
});
