import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

export const paramsSchema = z
  .object({
    OLD_S3_BUCKET_NAME: s3BucketName,
    NEW_S3_BUCKET_NAME: s3BucketName,
  })
  .refine((p) => p.OLD_S3_BUCKET_NAME !== p.NEW_S3_BUCKET_NAME, {
    message: "OLD_S3_BUCKET_NAME and NEW_S3_BUCKET_NAME must differ",
    path: ["NEW_S3_BUCKET_NAME"],
  });

export type Params = z.infer<typeof paramsSchema>;
