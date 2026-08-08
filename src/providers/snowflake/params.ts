import { nonEmpty } from "../../core/env";

/**
 * Snowflake unquoted identifiers only allow letters/digits/underscore and
 * can't start with a digit — a hyphen (or anything else) makes the SQL
 * parser read it as an expression (e.g. "a-b-c" as subtraction), not a name.
 */
export const snowflakeIdentifier = nonEmpty.refine(
  (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v),
  "must be a valid Snowflake unquoted identifier — letters/digits/underscore only, can't start with a digit or contain '-'",
);
