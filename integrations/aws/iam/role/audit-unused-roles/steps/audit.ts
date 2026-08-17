import {
  GenerateServiceLastAccessedDetailsCommand,
  GetServiceLastAccessedDetailsCommand,
  ListRolesCommand,
  type Role,
} from "@aws-sdk/client-iam";
import type { Step, StepOutputs } from "../../../../../../src/core/define";
import { awsClients } from "../../../../../../src/providers/aws";
import { pollUntil } from "../../../../../../src/core/wait";
import type { Params } from "../params";

export type Category = "never used" | "stale candidate" | "active, not a candidate";

export interface AuditRow {
  roleName: string;
  arn: string;
  lastUsedDate: string; // ISO string, or "never" (in the tracked window)
  region: string;
  ageDays: number;
  category: Category;
  servicesNeverAccessed?: string[];
  accessAdvisorNote?: string;
}

function isServiceLinked(path: string): boolean {
  return path.startsWith("/aws-service-role/") || path.startsWith("/service-role/");
}

async function listAllRoles(
  iam: ReturnType<typeof awsClients>["iam"],
  pathPrefix?: string,
): Promise<{ roles: Role[]; sawUnfinishedPagination: boolean }> {
  const roles: Role[] = [];
  let marker: string | undefined;
  let sawUnfinishedPagination = false;
  do {
    const page = await iam.send(
      new ListRolesCommand({ PathPrefix: pathPrefix, Marker: marker }),
    );
    roles.push(...(page.Roles ?? []));
    if (page.IsTruncated && !page.Marker) sawUnfinishedPagination = true;
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return { roles, sawUnfinishedPagination };
}

/**
 * Runs the optional Access Advisor deep pass for a single candidate role.
 * Wrapped by the caller in its own try/catch — one bad job must never abort
 * the whole audit.
 */
async function deepAccessAdvisorPass(
  iam: ReturnType<typeof awsClients>["iam"],
  arn: string,
): Promise<string[] | undefined> {
  const generated = await iam.send(
    new GenerateServiceLastAccessedDetailsCommand({ Arn: arn, Granularity: "SERVICE_LEVEL" }),
  );
  const jobId = generated.JobId;
  if (!jobId) return undefined;

  let neverAccessed: string[] | undefined;
  let finished = false;
  await pollUntil(
    async () => {
      const details = await iam.send(new GetServiceLastAccessedDetailsCommand({ JobId: jobId }));
      if (details.JobStatus === "COMPLETED") {
        neverAccessed = (details.ServicesLastAccessed ?? [])
          .filter((s) => !s.LastAuthenticated)
          .map((s) => s.ServiceName ?? s.ServiceNamespace ?? "unknown");
        finished = true;
        return true;
      }
      if (details.JobStatus === "FAILED") {
        finished = true;
        return true;
      }
      return false;
    },
    { intervalMs: 3000, timeoutMs: 60_000, label: `Access Advisor job for ${arn}` },
  );

  return finished ? neverAccessed : undefined;
}

/**
 * A single, read-only reporting step. check() always returns "missing" so
 * create() (the actual read-and-classify work) runs on every invocation —
 * this "step" never reaches a skippable "exists" state, since every run
 * re-audits fresh account-wide data. No resource() and an empty rollback():
 * nothing is ever mutated in AWS.
 */
export const auditStep: Step<Params> = {
  id: "audit-unused-roles",
  title: "Audit IAM roles for unused/stale candidates",

  async check() {
    return "missing";
  },

  async create(ctx): Promise<StepOutputs> {
    const { iam } = awsClients(ctx);
    const { roles, sawUnfinishedPagination } = await listAllRoles(
      iam,
      ctx.params.PATH_PREFIX_FILTER,
    );

    if (sawUnfinishedPagination) {
      ctx.log.warn(
        "ListRoles reported IsTruncated with no Marker — pagination may be incomplete",
      );
    }

    const included = roles.filter(
      (r) => ctx.params.INCLUDE_SERVICE_LINKED_ROLES || !isServiceLinked(r.Path ?? "/"),
    );

    const now = Date.now();
    const staleMs = ctx.params.STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    const rows: AuditRow[] = [];
    for (const role of included) {
      const roleName = role.RoleName ?? "unknown";
      const arn = role.Arn ?? "";
      const lastUsed = role.RoleLastUsed?.LastUsedDate;
      const region = role.RoleLastUsed?.Region ?? "";

      let category: Category;
      let ageDays: number;
      let lastUsedDate: string;

      if (!lastUsed) {
        category = "never used";
        ageDays = Math.floor((now - (role.CreateDate?.getTime() ?? now)) / (24 * 60 * 60 * 1000));
        lastUsedDate = "never";
      } else {
        ageDays = Math.floor((now - lastUsed.getTime()) / (24 * 60 * 60 * 1000));
        lastUsedDate = lastUsed.toISOString();
        category = now - lastUsed.getTime() > staleMs ? "stale candidate" : "active, not a candidate";
      }

      rows.push({ roleName, arn, lastUsedDate, region, ageDays, category });
    }

    if (ctx.params.RUN_DEEP_ACCESS_ADVISOR_PASS) {
      const candidates = rows.filter((r) => r.category !== "active, not a candidate");
      for (const row of candidates) {
        try {
          const neverAccessed = await deepAccessAdvisorPass(iam, row.arn);
          if (neverAccessed !== undefined) {
            row.servicesNeverAccessed = neverAccessed;
          } else {
            row.accessAdvisorNote = "detail unavailable";
          }
        } catch (err) {
          ctx.log.warn(
            `Access Advisor pass failed for ${row.roleName}: ${(err as Error).message} — recording "detail unavailable"`,
          );
          row.accessAdvisorNote = "detail unavailable";
        }
      }
    }

    const neverUsed = rows.filter((r) => r.category === "never used").length;
    const stale = rows.filter((r) => r.category === "stale candidate").length;
    ctx.log.info(
      `Audited ${rows.length} role(s) (of ${roles.length} total, ${roles.length - included.length} service-linked excluded): ` +
        `${neverUsed} never used, ${stale} stale candidate(s)`,
    );

    return { auditReport: JSON.stringify(rows) };
  },

  async rollback() {
    // Nothing was ever created or changed — a read-only audit has nothing to
    // undo. Mirrors iamRoleExistsGuardStep's precondition rollback.
  },
};
