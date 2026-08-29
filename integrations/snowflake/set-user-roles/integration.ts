import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { defaultRoleStep } from "./steps/default-role";
import { rolesStep } from "./steps/roles";
import { verify } from "./verify";

/**
 * Replaces grant-role-to-user, revoke-role-from-user and update-user-role.
 *
 * Those three asked the same lifecycle question three ways, as imperative
 * verbs, and each was idempotent only with respect to its own verb. Stated as
 * a desired set, all three collapse into one call:
 *
 *   onboard      ROLES=["ANALYST"] DEFAULT_ROLE=ANALYST
 *   role change  ROLES=["ENGINEER"] PRUNE_UNMANAGED_ROLES=true DEFAULT_ROLE=ENGINEER
 *   offboard     ROLES=[] PRUNE_UNMANAGED_ROLES=true
 *
 * and re-running any of them is a genuine no-op, which GRANT and REVOKE as
 * standalone integrations never were.
 */
export default defineIntegration<Params>({
  id: "snowflake/set-user-roles",
  schemaVersion: 1,
  summary:
    "Converges a Snowflake user's granted roles (and optionally their default role) to a desired set, proven by re-reading the grants.",

  // ROLES/PRUNE_UNMANAGED_ROLES arrive as strings and the schema carries a
  // superRefine — Input differs from Output, which z.ZodType<P> cannot model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["snowflake"],

  // Ordering is load-bearing: DEFAULT_ROLE cannot be set before the role is
  // granted, or the user gets a session that cannot assume its own default.
  steps: [connectStep, rolesStep, defaultRoleStep],

  verify,

  reportName: (ctx) => ctx.params.USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const granted = JSON.parse(String(ctx.outputs.rolesGrantedThisRun ?? "[]")) as string[];
    const revoked = JSON.parse(String(ctx.outputs.rolesRevokedThisRun ?? "[]")) as string[];

    return `# Snowflake User Roles — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/set-user-roles\`.

## Desired state

- User: \`${p.USER_NAME}\`
- Roles: ${p.ROLES.length > 0 ? p.ROLES.map((r) => `\`${r}\``).join(", ") : "_(none)_"}
- Prune unmanaged roles: ${p.PRUNE_UNMANAGED_ROLES ? "yes" : "no (additive only)"}
- Default role: ${p.DEFAULT_ROLE ? `\`${p.DEFAULT_ROLE}\`` : "_(not managed by this run)_"}

## What this run changed

- Granted: ${granted.length > 0 ? granted.map((r) => `\`${r}\``).join(", ") : "_(nothing)_"}
- Revoked: ${revoked.length > 0 ? revoked.map((r) => `\`${r}\``).join(", ") : "_(nothing)_"}

## Verification

Verified — re-read \`SHOW GRANTS TO USER\` and confirmed the set converged${
      p.PRUNE_UNMANAGED_ROLES ? ", with no unmanaged roles remaining" : ""
    }${p.DEFAULT_ROLE ? `, and \`DESC USER\` reports DEFAULT_ROLE = ${p.DEFAULT_ROLE}` : ""}.
`;
  },
});
