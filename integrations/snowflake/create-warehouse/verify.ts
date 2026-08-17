import type { StepContext } from "../../../src/core/define";
import { FerryError } from "../../../src/core/errors";
import { descWarehouse, snowflakeClients, warehouseState } from "../../../src/providers/snowflake";
import type { Params } from "./params";
import { warehouseProp } from "./steps/warehouse";

/**
 * Confirms the warehouse exists and that its size/auto-suspend/auto-resume
 * match what was requested — not just that the CREATE statement returned.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const { WAREHOUSE_NAME, WAREHOUSE_SIZE, AUTO_SUSPEND_SECONDS, AUTO_RESUME } = ctx.params;

  if ((await warehouseState(conn, WAREHOUSE_NAME)) !== "exists") {
    throw new FerryError(`Warehouse "${WAREHOUSE_NAME}" does not exist after create()`);
  }

  const row = await descWarehouse(conn, WAREHOUSE_NAME);
  if (!row) {
    throw new FerryError(`Could not read back warehouse "${WAREHOUSE_NAME}" via SHOW WAREHOUSES`);
  }

  const size = warehouseProp(row, "size", "SIZE").toUpperCase();
  if (size !== WAREHOUSE_SIZE) {
    throw new FerryError(`Warehouse size mismatch: expected ${WAREHOUSE_SIZE}, got ${size}`);
  }

  const autoSuspend = warehouseProp(row, "auto_suspend", "AUTO_SUSPEND");
  if (autoSuspend !== String(AUTO_SUSPEND_SECONDS)) {
    throw new FerryError(
      `Warehouse auto_suspend mismatch: expected ${AUTO_SUSPEND_SECONDS}, got ${autoSuspend}`,
    );
  }

  const autoResume = warehouseProp(row, "auto_resume", "AUTO_RESUME").toLowerCase();
  if (autoResume !== String(AUTO_RESUME)) {
    throw new FerryError(`Warehouse auto_resume mismatch: expected ${AUTO_RESUME}, got ${autoResume}`);
  }

  ctx.log.success(`Verified warehouse "${WAREHOUSE_NAME}" (${size}, auto_suspend=${autoSuspend})`);
}
