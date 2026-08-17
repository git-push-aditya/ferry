import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";

import { onboardStep as onboardStagingStep } from "../../integrations/snowflake/onboard-developer-staging/steps/onboard";
import type { Params as OnboardStagingParams } from "../../integrations/snowflake/onboard-developer-staging/params";
import { onboardStep as onboardProdStep } from "../../integrations/snowflake/onboard-developer-prod/steps/onboard";
import type { Params as OnboardProdParams } from "../../integrations/snowflake/onboard-developer-prod/params";
import { addKeyStep } from "../../integrations/snowflake/add-public-key-to-existing-user/steps/add-key";
import type { Params as AddKeyParams } from "../../integrations/snowflake/add-public-key-to-existing-user/params";
import { mintNewKeyStep } from "../../integrations/snowflake/rotate-user-key-pair/steps/mint-new-key";
import { cutoverOldKeyStep } from "../../integrations/snowflake/rotate-user-key-pair/steps/cutover-old-key";
import type { Params as RotateParams } from "../../integrations/snowflake/rotate-user-key-pair/params";
import { updateRoleStep } from "../../integrations/snowflake/update-user-role/steps/update-role";
import type { Params as UpdateRoleParams } from "../../integrations/snowflake/update-user-role/params";
import { roleStep } from "../../integrations/snowflake/create-role/steps/role";
import type { Params as CreateRoleParams } from "../../integrations/snowflake/create-role/params";
import { grantStep } from "../../integrations/snowflake/grant-role-to-user/steps/grant";
import type { Params as GrantParams } from "../../integrations/snowflake/grant-role-to-user/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

function sfCtx<P>(
  params: P,
  outputs: Record<string, unknown>,
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>,
): StepContext<P> {
  const conn = { connection: {}, runQuery, close: async () => {} };
  return {
    params,
    creds: {},
    clients: { snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  } as StepContext<P>;
}

const PEM_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\nabc123==\n-----END PUBLIC KEY-----";

function showRow(name: string) {
  return [{ name }];
}

describe.each([
  ["onboard-developer-staging", onboardStagingStep] as const,
  ["onboard-developer-prod", onboardProdStep] as const,
])("%s onboard step", (_label, step) => {
  const PARAMS: OnboardStagingParams | OnboardProdParams = {
    USER_NAME: "JDOE",
    EMAIL: "jdoe@example.com",
    PUBLIC_KEY: PEM_KEY,
    DEFAULT_ROLE: "DEVELOPER",
  };

  test("check(): user missing -> proceed", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await step.check(ctx)).toBe("missing");
  });

  test("check(): user exists -> exists (skip)", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => showRow("JDOE"));
    expect(await step.check(ctx)).toBe("exists");
  });

  test("create(): issues CREATE USER with PEM stripped and GRANT ROLE, with escaped literals", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(
      { ...PARAMS, EMAIL: "o'brien@example.com" },
      {},
      async (sql) => {
        queries.push(sql);
        return [];
      },
    );

    const outputs = await step.create!(ctx);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("CREATE USER JDOE");
    expect(queries[0]).toContain("EMAIL = 'o''brien@example.com'");
    // PEM BEGIN/END lines must not survive into the SQL text
    expect(queries[0]).not.toContain("BEGIN PUBLIC KEY");
    expect(queries[0]).not.toContain("END PUBLIC KEY");
    expect(queries[0]).toContain("RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAabc123=='");
    expect(queries[0]).toContain("DEFAULT_ROLE = DEVELOPER");
    expect(queries[1]).toBe("GRANT ROLE DEVELOPER TO USER JDOE;");
    expect(outputs.userCreatedThisRun).toBe(true);
  });

  test("rollback(): drops the user", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, { userCreatedThisRun: true }, async (sql) => {
      queries.push(sql);
      return [];
    });

    await step.rollback(ctx);

    expect(queries).toEqual(["DROP USER IF EXISTS JDOE;"]);
  });
});

