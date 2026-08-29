import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";

import { onboardStep as onboardStagingStep } from "../../integrations/snowflake/onboard-developer-staging/steps/onboard";
import type { Params as OnboardStagingParams } from "../../integrations/snowflake/onboard-developer-staging/params";
import { onboardStep as onboardProdStep } from "../../integrations/snowflake/onboard-developer-prod/steps/onboard";
import type { Params as OnboardProdParams } from "../../integrations/snowflake/onboard-developer-prod/params";
import { mintNewKeyStep } from "../../integrations/snowflake/rotate-user-key-pair/steps/mint-new-key";
import { cutoverOldKeyStep } from "../../integrations/snowflake/rotate-user-key-pair/steps/cutover-old-key";
import type { Params as RotateParams } from "../../integrations/snowflake/rotate-user-key-pair/params";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
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

