import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";
import type { LifecycleRule } from "@aws-sdk/client-s3";

/**
 * Accepts the raw AWS `LifecycleRule[]` shape as JSON text rather than
 * reinventing a narrower schema — the S3 lifecycle document already supports
 * a lot of combinations (prefix/tag/size filters, transitions, expirations,
 * noncurrent-version rules, abort-incomplete-multipart-upload), and this way
 * every one of them is available without ferry re-modeling each.
 */
export const paramsSchema = z
  .object({
    S3_BUCKET_NAME: s3BucketName,
    LIFECYCLE_RULES_JSON: z.string().default(""),
  })
  .superRefine((p, ctx) => {
    if (!p.LIFECYCLE_RULES_JSON) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.LIFECYCLE_RULES_JSON);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LIFECYCLE_RULES_JSON"],
        message: "must be valid JSON (an array of lifecycle rules) or left empty",
      });
      return;
    }
    if (!Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LIFECYCLE_RULES_JSON"],
        message: "must be a JSON array of lifecycle rules, e.g. [{\"ID\":\"...\", ...}]",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;

export function parsedRules(params: Params): LifecycleRule[] | undefined {
  return params.LIFECYCLE_RULES_JSON
    ? (JSON.parse(params.LIFECYCLE_RULES_JSON) as LifecycleRule[])
    : undefined;
}
