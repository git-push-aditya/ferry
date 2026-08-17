import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * TAGS_JSON left empty means "leave whatever tags the user already has
 * alone" — same "explicit opt-in, no accidental wipe" convention as
 * `aws/iam/role/tag-role` and `aws/s3/tag-bucket`.
 *
 * Unlike TagRole (a merge), TagUser is documented the same way — it
 * overwrites only the keys sent, leaving unmentioned keys untouched. Fully
 * declarative convergence (removing keys not in TAGS_JSON) is opt-in via
 * PRUNE_UNMANAGED_TAGS, never the default.
 */
export const paramsSchema = z
  .object({
    IAM_USER_NAME: nonEmpty,
    TAGS_JSON: z.string().default(""),
    PRUNE_UNMANAGED_TAGS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((p, ctx) => {
    if (!p.TAGS_JSON) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.TAGS_JSON);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TAGS_JSON"],
        message: "must be valid JSON (a flat string-to-string object) or left empty",
      });
      return;
    }
    const isFlatStringMap =
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string");
    if (!isFlatStringMap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TAGS_JSON"],
        message: "must be a flat object of string keys to string values, e.g. {\"env\":\"prod\"}",
      });
      return;
    }
    for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
      if (k.length > 128) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TAGS_JSON"],
          message: `tag key "${k}" exceeds IAM's 128-character key limit`,
        });
      }
      if (v.length > 256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TAGS_JSON"],
          message: `tag value for key "${k}" exceeds IAM's 256-character value limit`,
        });
      }
    }
  });

export type Params = z.infer<typeof paramsSchema>;

export function parsedTags(params: Params): Record<string, string> | undefined {
  return params.TAGS_JSON ? (JSON.parse(params.TAGS_JSON) as Record<string, string>) : undefined;
}
