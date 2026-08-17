import type { StepContext } from "../../../src/core/define";
import type { AuditReport } from "./steps/audit";
import type { Params } from "./params";

/**
 * This integration never mutates Snowflake state, so "verify" cannot mean
 * "prove a mutation stuck" the way most integrations' verify() does.
 * Instead it proves the read actually succeeded and produced trustworthy,
 * well-formed data — mirroring aws/iam/role/audit-unused-roles's verify().
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const raw = ctx.outputs.auditReport;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("audit-user-access produced no report — auditReport output is missing");
  }

  let report: AuditReport;
  try {
    report = JSON.parse(raw) as AuditReport;
  } catch {
    throw new Error("audit-user-access produced malformed report data — auditReport is not valid JSON");
  }

  if (typeof report.userName !== "string" || !Array.isArray(report.roles)) {
    throw new Error("audit-user-access report is not a well-formed audit shape");
  }

  ctx.log.success(
    `Confirmed audit report is well-formed for ${report.userName} (${report.roles.length} role(s))`,
  );
}
