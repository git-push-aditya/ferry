import { z } from "zod";
import { boolFlag, nonEmpty } from "../../../../src/core/env";
import { s3BucketName } from "../../../../src/providers/aws";

/**
 * Replaces delete-empty-bucket, delete-bucket-with-download and
 * delete-bucket-with-transfer. All three were the same teardown with a
 * different drain: the drain is the parameter, not the integration.
 */
export const paramsSchema = z
  .object({
    SOURCE_S3_BUCKET_NAME: s3BucketName,

    // How to preserve the bucket's contents before deleting it.
    //   none      -- refuse to proceed unless the bucket is already empty
    //   download  -- write every object to DOWNLOAD_DIR first
    //   transfer  -- copy every object into DESTINATION_S3_BUCKET_NAME first
    DRAIN_MODE: z.enum(["none", "download", "transfer"]),

    // DRAIN_MODE=transfer
    DESTINATION_S3_BUCKET_NAME: s3BucketName.optional(),

    // DRAIN_MODE=download
    DOWNLOAD_DIR: nonEmpty.optional(),
    // true preserves each key's "/" as real subdirectories under DOWNLOAD_DIR
    // (S3 keys aren't real directories, so this just recreates the nesting a
    // key's prefixes imply); false flattens every key into one filename.
    PRESERVE_KEY_PREFIX_STRUCTURE: boolFlag("true"),
  })
  .superRefine((p, ctx) => {
    if (p.DRAIN_MODE === "transfer") {
      if (!p.DESTINATION_S3_BUCKET_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DESTINATION_S3_BUCKET_NAME"],
          message: "DESTINATION_S3_BUCKET_NAME is required when DRAIN_MODE=transfer",
        });
      } else if (p.DESTINATION_S3_BUCKET_NAME === p.SOURCE_S3_BUCKET_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DESTINATION_S3_BUCKET_NAME"],
          message: "SOURCE_S3_BUCKET_NAME and DESTINATION_S3_BUCKET_NAME must differ",
        });
      }
    }
    if (p.DRAIN_MODE === "download" && !p.DOWNLOAD_DIR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DOWNLOAD_DIR"],
        message: "DOWNLOAD_DIR is required when DRAIN_MODE=download",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;
