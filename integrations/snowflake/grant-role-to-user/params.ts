import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder-scoped params only. This integration operates on an existing user
 * and an existing role — it does not create either; both are real
 * preconditions (see README).
 */
export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,
  ROLE_NAME: snowflakeIdentifier,
});

export type Params = z.infer<typeof paramsSchema>;
