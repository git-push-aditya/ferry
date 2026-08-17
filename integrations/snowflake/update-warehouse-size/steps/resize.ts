import type { Step } from "../../../../src/core/define";
import { descWarehouse, snowflakeClients, warehouseState } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** `SHOW WAREHOUSES` returns lowercase column names; be defensive about casing anyway. */
function warehouseSize(row: Record<string, unknown>): string {
  return String(row.size ?? row.SIZE ?? "").toUpperCase();
}

/**
 * Always reconciles (no create()): this integration never creates a
 * warehouse, only resizes one that's already there. Unlike an EC2 instance
 * resize, `ALTER WAREHOUSE ... SET WAREHOUSE_SIZE` is non-disruptive to
 * currently-executing statements — Snowflake re-provisions compute rather
 * than stopping/starting it in place — so there is no "drain first"
 * precondition to model here.
 */
export const resizeStep: Step<Params> = {
  id: "resize-warehouse",
  title: "Resize Snowflake warehouse",

  /**
   * "conflict" when the warehouse doesn't exist: this integration never
   * creates one (that's create-warehouse's job), so a missing warehouse is a
   * real precondition failure, not something to reconcile into existence.
   * When it does exist, always report "missing" — the size-match check is
   * the no-op short-circuit inside reconcile() itself, matching the
   * always-reconcile idiom used elsewhere in this repo (e.g. the storage
   * integration's re-point step, update-security-group-rules).
   */
  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const state = await warehouseState(conn, ctx.params.WAREHOUSE_NAME);
    return state === "exists" ? "missing" : "conflict";
  },

  async reconcile(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { WAREHOUSE_NAME, TARGET_SIZE } = ctx.params;

    const row = await descWarehouse(conn, WAREHOUSE_NAME);
    const currentSize = row ? warehouseSize(row) : "";

    if (currentSize === TARGET_SIZE) {
      ctx.log.info(`Warehouse "${WAREHOUSE_NAME}" is already ${TARGET_SIZE}`);
      return {};
    }

    await conn.runQuery(`ALTER WAREHOUSE ${WAREHOUSE_NAME} SET WAREHOUSE_SIZE = '${TARGET_SIZE}';`);
    ctx.log.success(`Resized warehouse "${WAREHOUSE_NAME}" from ${currentSize || "<unknown>"} to ${TARGET_SIZE}`);

    return { priorSize: currentSize };
  },

  /**
   * Only registered/applicable when reconcile() actually changed the size:
   * a no-op reconcile never set `priorSize`, so there is nothing to restore
   * (same rollback-guard shape as update-trust-policy's steps/trust-policy.ts).
   */
  async rollback(ctx) {
    const prior = ctx.outputs.priorSize as string | undefined;
    if (!prior) return;

    await (await snowflakeClients(ctx).connection()).runQuery(
      `ALTER WAREHOUSE ${ctx.params.WAREHOUSE_NAME} SET WAREHOUSE_SIZE = '${prior}';`,
    );
  },

  resource(ctx) {
    return {
      type: "snowflake_warehouse",
      name: ctx.params.WAREHOUSE_NAME,
      attributes: {
        warehouseName: ctx.params.WAREHOUSE_NAME,
        size: ctx.params.TARGET_SIZE,
      },
    };
  },
};

export { warehouseSize };