describe("add-public-key-to-existing-user", () => {
  const PARAMS: AddKeyParams = {
    USER_NAME: "JDOE",
    PUBLIC_KEY: PEM_KEY,
  };

  function descRows(slot1Fp: string, slot2Fp: string) {
    return [
      { property: "RSA_PUBLIC_KEY_FP", property_value: slot1Fp },
      { property: "RSA_PUBLIC_KEY_2_FP", property_value: slot2Fp },
    ];
  }

  test("check(): user missing -> conflict", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await addKeyStep.check(ctx)).toBe("conflict");
  });

  test("check(): slot 1 empty -> targets slot 1", async () => {
    const ctx = sfCtx(PARAMS, {}, async (sql) =>
      sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("", ""),
    );
    expect(await addKeyStep.check(ctx)).toBe("missing");
    expect(ctx.outputs.targetKeySlot).toBe("1");
  });

  test("check(): slot 1 occupied, slot 2 empty -> targets slot 2", async () => {
    const ctx = sfCtx(PARAMS, {}, async (sql) =>
      sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("fp1", ""),
    );
    expect(await addKeyStep.check(ctx)).toBe("missing");
    expect(ctx.outputs.targetKeySlot).toBe("2");
  });

  test("check(): both slots occupied without TARGET_SLOT -> conflict", async () => {
    const ctx = sfCtx(PARAMS, {}, async (sql) =>
      sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("fp1", "fp2"),
    );
    expect(await addKeyStep.check(ctx)).toBe("conflict");
  });

  test("check(): both slots occupied but TARGET_SLOT pins the slot", async () => {
    const ctx = sfCtx({ ...PARAMS, TARGET_SLOT: "2" as const }, {}, async (sql) =>
      sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("fp1", "fp2"),
    );
    expect(await addKeyStep.check(ctx)).toBe("missing");
    expect(ctx.outputs.targetKeySlot).toBe("2");
  });

  test("create(): ALTER USER SET on the targeted slot", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, { targetKeySlot: "1" }, async (sql) => {
      queries.push(sql);
      return [];
    });

    const outputs = await addKeyStep.create!(ctx);

    expect(queries[0]).toBe(
      "ALTER USER JDOE SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAabc123==';",
    );
    expect(outputs.addedKeyThisRun).toBe(true);
    expect(outputs.targetKeySlot).toBe("1");
  });

  test("rollback(): unsets the slot only if this run set it", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, { addedKeyThisRun: true, targetKeySlot: "2" }, async (sql) => {
      queries.push(sql);
      return [];
    });

    await addKeyStep.rollback(ctx);

    expect(queries).toEqual(["ALTER USER JDOE UNSET RSA_PUBLIC_KEY_2;"]);
  });

  test("rollback(): does nothing when this run did not add a key", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [];
    });

    await addKeyStep.rollback(ctx);

    expect(queries).toEqual([]);
  });
});

