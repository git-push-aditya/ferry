import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

/**
 * TAGS_JSON left empty means "leave whatever tags the bucket already has
 * alone" — the same "explicit opt-in, no accidental wipe" shape used
 * throughout this folder's siblings. Set it to "{}" explicitly to clear every
 * tag; PutBucketTagging is a whole-set replace, so there is no "add one tag"
 * without first reading and re-including every tag you want kept.
 */
export const paramsSchema = z
  .object({
    S3_BUCKET_NAME: s3BucketName,
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
