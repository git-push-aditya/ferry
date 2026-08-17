import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { grantStep } from "./steps/grant";
import { verify } from "./verify";

/**
 * Grants an existing Snowflake role to an existing Snowflake user.
 *
 * Both the user and the role are real preconditions this integration does
 * not create — see README.
 */
export default defineIntegration<Params>({
  id: "snowflake/grant-role-to-user",
  schemaVersion: 1,
  summary: "Grants an existing Snowflake role to an existing Snowflake user.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, grantStep],

  verify,

  reportName: (ctx) => `${ctx.params.USER_NAME}-${ctx.params.ROLE_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Role Grant — \`${p.ROLE_NAME}\` → \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/grant-role-to-user\`.

## Grant

- User: \`${p.USER_NAME}\`
- Role: \`${p.ROLE_NAME}\`

## Verification

Verified — \`SHOW GRANTS TO USER ${p.USER_NAME}\` includes a row for \`${p.ROLE_NAME}\`.
`;
  },
});
