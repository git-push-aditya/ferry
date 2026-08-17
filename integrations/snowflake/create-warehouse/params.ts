import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Standard Snowflake T-shirt sizes. Not exhaustive of every exotic Snowpark
 * container/Gen2 tier, but covers the sizes any warehouse is realistically
 * created with.
 */
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
 * Folder .env values are always strings, so a boolean toggle is spelled
 * "true"/"false" and transformed here rather than relying on zod's own
 * boolean coercion, which accepts things like "1" that would be confusing in
 * a hand-edited .env.
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

/**
 * Folder-scoped params — resource names only, never credentials.
 */
export const paramsSchema = z.object({
  WAREHOUSE_NAME: snowflakeIdentifier,
  WAREHOUSE_SIZE: warehouseSizeSchema.default("XSMALL"),
  AUTO_SUSPEND_SECONDS: z.coerce.number().int().positive().default(60),
  AUTO_RESUME: boolFlag("true"),
});

export type Params = z.infer<typeof paramsSchema>;
