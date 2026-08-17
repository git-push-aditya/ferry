import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder .env values are always strings, so the hard-delete toggle is
 * spelled "true"/"false" and transformed here rather than relying on zod's
 * own boolean coercion (which accepts things like "1" that would be
 * confusing in a hand-edited .env) — same boolFlag pattern as
 * aws/s3/create-bucket and aws/iam/user/offboard-user.
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  USER_NAME: snowflakeIdentifier,

  // Default path is DISABLED = TRUE: reversible, blocks login, aborts
  // running sessions, and preserves ownership/history. DROP USER is
  // irreversible (no UNDROP) and is only ever taken when explicitly opted
  // into — never the default.
  HARD_DELETE: boolFlag("false"),

  // Audit-trail metadata only — never used in any SQL statement. Purely for
  // the report, matching the AWS offboard-user integration's own
  // OFFBOARD_REASON param.
  OFFBOARD_REASON: z.string().optional(),
});

export type Params = z.infer<typeof paramsSchema>;
