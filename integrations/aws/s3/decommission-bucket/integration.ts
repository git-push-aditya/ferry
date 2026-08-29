import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { decommissionStep } from "./steps/decommission";
import { verify } from "./verify";

/**
 * Replaces delete-empty-bucket, delete-bucket-with-download and
 * delete-bucket-with-transfer. All three were the same teardown -- drain,
 * confirm, delete, verify -- differing only in where the contents went. The
 * drain is a parameter, not an integration, and having it as one means the
 * "confirm before deleting anything" invariant is written down once instead
 * of three times.
 */
export default defineIntegration<Params>({
  id: "aws/s3/decommission-bucket",
  schemaVersion: 1,
  summary:
    "Preserves a bucket's contents (download, transfer, or prove-empty) and then deletes it, proven by confirming the contents landed and the bucket is gone.",

  // PRESERVE_KEY_PREFIX_STRUCTURE arrives as a "true"/"false" string and the
  // schema carries a superRefine — Input differs from Output, which
  // z.ZodType<P> cannot model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [decommissionStep],

  verify,

  reportName: (ctx) => ctx.params.SOURCE_S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    const manifestJson = ctx.outputs.downloadedManifestJson as string | undefined;
    const keysJson = ctx.outputs.transferredKeysJson as string | undefined;
    const count = manifestJson
      ? (JSON.parse(manifestJson) as unknown[]).length
      : keysJson
        ? (JSON.parse(keysJson) as string[]).length
        : 0;

    const where =
      p.DRAIN_MODE === "download"
        ? `- Downloaded to: \`${p.DOWNLOAD_DIR}\`\n- Key structure preserved: ${p.PRESERVE_KEY_PREFIX_STRUCTURE ? "yes" : "no (flattened)"}\n`
        : p.DRAIN_MODE === "transfer"
          ? `- Transferred to: \`s3://${p.DESTINATION_S3_BUCKET_NAME}\`\n`
          : `- The bucket was confirmed empty before deletion.\n`;

    return `# S3 Bucket Decommission — \`${p.SOURCE_S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/decommission-bucket\`.

## What happened

- Source: \`s3://${p.SOURCE_S3_BUCKET_NAME}\` (deleted)
- Drain mode: \`${p.DRAIN_MODE}\`
- Objects preserved: ${count}
${where}
## Verification

Verified — confirmed every preserved object is present at its destination, and
that \`s3://${p.SOURCE_S3_BUCKET_NAME}\` no longer exists.

## Note on rollback

Rollback removes only what this run wrote elsewhere. Once the source bucket is
deleted it cannot be restored by ferry — which is why the drain is confirmed
in full before the source is touched at all.
`;
  },
});
