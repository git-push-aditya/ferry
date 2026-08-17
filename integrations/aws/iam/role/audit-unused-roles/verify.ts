import type { StepContext } from "../../../../../src/core/define";
import type { Params } from "./params";
import type { AuditRow } from "./steps/audit";

/**
 * This integration never mutates AWS state, so "verify" cannot mean "prove a
 * mutation stuck" the way every other integration's verify() does. Instead it
 * proves the read actually succeeded and produced trustworthy data: the
 * report exists, is valid JSON, and is an array of well-formed rows.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const raw = ctx.outputs.auditReport;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("audit-unused-roles produced no report — auditReport output is missing");
  }

  let rows: AuditRow[];
  try {
    rows = JSON.parse(raw) as AuditRow[];
  } catch {
    throw new Error("audit-unused-roles produced malformed report data — auditReport is not valid JSON");
  }

  if (!Array.isArray(rows)) {
    throw new Error("audit-unused-roles report data is not an array");
  }

  for (const row of rows) {
    if (typeof row.roleName !== "string" || typeof row.category !== "string") {
      throw new Error("audit-unused-roles report contains a malformed row");
    }
  }

  ctx.log.success(`Confirmed audit report is well-formed (${rows.length} role(s))`);
}
