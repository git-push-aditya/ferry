import { z } from "zod";
import { s3BucketName, s3Prefix } from "../../../../src/providers/aws";

/**
 * Unlike its siblings, there is no "leave alone" toggle here — this
 * integration's whole purpose is turning logging on with a specific target,
 * so the target is always required.
 */
export const paramsSchema = z.object({
  S3_BUCKET_NAME: s3BucketName,
  LOGGING_TARGET_BUCKET: s3BucketName,
  LOGGING_TARGET_PREFIX: s3Prefix,
});

export type Params = z.infer<typeof paramsSchema>;
