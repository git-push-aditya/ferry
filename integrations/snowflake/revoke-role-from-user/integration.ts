import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { revokeStep } from "./steps/revoke";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "snowflake/revoke-role-from-user",
  schemaVersion: 1,
  summary: "Revokes a role grant from a Snowflake user, idempotently.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, revokeStep],

  verify,

  reportName: (ctx) => `${ctx.params.USER_NAME}_${ctx.params.ROLE_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Revoke Role — \`${p.ROLE_NAME}\` from \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/revoke-role-from-user\`.

## What happened

- User: \`${p.USER_NAME}\`
- Role: \`${p.ROLE_NAME}\`
- Action: revoked (or already absent — safe no-op)

## Verification

\`SHOW GRANTS TO USER ${p.USER_NAME}\` no longer includes \`${p.ROLE_NAME}\`.
`;
  },
});
