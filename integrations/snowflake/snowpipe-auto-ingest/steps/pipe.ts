import type { Step } from "../../../../src/core/define";
import { findExactMatch, snowflakeClients } from "../../../../src/providers/snowflake";
import { pipeDefinition, type Params } from "../params";

function readNotificationChannel(row: Record<string, unknown>): string {
  return String(row.notification_channel ?? row.NOTIFICATION_CHANNEL ?? "");
}

/**
 * Create-only, same "no settings-drift reconcile" stance as
 * github/create-environment — changing a pipe's COPY INTO definition after
 * creation requires ALTER PIPE ... SET PIPE_EXECUTION_PAUSED = TRUE first
 * (a disruptive operation), which this step does not attempt automatically.
 *
 * check() always reads back notification_channel — the SQS queue ARN
 * Snowflake itself mints and owns — into ctx.outputs when the pipe already
 * exists, since create() won't run in that case and the bucket-notification
 * step downstream needs that value regardless of which branch ran.
 */
export const pipeStep: Step<Params> = {
  id: "pipe",
  title: "Create Snowpipe object",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const rows = await conn.runQuery(`SHOW PIPES LIKE '${ctx.params.SF_PIPE_NAME}';`);
    const match = findExactMatch(rows, ctx.params.SF_PIPE_NAME);
    if (!match) return "missing";
    ctx.outputs.notificationChannel = readNotificationChannel(match);
    return "exists";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(
      `CREATE PIPE ${ctx.params.SF_PIPE_NAME} AUTO_INGEST = TRUE AS ${pipeDefinition(ctx.params)};`,
    );

    const rows = await conn.runQuery(`SHOW PIPES LIKE '${ctx.params.SF_PIPE_NAME}';`);
    const match = findExactMatch(rows, ctx.params.SF_PIPE_NAME);
    const notificationChannel = match ? readNotificationChannel(match) : "";
    if (!notificationChannel) {
      throw new Error(
        `Created pipe "${ctx.params.SF_PIPE_NAME}" but SHOW PIPES did not report a notification_channel`,
      );
    }

    ctx.log.success(`Created pipe "${ctx.params.SF_PIPE_NAME}" — notification channel ${notificationChannel}`);
    return { notificationChannel, pipeCreatedThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.pipeCreatedThisRun !== true) return;
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`DROP PIPE IF EXISTS ${ctx.params.SF_PIPE_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_pipe",
      name: ctx.params.SF_PIPE_NAME,
      attributes: {
        name: ctx.params.SF_PIPE_NAME,
        notificationChannel: String(ctx.outputs.notificationChannel ?? ""),
      },
    };
  },

  handoff: {
    terraform: {
      type: "snowflake_pipe",
      address: "snowflake_pipe.this",
      importId: (ctx) => ctx.params.SF_PIPE_NAME,
    },
  },
};
