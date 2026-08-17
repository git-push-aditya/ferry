import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { onboardStep } from "./steps/onboard";
import { verify } from "./verify";

/**
 * Onboards a new developer into the PRODUCTION Snowflake account: creates
 * the user with key-pair-only auth and grants their default role.
 *
 * Structurally identical to `onboard-developer-staging` — same steps, same
 * SQL, same rollback semantics. The only real difference is which Snowflake
 * account the root `.env` points at when this runs, plus the expectation
 * (process, not code — Ferry has no approval-gate concept) that whoever runs
 * this has already been through their org's real prod-access approval
 * process. See README.md.
 */
export default defineIntegration<Params>({
  id: "snowflake/onboard-developer-prod",
  schemaVersion: 1,
  summary:
    "Onboards a new developer into the PRODUCTION Snowflake account: creates their user with key-pair auth and grants the default role. Requires prior out-of-band prod-access approval.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, onboardStep],

  verify,

  reportName: (ctx) => `prod-${ctx.params.USER_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Developer Onboarding (PROD) — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/onboard-developer-prod\`.
> This ran against whichever Snowflake account the root \`.env\` pointed at —
> confirm that was the intended PROD account, and that prod-access approval
> already happened out of band before this ran.

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
