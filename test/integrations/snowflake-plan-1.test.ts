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

/**
 * Dry-run plan context builder: check() only, never create()/reconcile(),
 * mirroring plan.test.ts's promise that `--dry-run` never mutates anything.
 */
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
    dryRun: true,
    log: NO_LOG,
  } as StepContext<P>;
}

function showRow(name: string) {
  return [{ name }];
}

describe.each([
  ["onboard-developer-staging", onboardStagingStep] as const,
  ["onboard-developer-prod", onboardProdStep] as const,
])("%s plan", (_label, step) => {
  const PARAMS: OnboardStagingParams | OnboardProdParams = {
    USER_NAME: "JDOE",
    EMAIL: "jdoe@example.com",
    PUBLIC_KEY: "bare-base64-key",
    DEFAULT_ROLE: "DEVELOPER",
  };

  test("plan: user missing -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await step.check(ctx)).toBe("missing");
  });

  test("plan: user exists -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => showRow("JDOE"));
    expect(await step.check(ctx)).toBe("exists");
  });
});

describe("add-public-key-to-existing-user plan", () => {
  const PARAMS: AddKeyParams = { USER_NAME: "JDOE", PUBLIC_KEY: "bare-base64-key" };

  function descRows(slot1Fp: string, slot2Fp: string) {
    return [
      { property: "RSA_PUBLIC_KEY_FP", property_value: slot1Fp },
      { property: "RSA_PUBLIC_KEY_2_FP", property_value: slot2Fp },
    ];
  }

  test("plan: user missing -> conflict", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await addKeyStep.check(ctx)).toBe("conflict");
  });

  test("plan: both slots occupied, no TARGET_SLOT -> conflict", async () => {
    const ctx = sfCtx(PARAMS, {}, async (sql) =>
      sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("fp1", "fp2"),
    );
    expect(await addKeyStep.check(ctx)).toBe("conflict");
  });
});

describe("rotate-user-key-pair plan", () => {
  const PARAMS: RotateParams = {
    USER_NAME: "JDOE",
    NEW_PUBLIC_KEY: "bare-base64-key",
    CONFIRM_CUTOVER: false as unknown as RotateParams["CONFIRM_CUTOVER"],
  };

  function descRows(slot1Fp: string, slot2Fp: string) {
    return [
      { property: "RSA_PUBLIC_KEY_FP", property_value: slot1Fp },
      { property: "RSA_PUBLIC_KEY_2_FP", property_value: slot2Fp },
    ];
  }

  test("plan: mint-new-key — user missing -> conflict", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await mintNewKeyStep.check(ctx)).toBe("conflict");
  });

  test("plan: mint-new-key — slot 1 already occupied by target key -> exists (already minted)", async () => {
    const ctx = sfCtx(PARAMS, {}, async (sql) =>
      sql.startsWith("SHOW USERS") ? showRow("JDOE") : descRows("fp1", "fp2"),
    );
    expect(await mintNewKeyStep.check(ctx)).toBe("exists");
  });

  test("plan: cutover-old-key — CONFIRM_CUTOVER false -> exists (waiting on operator)", async () => {
    const ctx = sfCtx(PARAMS, { newKeySlot: "2" }, async () => []);
    expect(await cutoverOldKeyStep.check(ctx)).toBe("exists");
  });

  test("plan: cutover-old-key — CONFIRM_CUTOVER true, old key still present -> missing", async () => {
    const ctx = sfCtx(
      { ...PARAMS, CONFIRM_CUTOVER: true as unknown as RotateParams["CONFIRM_CUTOVER"] },
      { newKeySlot: "2" },
      async () => descRows("fp1", "fp2"),
    );
    expect(await cutoverOldKeyStep.check(ctx)).toBe("missing");
  });
});

describe("update-user-role plan", () => {
  const PARAMS: UpdateRoleParams = { USER_NAME: "JDOE", TARGET_DEFAULT_ROLE: "ANALYST" };

  function userDescRows(defaultRole: string) {
    return [{ property: "DEFAULT_ROLE", property_value: defaultRole }];
  }

  test("plan: default role already matches -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => userDescRows("ANALYST"));
    expect(await updateRoleStep.check(ctx)).toBe("exists");
  });

  test("plan: default role differs -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => userDescRows("DEVELOPER"));
    expect(await updateRoleStep.check(ctx)).toBe("missing");
  });
});

describe("create-role plan", () => {
  const PARAMS: CreateRoleParams = { ROLE_NAME: "ANALYST", INITIAL_GRANTS: [] };

  test("plan: role missing -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => []);
    expect(await roleStep.check(ctx)).toBe("missing");
  });

  test("plan: role exists -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => showRow("ANALYST"));
    expect(await roleStep.check(ctx)).toBe("exists");
  });
});

describe("grant-role-to-user plan", () => {
  const PARAMS: GrantParams = { USER_NAME: "JDOE", ROLE_NAME: "ANALYST" };

  test("plan: role not granted -> missing", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => [{ role: "OTHER_ROLE" }]);
    expect(await grantStep.check(ctx)).toBe("missing");
  });

  test("plan: role already granted -> exists", async () => {
    const ctx = sfCtx(PARAMS, {}, async () => [{ role: "ANALYST" }]);
    expect(await grantStep.check(ctx)).toBe("exists");
  });
});
