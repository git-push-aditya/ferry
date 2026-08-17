import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

/**
 * Folder .env values are always strings, so a boolean toggle is spelled
 * "true"/"false" and transformed here rather than relying on zod's own
 * boolean coercion, which accepts things like "1" that would be confusing in
 * a hand-edited .env.
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z
  .object({
    S3_BUCKET_NAME: s3BucketName,

    // Each of these three is optional bucket-level state, opted into
    // independently — leaving all three at their defaults provisions a plain
    // bucket with only AWS's own baseline (SSE-S3, no explicit versioning).
    ENABLE_VERSIONING: boolFlag("false"),
    ENABLE_ENCRYPTION: boolFlag("false"),
    ENCRYPTION_ALGORITHM: z.enum(["AES256", "aws:kms"]).default("AES256"),
    ENCRYPTION_KMS_KEY_ID: z.string().optional(),

    // Blocking public access is the one toggle that defaults to the safe
    // choice rather than to "untouched" — a freshly provisioned bucket should
    // not be publicly reachable by accident.
    BLOCK_PUBLIC_ACCESS: boolFlag("true"),
  })
  .superRefine((p, ctx) => {
    if (p.ENABLE_ENCRYPTION && p.ENCRYPTION_ALGORITHM === "aws:kms" && !p.ENCRYPTION_KMS_KEY_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENCRYPTION_KMS_KEY_ID"],
        message: "required when ENCRYPTION_ALGORITHM=aws:kms",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;
