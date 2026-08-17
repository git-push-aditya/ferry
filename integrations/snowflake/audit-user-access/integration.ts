import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { auditStep } from "./steps/audit";
import type { AuditReport } from "./steps/audit";
import { connectStep } from "./steps/connect";
import { verify } from "./verify";

/**
 * Read-only reporting integration: audits every role granted to a user, and
 * for each role, every privilege/object it holds and every parent role it's
 * been granted to. Nothing in Snowflake is ever mutated — the audit step
 * declares no resource() and rollback() is a no-op.
 *
 * SINGLE-ACCOUNT SCOPE — read this before assuming it covers both
 * environments. This audits whichever Snowflake account the root `.env`
 * currently points at. Ferry loads one credential set per provider id from
 * the root `.env`, and this integration would need two simultaneous,
 * distinct Snowflake connections (staging account + prod account) to
 * produce a single unified two-account report — a shape the provider model
 * doesn't cleanly support without deeper framework changes, which are out
 * of scope here. To audit both staging and prod, run this integration
 * twice: once with staging's root `.env` active, once with prod's. This is
 * the same "operational, not parameterized" resolution used by
 * onboard-developer-staging / onboard-developer-prod.
 */
export default defineIntegration<Params>({
  id: "snowflake/audit-user-access",
  schemaVersion: 1,
  summary:
    "Read-only audit of a Snowflake user's granted roles and every role's effective privileges, for whichever account the root .env points at.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, auditStep],

  verify,

  reportName: (ctx) => `audit-${ctx.params.USER_NAME}`,

  report(ctx) {
    const report = JSON.parse((ctx.outputs.auditReport as string) ?? "{}") as AuditReport;

    const roleRows = report.roles?.length
      ? report.roles
          .map((r) => {
            const privSummary = r.privileges.length
              ? r.privileges.map((p) => `${p.privilege} ON ${p.grantedOn} \`${p.name}\``).join("; ")
              : "(no privileges held directly)";
            const parents = r.grantedToRoles.length ? r.grantedToRoles.join(", ") : "(none)";
            return `| \`${r.roleName}\` | ${privSummary} | ${parents} |`;
          })
          .join("\n")
      : "| (none) | — | — |";

    return `# Snowflake User Access Audit — \`${report.userName ?? ctx.params.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/audit-user-access\`.
> This audits whichever Snowflake account the root \`.env\` currently points
> at — there is no dual-account support in a single run. To audit both
> staging and prod, run this twice, once per account's root \`.env\`. See
> README.md.

## Account-level flags

- Disabled: \`${report.disabled ?? "unknown"}\`
- Default role: \`${report.defaultRole || "(none)"}\`
- Has an RSA key registered: ${report.hasRsaKey ? "yes" : "no"}

## Roles and effective privileges

| Role | Privileges held directly | Granted to (parent roles) |
| --- | --- | --- |
${roleRows}

## Verification

Verified — the underlying \`SHOW GRANTS\` reads completed and the report
data is well-formed. This integration makes no Snowflake mutations, so
there is nothing else to prove.
`;
  },
});
