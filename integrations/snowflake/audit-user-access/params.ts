import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder-scoped params — resource names only, never credentials. Which
 * Snowflake account this audit reads from is decided entirely by the root
 * `.env` that's active when the command runs — see README.md.
 */
export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,
});

export type Params = z.infer<typeof paramsSchema>;
