import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/** Same standard Snowflake T-shirt sizes as create-warehouse's WAREHOUSE_SIZE. */
export const warehouseSizeSchema = z.enum([
  "XSMALL",
  "SMALL",
  "MEDIUM",
  "LARGE",
  "XLARGE",
  "XXLARGE",
  "XXXLARGE",
  "X4LARGE",
  "X5LARGE",
  "X6LARGE",
]);

export type WarehouseSize = z.infer<typeof warehouseSizeSchema>;

/**
 * Folder-scoped params — resource names only, never credentials.
 */
export const paramsSchema = z.object({
  WAREHOUSE_NAME: snowflakeIdentifier,
  TARGET_SIZE: warehouseSizeSchema,
});

export type Params = z.infer<typeof paramsSchema>;
