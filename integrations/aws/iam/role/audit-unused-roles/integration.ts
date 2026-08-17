import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { auditStep } from "./steps/audit";
import type { AuditRow } from "./steps/audit";
import { verify } from "./verify";

/**
 * Read-only reporting integration: lists every IAM role in the account,
 * classifies each as never-used / stale candidate / active, and optionally
 * runs a deeper Access Advisor pass on the candidates. Nothing in AWS is ever
 * mutated — no resource() is declared by its step, and rollback() is a no-op.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/audit-unused-roles",
  schemaVersion: 1,
  summary:
    "Read-only audit of IAM roles for unused/stale candidates, using RoleLastUsed by default and an optional deeper Access Advisor pass.",

  // Numeric/boolean toggles arrive from .env as strings and are coerced here,
  // the same ZodEffects shape create-bucket's boolean flags hit.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [auditStep],

  verify,

  reportName: () => "audit-unused-roles",

  report(ctx) {
    const rows = JSON.parse((ctx.outputs.auditReport as string) ?? "[]") as AuditRow[];
    const p = ctx.params;

    const rowsMd = rows
      .map(
        (r) =>
          `| \`${r.roleName}\` | ${r.lastUsedDate} | ${r.ageDays} | ${r.category}${
            r.servicesNeverAccessed ? ` (${r.servicesNeverAccessed.length} service(s) never accessed)` : ""
          }${r.accessAdvisorNote ? ` — ${r.accessAdvisorNote}` : ""} |`,
      )
      .join("\n");

    const neverUsed = rows.filter((r) => r.category === "never used").length;
    const stale = rows.filter((r) => r.category === "stale candidate").length;

    return `# IAM Role Audit

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/audit-unused-roles\`.

## Setting

- Stale threshold: ${p.STALE_THRESHOLD_DAYS} day(s)
- Service-linked roles included: ${p.INCLUDE_SERVICE_LINKED_ROLES}
- Deep Access Advisor pass: ${p.RUN_DEEP_ACCESS_ADVISOR_PASS}
- Path prefix filter: ${p.PATH_PREFIX_FILTER ?? "(none — all paths)"}

## Summary

Audited ${rows.length} role(s): ${neverUsed} never used, ${stale} stale candidate(s).

## Findings

| Role | Last used | Age (days) | Category |
| --- | --- | --- | --- |
${rowsMd}

## Verification

Verified — the underlying \`ListRoles\` read completed without unhandled
pagination truncation and the report data is well-formed. This integration
makes no AWS mutations, so there is nothing else to prove.
`;
  },
});
