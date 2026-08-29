import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../src/core/define";
import { pollUntil } from "../../../src/core/wait";
import { awsClients, deleteKeys } from "../../../src/providers/aws";
import { snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 60_000;

/**
 * Live proof, not just "the DDL/API calls returned 200": drops a real
 * object into the watched prefix and polls SYSTEM$PIPE_STATUS until it
 * reflects ingestion, same "prove data actually moved" standard as
 * create-storage-s3-integration's own verify(). Cleans up the test object
 * whether or not ingestion confirmed in time.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const conn = await snowflakeClients(ctx).connection();
  const bucket = ctx.params.S3_BUCKET_NAME;
  const testKey = `${ctx.params.S3_INGEST_PREFIX}ferry_verify_${Date.now()}.csv`;

  try {
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: testKey, Body: "col1\nferry_verify\n" }),
    );

    const confirmed = await pollUntil(
      async () => {
        const rows = await conn.runQuery(`SELECT SYSTEM$PIPE_STATUS('${ctx.params.SF_PIPE_NAME}') AS status;`);
        const raw = String(rows[0]?.status ?? rows[0]?.STATUS ?? "{}");
        const status = JSON.parse(raw) as { lastReceivedMessageTimestamp?: string; pendingFileCount?: number };
        return Boolean(status.lastReceivedMessageTimestamp);
      },
      { intervalMs: POLL_INTERVAL_MS, timeoutMs: POLL_TIMEOUT_MS, label: "Pipe reports a received message" },
    );

    if (!confirmed) {
      throw new Error(
        `Pipe "${ctx.params.SF_PIPE_NAME}" did not report receiving the verification object in time`,
      );
    }
    ctx.log.success(`Confirmed pipe "${ctx.params.SF_PIPE_NAME}" received the verification object`);
  } finally {
    await deleteKeys(s3, bucket, [testKey]);
  }
}
