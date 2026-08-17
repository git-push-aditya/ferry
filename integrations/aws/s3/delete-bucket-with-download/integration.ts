import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { downloadStep } from "./steps/download";
import { verify } from "./verify";

/**
 * Downloads every object from a source bucket to local disk, confirms each
 * file's byte size matches, and only then deletes the source bucket. The
 * local-filesystem sibling of `delete-bucket-with-transfer`.
 */
export default defineIntegration<Params>({
  id: "aws/s3/delete-bucket-with-download",
  schemaVersion: 1,
  summary:
    "Downloads every object to local disk, confirms byte-for-byte size, then deletes the source bucket.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [downloadStep],

  verify,

  reportName: (ctx) => ctx.params.SOURCE_S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Download — \`${p.SOURCE_S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/delete-bucket-with-download\`.

## Setting

- Source: \`${p.SOURCE_S3_BUCKET_NAME}\` (deleted after download)
- Local directory: \`${p.DOWNLOAD_DIR}\`
- Preserve key-prefix structure: \`${p.PRESERVE_KEY_PREFIX_STRUCTURE}\`

## Verification

Verified — every downloaded file is present on disk with the expected byte
size, and the source bucket no longer exists.
`;
  },
});
