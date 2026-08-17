import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder .env values are always strings, so the cutover confirmation is
 * spelled "true"/"false" and transformed here rather than relying on zod's
 * own boolean coercion (which would also accept things like "1" — confusing
 * in a hand-edited .env). Default false: never silently do the irreversible
 * half of a rotation.
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,
  NEW_PUBLIC_KEY: nonEmpty,
  CONFIRM_CUTOVER: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
