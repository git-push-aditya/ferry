import type { StepContext } from "../../../src/core/define";
import { FerryError } from "../../../src/core/errors";
import { descWarehouse, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";
import { warehouseSize } from "./steps/resize";

/** Confirms the warehouse now reports the requested size. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const { WAREHOUSE_NAME, TARGET_SIZE } = ctx.params;

  const row = await descWarehouse(conn, WAREHOUSE_NAME);
  if (!row) {
    throw new FerryError(`Could not read back warehouse "${WAREHOUSE_NAME}" via SHOW WAREHOUSES`);
  }

  const size = warehouseSize(row);
  if (size !== TARGET_SIZE) {
    throw new FerryError(`Warehouse size mismatch: expected ${TARGET_SIZE}, got ${size}`);
  }

  ctx.log.success(`Verified warehouse "${WAREHOUSE_NAME}" is ${size}`);
}
