import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * .env values are always strings, so the boolean toggle is spelled
 * "true"/"false" and transformed here rather than relying on zod's own
 * boolean coercion — same pattern as aws/s3/create-bucket's boolFlag.
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

/**
 * Comma-separated list of Snowflake privileges, e.g. "USAGE,SELECT". Trimmed,
 * upper-cased, and de-duplicated so the diff in reconcile() compares
 * consistently regardless of how the caller spaced or cased the .env value.
 */
const privilegeList = nonEmpty.transform((v) =>
  [...new Set(v.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean))],
);

/**
 * Folder-scoped params only. This integration operates on an existing role
 * and an existing database/schema — it does not create either; both are
 * real preconditions (see README).
 */
export const paramsSchema = z.object({
  ROLE_NAME: snowflakeIdentifier,

  OBJECT_TYPE: z.enum(["DATABASE", "SCHEMA"]),

  // Not `snowflakeIdentifier`: a SCHEMA target is commonly written qualified
  // as `database.schema`, which contains a '.' that snowflakeIdentifier's
  // single-identifier regex would reject. Validated only as a non-empty raw
  // string; an unqualified schema name is also accepted since Snowflake
  // resolves it against the session's current database.
  OBJECT_NAME: nonEmpty,

  DESIRED_PRIVILEGES: privilegeList,

  // Additive by default — matches this project's established posture
  // (tag-instance's PRUNE_UNMANAGED_TAGS, tag-role's additive default): a run
  // never silently takes away access it wasn't told about unless opted in.
  PRUNE_UNMANAGED_PRIVILEGES: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
