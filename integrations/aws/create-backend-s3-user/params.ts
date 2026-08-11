import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { s3BucketName, s3Prefix } from "../../../src/providers/aws";

/**
 * Folder-scoped params — resource names only, never credentials.
 *
 * EXPORT_S3_BUCKET / EXPORT_S3_PREFIX are declared here rather than inherited
 * from elsewhere: this folder has to stand alone, and it may well point at a
 * bucket some other team provisioned.
 */
export const paramsSchema = z.object({
  EXPORT_S3_BUCKET: s3BucketName,
  EXPORT_S3_PREFIX: s3Prefix,
  BACKEND_IAM_USER_NAME: nonEmpty,
  BACKEND_IAM_POLICY_NAME: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;
