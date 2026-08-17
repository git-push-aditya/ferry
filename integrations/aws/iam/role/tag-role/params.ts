import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * TAGS_JSON left empty means "leave whatever tags the role already has
 * alone" — the same "explicit opt-in, no accidental wipe" convention used by
 * `aws/s3/tag-bucket`. Unlike bucket tagging, `TagRole` is a merge, not a
 * replace, so there is no "{}" clear-everything sentinel here: an empty
 * object would simply be a no-op TagRole call with nothing to merge. Clearing
 * tags on a role means removing specific keys, which this integration does
 * not do — that is `UntagRole`'s own job, out of scope here.
 */
export const paramsSchema = z
  .object({
    ROLE_NAME: nonEmpty,
    TAGS_JSON: z.string().default(""),
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
    }
  });

export type Params = z.infer<typeof paramsSchema>;

export function parsedTags(params: Params): Record<string, string> | undefined {
  return params.TAGS_JSON ? (JSON.parse(params.TAGS_JSON) as Record<string, string>) : undefined;
}
