import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { revokeStep } from "../../integrations/snowflake/revoke-role-from-user/steps/revoke";
import type { Params as RevokeParams } from "../../integrations/snowflake/revoke-role-from-user/params";
import { offboardStep } from "../../integrations/snowflake/offboard-developer/steps/offboard";
import type { Params as OffboardParams } from "../../integrations/snowflake/offboard-developer/params";
import { warehouseStep } from "../../integrations/snowflake/create-warehouse/steps/warehouse";
import type { Params as CreateWarehouseParams } from "../../integrations/snowflake/create-warehouse/params";
import { resizeStep } from "../../integrations/snowflake/update-warehouse-size/steps/resize";
import type { Params as ResizeWarehouseParams } from "../../integrations/snowflake/update-warehouse-size/params";
import { grantAccessStep } from "../../integrations/snowflake/grant-database-schema-access/steps/grant-access";
import type { Params as GrantAccessParams } from "../../integrations/snowflake/grant-database-schema-access/params";
import { auditStep } from "../../integrations/snowflake/audit-user-access/steps/audit";
import type { Params as AuditParams } from "../../integrations/snowflake/audit-user-access/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

/** dry-run context: check() only — create()/reconcile() must never run here. */
function sfPlanCtx<P>(params: P, runQuery: (sql: string) => Promise<Record<string, unknown>[]>): StepContext<P> {
  const conn = { connection: {}, runQuery, close: async () => {} };
  return {
    params,
    creds: {},
    clients: { snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} } },
    accountId: ACCOUNT,
    outputs: {},
    dryRun: true,
    log: NO_LOG,
  };
}

describe("snowflake dry-run plan: revoke-role-from-user (inverted create-or-skip)", () => {
  const params: RevokeParams = { USER_NAME: "JDOE", ROLE_NAME: "ANALYST" };

  test("role currently granted -> missing (needs revoking)", async () => {
    const ctx = sfPlanCtx(params, async () => [{ role: "ANALYST" }]);
    expect(await revokeStep.check(ctx)).toBe("missing");
  });

  test("role not granted -> exists (already achieved)", async () => {
    const ctx = sfPlanCtx(params, async () => []);
    expect(await revokeStep.check(ctx)).toBe("exists");
  });

  test("user doesn't exist -> exists (nothing to revoke)", async () => {
    const ctx = sfPlanCtx(params, async () => {
      throw new Error("002003 (02000): SQL compilation error: User 'JDOE' does not exist or not authorized.");
    });
    expect(await revokeStep.check(ctx)).toBe("exists");
  });
});

describe("snowflake dry-run plan: offboard-developer (inverted create-or-skip)", () => {
  const params: OffboardParams = { USER_NAME: "JDOE", HARD_DELETE: false, OFFBOARD_REASON: undefined };

  test("user already gone -> exists (already achieved)", async () => {
    const ctx = sfPlanCtx(params, async (sql) => {
      if (/^SHOW USERS/i.test(sql)) return [];
      return [];
    });
    expect(await offboardStep.check(ctx)).toBe("exists");
  });

  test("user present -> missing (needs offboarding)", async () => {
    const ctx = sfPlanCtx(params, async (sql) => {
      if (/^SHOW USERS/i.test(sql)) return [{ name: "JDOE" }];
      return [];
    });
    expect(await offboardStep.check(ctx)).toBe("missing");
  });
});

describe("snowflake dry-run plan: create-warehouse", () => {
  const params: CreateWarehouseParams = {
    WAREHOUSE_NAME: "COMPUTE_WH",
    WAREHOUSE_SIZE: "XSMALL",
    AUTO_SUSPEND_SECONDS: 60,
    AUTO_RESUME: true,
  };

  test("warehouse missing -> missing", async () => {
    const ctx = sfPlanCtx(params, async () => []);
    expect(await warehouseStep.check(ctx)).toBe("missing");
  });

  test("warehouse already exists -> exists", async () => {
    const ctx = sfPlanCtx(params, async () => [{ name: "COMPUTE_WH" }]);
    expect(await warehouseStep.check(ctx)).toBe("exists");
  });
});

describe("snowflake dry-run plan: update-warehouse-size (always-reconcile)", () => {
  const params: ResizeWarehouseParams = { WAREHOUSE_NAME: "COMPUTE_WH", TARGET_SIZE: "MEDIUM" };

  test("warehouse missing -> conflict (never creates one)", async () => {
    const ctx = sfPlanCtx(params, async () => []);
    expect(await resizeStep.check(ctx)).toBe("conflict");
  });

  test("warehouse present -> missing (reconcile's own diff decides)", async () => {
    const ctx = sfPlanCtx(params, async () => [{ name: "COMPUTE_WH", size: "SMALL" }]);
    expect(await resizeStep.check(ctx)).toBe("missing");
  });
});

describe("snowflake dry-run plan: grant-database-schema-access (always-reconcile)", () => {
  const params: GrantAccessParams = {
    ROLE_NAME: "ANALYST",
    OBJECT_TYPE: "SCHEMA",
    OBJECT_NAME: "DB.SCHEMA",
    DESIRED_PRIVILEGES: ["USAGE", "SELECT"],
    PRUNE_UNMANAGED_PRIVILEGES: false,
  };

  test("check() always missing", async () => {
    const ctx = sfPlanCtx(params, async () => []);
    expect(await grantAccessStep.check(ctx)).toBe("missing");
  });
});

describe("snowflake dry-run plan: audit-user-access (read-only)", () => {
  const params: AuditParams = { USER_NAME: "JDOE" };

  test("check() always missing (every run re-audits fresh)", async () => {
    const ctx = sfPlanCtx(params, async () => []);
    expect(await auditStep.check(ctx)).toBe("missing");
  });
});
