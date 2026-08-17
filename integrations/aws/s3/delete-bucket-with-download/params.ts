import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";
import { s3BucketName } from "../../../../src/providers/aws";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  SOURCE_S3_BUCKET_NAME: s3BucketName,
  DOWNLOAD_DIR: nonEmpty,
  // true preserves each key's "/" as real subdirectories under DOWNLOAD_DIR
  // (S3 keys aren't real directories, so this just recreates the nesting a
  // key's prefixes imply); false flattens every key into one filename.
  PRESERVE_KEY_PREFIX_STRUCTURE: boolFlag("true"),
});

export type Params = z.infer<typeof paramsSchema>;
