import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder-scoped params — resource names only, never credentials.
 *
 * TARGET_SLOT is optional: left unset, the step auto-detects the first empty
 * slot (RSA_PUBLIC_KEY, then RSA_PUBLIC_KEY_2). Set it explicitly to pin a
 * slot — required to overwrite an occupied slot when both are already full.
 */
export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,
  PUBLIC_KEY: nonEmpty,
  TARGET_SLOT: z.enum(["1", "2"]).optional(),
});

export type Params = z.infer<typeof paramsSchema>;
