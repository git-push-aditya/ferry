import { z } from "zod";
import { nonEmpty } from "../../core/env";

/** A bare owner (user or org) login — never a full "owner/repo" slug. */
export const githubOwner = nonEmpty.refine((v) => !v.includes("/"), "must be a single owner segment, no '/'");

/** A bare repo name — never a full "owner/repo" slug. */
export const githubRepoName = nonEmpty.refine((v) => !v.includes("/"), "must be a bare repo name, no '/'");

/**
 * Folder .env values are always strings. Same "true"/"false" transform used
 * throughout aws/iam/user's destructive-gate params — not zod's own boolean
 * coercion, which accepts confusing values like "1" in a hand-edited .env.
 */
export function boolFlag(defaultValue: "true" | "false") {
  return z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");
}

/**
 * A JSON array param, each entry validated against `itemSchema` with a
 * per-index error message — generalized from
 * aws/ec2/update-security-group-rules's own `rulesJson` helper (the second
 * occurrence of this exact shape; a third makes it worth sharing here rather
 * than re-copying).
 */
export function jsonArrayParam<T>(label: string, itemSchema: z.ZodType<T>, defaultValue = "[]") {
  return z
    .string()
    .optional()
    .default(defaultValue)
    .transform((v, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be valid JSON` });
        return z.NEVER;
      }
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a JSON array` });
        return z.NEVER;
      }
      const items: T[] = [];
      parsed.forEach((entry, index) => {
        const result = itemSchema.safeParse(entry);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label}[${index}] is invalid: ${result.error.issues.map((i) => i.message).join(", ")}`,
          });
          return;
        }
        items.push(result.data);
      });
      return items;
    });
}
