import { defineIntegration } from "../../../../../src/core/define";
import { iamUserStep, userArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Provisions a bare IAM user — no policy, no access key, no group. Every
 * other user-scoped task in aws/iam/user (create-access-key, attach-policy,
 * add-to-group, ...) depends on this one having run first.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/create-user",
  schemaVersion: 1,
  summary:
    "Provisions an IAM user, optionally scoped to a path and/or a permissions boundary, proven with a live re-read.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamUserStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      path: (p) => p.IAM_USER_PATH,
      permissionsBoundaryArn: (p) => p.IAM_PERMISSIONS_BOUNDARY_ARN,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# IAM User — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/create-user\`.

## IAM

- User name: \`${p.IAM_USER_NAME}\`
- User ARN: \`${userArn(ctx.accountId, p.IAM_USER_NAME)}\`
- Path: \`${p.IAM_USER_PATH ?? "/"}\`
- Permissions boundary: \`${p.IAM_PERMISSIONS_BOUNDARY_ARN ?? "(none)"}\`

## Verification

Verified — re-read the user with \`GetUser\` and confirmed \`UserName\`${
      p.IAM_USER_PATH ? ", \`Path\`" : ""
    }${p.IAM_PERMISSIONS_BOUNDARY_ARN ? ", and permissions boundary" : ""} match what was requested.
`;
  },
});