describe("rotate-user-key-pair", () => {
  const PARAMS: RotateParams = {
    USER_NAME: "JDOE",
    NEW_PUBLIC_KEY: PEM_KEY,
    CONFIRM_CUTOVER: false as unknown as RotateParams["CONFIRM_CUTOVER"],
  };

  function descRows(slot1Fp: string, slot2Fp: string) {
    return [
      { property: "RSA_PUBLIC_KEY_FP", property_value: slot1Fp },
      { property: "RSA_PUBLIC_KEY_2_FP", property_value: slot2Fp },
    ];
  }

  describe("mint-new-key", () => {
    test("check(): user missing -> conflict", async () => {
      const ctx = sfCtx(PARAMS, {}, async () => []);
      expect(await mintNewKeyStep.check(ctx)).toBe("conflict");
    });

    test("check(): both slots empty -> targets slot 1 (first key ever)", async () => {
      const ctx = sfCtx(PARAMS, {}, async (sql) =>
        sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("", ""),
      );
      expect(await mintNewKeyStep.check(ctx)).toBe("missing");
      expect(ctx.outputs.newKeySlot).toBe("1");
    });

    test("check(): slot 1 occupied (normal case) -> targets the free slot 2", async () => {
      const ctx = sfCtx(PARAMS, {}, async (sql) =>
        sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("fp1", ""),
      );
      expect(await mintNewKeyStep.check(ctx)).toBe("missing");
      expect(ctx.outputs.newKeySlot).toBe("2");
    });

    test("create(): sets the new key into the target slot", async () => {
      const queries: string[] = [];
      const ctx = sfCtx(PARAMS, { newKeySlot: "2" }, async (sql) => {
        queries.push(sql);
        return [];
      });

      const outputs = await mintNewKeyStep.create!(ctx);

      expect(queries[0]).toContain("ALTER USER JDOE SET RSA_PUBLIC_KEY_2 =");
      expect(outputs.mintedThisRun).toBe(true);
      expect(outputs.newKeySlot).toBe("2");
    });

    test("rollback(): unsets the minted slot only if minted this run", async () => {
      const queries: string[] = [];
      const ctx = sfCtx(PARAMS, { mintedThisRun: true, newKeySlot: "2" }, async (sql) => {
        queries.push(sql);
        return [];
      });

      await mintNewKeyStep.rollback(ctx);

      expect(queries).toEqual(["ALTER USER JDOE UNSET RSA_PUBLIC_KEY_2;"]);
    });
  });

  describe("cutover-old-key", () => {
    test("check(): CONFIRM_CUTOVER false -> exists (no-op, waiting for operator)", async () => {
      const ctx = sfCtx(PARAMS, { newKeySlot: "2" }, async () => []);
      expect(await cutoverOldKeyStep.check(ctx)).toBe("exists");
    });

    test("check(): CONFIRM_CUTOVER true and old slot still occupied -> missing", async () => {
      const ctx = sfCtx(
        { ...PARAMS, CONFIRM_CUTOVER: true as unknown as RotateParams["CONFIRM_CUTOVER"] },
        { newKeySlot: "2" },
        async () => descRows("fp1", "fp2"),
      );
      expect(await cutoverOldKeyStep.check(ctx)).toBe("missing");
      expect(ctx.outputs.oldKeySlot).toBe("1");
    });

    test("check(): CONFIRM_CUTOVER true but old slot already empty -> exists", async () => {
      const ctx = sfCtx(
        { ...PARAMS, CONFIRM_CUTOVER: true as unknown as RotateParams["CONFIRM_CUTOVER"] },
        { newKeySlot: "2" },
        async () => descRows("", "fp2"),
      );
      expect(await cutoverOldKeyStep.check(ctx)).toBe("exists");
    });

    test("create(): clears the old slot only when CONFIRM_CUTOVER is true (via check having gated to missing)", async () => {
      const queries: string[] = [];
      const ctx = sfCtx(
        { ...PARAMS, CONFIRM_CUTOVER: true as unknown as RotateParams["CONFIRM_CUTOVER"] },
        { newKeySlot: "2", oldKeySlot: "1" },
        async (sql) => {
          queries.push(sql);
          return [];
        },
      );

      const outputs = await cutoverOldKeyStep.create!(ctx);

      expect(queries).toEqual(["ALTER USER JDOE UNSET RSA_PUBLIC_KEY;"]);
      expect(outputs.cutoverThisRun).toBe(true);
      expect(outputs.oldKeySlot).toBe("1");
    });

    test("rollback(): warns and does not attempt to restore the cleared key", async () => {
      const queries: string[] = [];
      const warnings: string[] = [];
      const ctx = sfCtx(
        PARAMS,
        { cutoverThisRun: true, oldKeySlot: "1" },
        async (sql) => {
          queries.push(sql);
          return [];
        },
      );
      ctx.log = { info() {}, warn: (m: string) => warnings.push(m), error() {}, success() {} };

      await cutoverOldKeyStep.rollback(ctx);

      expect(queries).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/[Cc]annot restore/);
    });

    test("rollback(): does nothing if cutover did not run this run", async () => {
      const queries: string[] = [];
      const ctx = sfCtx(PARAMS, {}, async (sql) => {
        queries.push(sql);
        return [];
      });

      await cutoverOldKeyStep.rollback(ctx);

      expect(queries).toEqual([]);
    });
  });
});

