import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";

export const paramsSchema = z.object({
  SF_PIPE_NAME: nonEmpty,
  SF_TARGET_TABLE: nonEmpty,
  // Must already exist — from snowflake/create-storage-s3-integration, run
  // separately. This integration never creates a stage or storage
  // integration itself. See README.
  SF_STAGE_NAME: nonEmpty,
  SF_FILE_FORMAT: z.string().default("TYPE = CSV"),

  // Must be the same bucket SF_STAGE_NAME's URL points at.
  S3_BUCKET_NAME: nonEmpty,
  S3_INGEST_PREFIX: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;

export function pipeDefinition(p: Params): string {
  return `COPY INTO ${p.SF_TARGET_TABLE} FROM @${p.SF_STAGE_NAME} FILE_FORMAT = (${p.SF_FILE_FORMAT})`;
}

/**
 * Stable per-pipe id for the one QueueConfiguration entry this integration
 * owns inside the bucket's notification config — never touch entries
 * belonging to other pipelines/tools sharing the same bucket.
 */
export function notificationEntryId(pipeName: string): string {
  return `ferry-snowpipe-${pipeName.toLowerCase()}`;
}
