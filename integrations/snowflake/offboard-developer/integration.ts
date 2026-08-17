import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { offboardStep } from "./steps/offboard";
import { verify } from "./verify";

/**
 * Offboards a departed developer from the Snowflake account the root `.env`
 * currently points at: revokes every granted role, then either disables the
 * user (default, reversible) or drops it outright (opt-in, irreversible).
 *
 * Default is DISABLE, not DROP — `ALTER USER ... SET DISABLED = TRUE`
 * immediately blocks login and aborts running/scheduled sessions without
 * destroying the account's history or ownership records, and is fully
 * reversible. `DROP USER` is only ever taken when `HARD_DELETE=true` is
 * explicitly set — Snowflake has no `UNDROP` for users.
 */
export default defineIntegration<Params>({
  id: "snowflake/offboard-developer",
  schemaVersion: 1,
  summary:
    "Offboards a developer from Snowflake: revokes all role grants, then disables the user (default, reversible) or drops it (opt-in, irreversible).",

  // HARD_DELETE arrives from .env as a string and is coerced here, the same
  // ZodEffects shape audit-unused-roles's boolean flags hit.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["snowflake"],

  steps: [connectStep, offboardStep],

  verify,

  reportName: (ctx) => ctx.params.USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const roleList = JSON.parse(String(ctx.outputs.revokedRoles ?? "[]")) as string[];

    return `# Snowflake Developer Offboarding — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/offboard-developer\`.
> This ran against whichever Snowflake account the root \`.env\` pointed at —
> confirm that was the intended account.

## Action taken

- Username: \`${p.USER_NAME}\`
- Action: ${p.HARD_DELETE ? "**DROP USER** (irreversible hard delete)" : "**ALTER USER SET DISABLED = TRUE** (reversible)"}
- Roles revoked: ${roleList.length ? roleList.map((r) => `\`${r}\``).join(", ") : "(none were granted)"}
${p.OFFBOARD_REASON ? `- Reason: ${p.OFFBOARD_REASON}` : ""}

${
  p.HARD_DELETE
    ? "## Irreversible\n\nThis user was permanently dropped. Snowflake has no `UNDROP` for users — rollback of this run can only recreate a best-effort shell with the captured role list, never the original identity, ownership records, or query history."
    : "## Reversible\n\nThis user was disabled, not dropped. Re-enabling (`ALTER USER ... SET DISABLED = FALSE`) plus re-granting the roles listed above fully restores prior access."
}

## Verification

Verified — ${p.HARD_DELETE ? `\`${p.USER_NAME}\` no longer exists` : `\`${p.USER_NAME}\` is DISABLED with no role grants remaining`}.
`;
  },
});
