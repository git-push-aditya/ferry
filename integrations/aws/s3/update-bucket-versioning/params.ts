import { z } from "zod";
import { s3BucketName } from "../../../../src/providers/aws";

/**
 * Unlike create-bucket's opt-in toggle, this integration exists specifically
 * to set versioning explicitly — including Suspended, which create-bucket's
 * toggle deliberately never targets on its own.
 */
export const paramsSchema = z.object({
  S3_BUCKET_NAME: s3BucketName,
  DESIRED_VERSIONING_STATUS: z.enum(["Enabled", "Suspended"]),
});

export type Params = z.infer<typeof paramsSchema>;
