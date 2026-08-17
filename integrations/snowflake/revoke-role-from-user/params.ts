import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder-scoped params — resource names only, never credentials.
 */
export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,
  ROLE_NAME: snowflakeIdentifier,
});

export type Params = z.infer<typeof paramsSchema>;
