import type { Step } from "../../../../src/core/define";
import { descWarehouse, snowflakeClients, warehouseState } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** `SHOW WAREHOUSES` returns lowercase column names; be defensive about casing anyway. */
function warehouseProp(row: Record<string, unknown>, lower: string, upper: string): string {
  return String(row[lower] ?? row[upper] ?? "");
}

/**
 * `CREATE WAREHOUSE IF NOT EXISTS`, never `CREATE OR REPLACE` — a pre-existing
 * warehouse this task didn't create is left untouched (rollback would drop
 * a resource other runs or teams depend on). Resizing an existing warehouse
 * is deliberately out of scope here: that's update-warehouse-size's job, not
 * an implicit side effect of re-running this integration.
 */
export const warehouseStep: Step<Params> = {
  id: "warehouse",
  title: "Create Snowflake warehouse",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    return warehouseState(conn, ctx.params.WAREHOUSE_NAME);
  },

  /**
   * `INITIALLY_SUSPENDED = TRUE` is a deliberate default, not an oversight: a
   * freshly created warehouse should not start burning credits before
   * anything is actually scheduled to run against it.
   */
  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { WAREHOUSE_NAME, WAREHOUSE_SIZE, AUTO_SUSPEND_SECONDS, AUTO_RESUME } = ctx.params;

    await conn.runQuery(
      `CREATE WAREHOUSE IF NOT EXISTS ${WAREHOUSE_NAME}
        WITH WAREHOUSE_SIZE = '${WAREHOUSE_SIZE}'
        AUTO_SUSPEND = ${AUTO_SUSPEND_SECONDS}
        AUTO_RESUME = ${AUTO_RESUME ? "TRUE" : "FALSE"}
        INITIALLY_SUSPENDED = TRUE;`,
    );
    ctx.log.success(`Created warehouse "${WAREHOUSE_NAME}" (${WAREHOUSE_SIZE}, suspended)`);

    return {};
  },

  async rollback(ctx) {
    await (await snowflakeClients(ctx).connection()).runQuery(
      `DROP WAREHOUSE IF EXISTS ${ctx.params.WAREHOUSE_NAME};`,
    );
  },

  resource(ctx) {
    const { WAREHOUSE_NAME, WAREHOUSE_SIZE, AUTO_SUSPEND_SECONDS } = ctx.params;
    return {
      type: "snowflake_warehouse",
      name: WAREHOUSE_NAME,
      attributes: {
        warehouseName: WAREHOUSE_NAME,
        size: WAREHOUSE_SIZE,
        autoSuspend: String(AUTO_SUSPEND_SECONDS),
      },
    };
  },
};

/** Exported for verify.ts's defensive-casing property read. */
export { warehouseProp };
