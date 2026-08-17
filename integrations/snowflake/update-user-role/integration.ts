import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { updateRoleStep } from "./steps/update-role";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "snowflake/update-user-role",
  schemaVersion: 1,
  summary:
    "Sets a Snowflake user's DEFAULT_ROLE — the role a session assumes automatically at login — to a role already granted to them.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, updateRoleStep],

  verify,

  reportName: (ctx) => ctx.params.USER_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Update Default Role — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/update-user-role\`.

## What happened

- User: \`${p.USER_NAME}\`
- New \`DEFAULT_ROLE\`: \`${p.TARGET_DEFAULT_ROLE}\`

This changes which role a session assumes automatically at login. It does
**not** grant a new role — \`${p.TARGET_DEFAULT_ROLE}\` must already be granted
to \`${p.USER_NAME}\` (see \`snowflake/grant-role-to-user\`).

## Verification

\`DESC USER ${p.USER_NAME}\` shows \`DEFAULT_ROLE\` = \`${p.TARGET_DEFAULT_ROLE}\`.
`;
  },
});