describe("update-user-role", () => {
  const PARAMS: UpdateRoleParams = {
    USER_NAME: "JDOE",
    TARGET_DEFAULT_ROLE: "ANALYST",
  };

  function userDescRows(defaultRole: string) {
    return [{ property: "DEFAULT_ROLE", property_value: defaultRole }];
  }

  test("check(): default role already matches -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => userDescRows("ANALYST"));
    expect(await updateRoleStep.check(ctx)).toBe("exists");
  });

  test("check(): default role differs -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => userDescRows("DEVELOPER"));
    expect(await updateRoleStep.check(ctx)).toBe("missing");
  });

  test("reconcile(): throws a clear error if the target role isn't granted yet", async () => {
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      if (sql.startsWith("SHOW GRANTS TO USER")) return []; // no grants
      return userDescRows("DEVELOPER");
    });

    await expect(updateRoleStep.reconcile!(ctx)).rejects.toThrow(/ANALYST is not granted to JDOE/);
  });

  test("reconcile(): ALTER USER SET DEFAULT_ROLE when precondition holds, captures prior role", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      queries.push(sql);
      if (sql.startsWith("SHOW GRANTS TO USER")) return [{ role: "ANALYST" }];
      if (sql.startsWith("DESC USER")) return userDescRows("DEVELOPER");
      return [];
    });

    const outputs = await updateRoleStep.reconcile!(ctx);

    expect(queries).toContain("ALTER USER JDOE SET DEFAULT_ROLE = ANALYST;");
    expect(outputs.priorDefaultRole).toBe("DEVELOPER");
  });

  test("rollback(): restores prior DEFAULT_ROLE", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, { priorDefaultRole: "DEVELOPER" }, async (sql) => {
      queries.push(sql);
      return [];
    });

    await updateRoleStep.rollback(ctx);

    expect(queries).toEqual(["ALTER USER JDOE SET DEFAULT_ROLE = DEVELOPER;"]);
  });

  test("rollback(): skip guard — does nothing when reconcile() was a no-op", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [];
    });

    await updateRoleStep.rollback(ctx);

    expect(queries).toEqual([]);
  });
});

describe("create-role", () => {
  const PARAMS: CreateRoleParams = {
    ROLE_NAME: "ANALYST",
    INITIAL_GRANTS: [
      { privilege: "USAGE", onType: "WAREHOUSE", onName: "COMPUTE_WH" },
      { privilege: "USAGE", onType: "DATABASE", onName: "ANALYTICS" },
    ],
  };

  test("check(): role missing -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await roleStep.check(ctx)).toBe("missing");
  });

  test("check(): role exists -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => showRow("ANALYST"));
    expect(await roleStep.check(ctx)).toBe("exists");
  });

  test("create(): CREATE ROLE IF NOT EXISTS plus looping INITIAL_GRANTS", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [];
    });

    const outputs = await roleStep.create!(ctx);

    expect(queries[0]).toBe("CREATE ROLE IF NOT EXISTS ANALYST;");
    expect(queries[1]).toBe("GRANT USAGE ON WAREHOUSE COMPUTE_WH TO ROLE ANALYST;");
    expect(queries[2]).toBe("GRANT USAGE ON DATABASE ANALYTICS TO ROLE ANALYST;");
    expect(queries).toHaveLength(3);
    expect(outputs.roleCreatedThisRun).toBe(true);
  });

  test("create(): no initial grants -> just CREATE ROLE", async () => {
    const queries: string[] = [];
    const ctx = sfCtx({ ...PARAMS, INITIAL_GRANTS: [] }, {}, async (sql) => {
      queries.push(sql);
      return [];
    });

    await roleStep.create!(ctx);

    expect(queries).toEqual(["CREATE ROLE IF NOT EXISTS ANALYST;"]);
  });

  test("rollback(): DROP ROLE IF EXISTS", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, { roleCreatedThisRun: true }, async (sql) => {
      queries.push(sql);
      return [];
    });

    await roleStep.rollback(ctx);

    expect(queries).toEqual(["DROP ROLE IF EXISTS ANALYST;"]);
  });
});

describe("grant-role-to-user", () => {
  const PARAMS: GrantParams = {
    USER_NAME: "JDOE",
    ROLE_NAME: "ANALYST",
  };

  test("check(): via grantsToUser/hasRoleGrant, role not granted -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => [{ role: "OTHER_ROLE" }]);
    expect(await grantStep.check(ctx)).toBe("missing");
  });

  test("check(): role already granted -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => [{ role: "ANALYST" }]);
    expect(await grantStep.check(ctx)).toBe("exists");
  });

  test("create(): GRANT ROLE ... TO USER ...", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [];
    });

    const outputs = await grantStep.create!(ctx);

    expect(queries).toEqual(["GRANT ROLE ANALYST TO USER JDOE;"]);
    expect(outputs.roleGrantedThisRun).toBe(true);
  });

  test("rollback(): REVOKE ROLE ... FROM USER ...", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [];
    });

    await grantStep.rollback(ctx);

    expect(queries).toEqual(["REVOKE ROLE ANALYST FROM USER JDOE;"]);
  });
});
