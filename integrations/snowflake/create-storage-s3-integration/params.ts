import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { s3BucketName, s3Prefix } from "../../../src/providers/aws";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Folder-scoped params — resource names only, never credentials.
 *
 * EXPORT_S3_BUCKET / EXPORT_S3_PREFIX are declared here on purpose. An
 * integration folder has to be standalone, and inheriting a bucket name from
 * elsewhere would make runs silently coupled.
 */
export const paramsSchema = z.object({
  EXPORT_S3_BUCKET: s3BucketName,
  EXPORT_S3_PREFIX: s3Prefix,
  SF_STORAGE_INTEGRATION_NAME: snowflakeIdentifier,
  SF_STAGE_NAME: snowflakeIdentifier,
  AWS_STORAGE_ROLE_NAME: nonEmpty,
  AWS_STORAGE_POLICY_NAME: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;
