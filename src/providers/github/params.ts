import { z } from "zod";
import { boolFlag, jsonArrayParam, nonEmpty } from "../../core/env";

/** A bare owner (user or org) login — never a full "owner/repo" slug. */
export const githubOwner = nonEmpty.refine((v) => !v.includes("/"), "must be a single owner segment, no '/'");

/** A bare repo name — never a full "owner/repo" slug. */
export const githubRepoName = nonEmpty.refine((v) => !v.includes("/"), "must be a bare repo name, no '/'");

/**
 * Folder .env values are always strings. Same "true"/"false" transform used
 * throughout aws/iam/user's destructive-gate params — not zod's own boolean
 * coercion, which accepts confusing values like "1" in a hand-edited .env.
 */

/**
 * A JSON array param, each entry validated against `itemSchema` with a
 * per-index error message — generalized from
 * aws/ec2/update-security-group-rules's own `rulesJson` helper (the second
 * occurrence of this exact shape; a third makes it worth sharing here rather
 * than re-copying).
 */

// Re-exported so the many integrations already importing them from here keep working.
export { boolFlag, jsonArrayParam };
