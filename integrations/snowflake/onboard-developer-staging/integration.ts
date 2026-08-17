import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { onboardStep } from "./steps/onboard";
import { verify } from "./verify";

/**
 * Onboards a new developer into the STAGING Snowflake account: creates the
 * user with key-pair-only auth and grants their default role.
 *
 * "Staging" here is not a Ferry-level parameter — it is simply whichever
 * Snowflake account the root `.env`'s SNOWFLAKE_ACCOUNT (and matching admin
 * credentials) point at when this integration runs. See README.md.
 */
export default defineIntegration<Params>({
  id: "snowflake/onboard-developer-staging",
  schemaVersion: 1,
  summary:
    "Onboards a new developer into the staging Snowflake account: creates their user with key-pair auth and grants the default role.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, onboardStep],

  verify,

  reportName: (ctx) => `staging-${ctx.params.USER_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Developer Onboarding (staging) — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/onboard-developer-staging\`.
> This ran against whichever Snowflake account the root \`.env\` pointed at —
> confirm that was the intended staging account.

## User

- Username: \`${p.USER_NAME}\`
- Email: \`${p.EMAIL}\`
- Default role: \`${p.DEFAULT_ROLE}\`
- Auth: key-pair only (no password set); public key registered as \`RSA_PUBLIC_KEY\`

## Verification

Verified — \`${p.USER_NAME}\` exists and holds the \`${p.DEFAULT_ROLE}\` role grant.
`;
  },
});
