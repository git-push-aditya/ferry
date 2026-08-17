import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

export const paramsSchema = z.object({
  S3_BUCKET_NAME: s3BucketName,
});

export type Params = z.infer<typeof paramsSchema>;
