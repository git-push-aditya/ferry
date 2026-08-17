import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

export const paramsSchema = z
  .object({
    S3_BUCKET_NAME: s3BucketName,
    ENCRYPTION_ALGORITHM: z.enum(["AES256", "aws:kms"]),
    ENCRYPTION_KMS_KEY_ID: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.ENCRYPTION_ALGORITHM === "aws:kms" && !p.ENCRYPTION_KMS_KEY_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENCRYPTION_KMS_KEY_ID"],
        message: "required when ENCRYPTION_ALGORITHM=aws:kms",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;
