import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder-scoped params — resource names only, never credentials. Which
 * Snowflake account (staging vs prod) this run touches is decided entirely
 * by the root `.env` that's active when the command runs — see README.md.
 */
export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,
  EMAIL: nonEmpty.email(),
  // RSA public key: PEM (with BEGIN/END lines) or bare base64 body, either
  // is accepted — see steps/onboard.ts's cleanPublicKeyBase64.
  PUBLIC_KEY: nonEmpty,
  // Must already exist — this task never creates roles (see create-role).
  DEFAULT_ROLE: snowflakeIdentifier,
});

export type Params = z.infer<typeof paramsSchema>;
