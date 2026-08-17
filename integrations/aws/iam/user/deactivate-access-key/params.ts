import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Folder-scoped params only — no credentials.
 *
 * ACCESS_KEY_ID is required and never inferred: a user may hold up to two
 * access keys, and guessing which one to deactivate is unsafe. The caller
 * must name it explicitly.
 */
export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,
  ACCESS_KEY_ID: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;
