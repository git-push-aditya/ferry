import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { revokeStep } from "../../integrations/snowflake/revoke-role-from-user/steps/revoke";
import type { Params as RevokeParams } from "../../integrations/snowflake/revoke-role-from-user/params";
import { offboardStep } from "../../integrations/snowflake/offboard-developer/steps/offboard";
import type { Params as OffboardParams } from "../../integrations/snowflake/offboard-developer/params";
import { grantAccessStep } from "../../integrations/snowflake/grant-database-schema-access/steps/grant-access";
import type { Params as GrantAccessParams } from "../../integrations/snowflake/grant-database-schema-access/params";
import { auditStep } from "../../integrations/snowflake/audit-user-access/steps/audit";
import type { Params as AuditParams } from "../../integrations/snowflake/audit-user-access/params";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
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
