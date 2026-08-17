import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

export const paramsSchema = z
  .object({
    SOURCE_S3_BUCKET_NAME: s3BucketName,
    DESTINATION_S3_BUCKET_NAME: s3BucketName,
  })
  .refine((p) => p.SOURCE_S3_BUCKET_NAME !== p.DESTINATION_S3_BUCKET_NAME, {
    message: "SOURCE_S3_BUCKET_NAME and DESTINATION_S3_BUCKET_NAME must differ",
    path: ["DESTINATION_S3_BUCKET_NAME"],
  });

export type Params = z.infer<typeof paramsSchema>;
