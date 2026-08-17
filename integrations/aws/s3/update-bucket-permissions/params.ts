import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

/**
 * ACLs are deliberately not modeled here: AWS has been steering buckets away
 * from them since 2023 ("Bucket owner enforced" ownership disables ACLs by
 * default), so bucket policy + public-access-block covers the modern case.
 * A bucket that genuinely still needs ACL management is an edge case this
 * integration does not attempt to cover.
 */
export const paramsSchema = z
  .object({
    S3_BUCKET_NAME: s3BucketName,
    // A full bucket policy document, as JSON text — left unset (empty
    // string) means "leave whatever policy the bucket already has alone".
    BUCKET_POLICY_JSON: z.string().default(""),
    BLOCK_PUBLIC_ACCESS: boolFlag("true"),
  })
  .superRefine((p, ctx) => {
    if (!p.BUCKET_POLICY_JSON) return;
    try {
      JSON.parse(p.BUCKET_POLICY_JSON);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BUCKET_POLICY_JSON"],
        message: "must be valid JSON (a full bucket policy document) or left empty",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;

export function parsedPolicy(params: Params): Record<string, unknown> | undefined {
  return params.BUCKET_POLICY_JSON ? JSON.parse(params.BUCKET_POLICY_JSON) : undefined;
}
