import type { Step } from "../../../../src/core/define";
import { showsExactly, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** Artifact F: the external stage that `COPY INTO` writes through. */
export const stageStep: Step<Params> = {
  id: "stage",
  title: "Create external stage (artifact F)",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    return (await showsExactly(conn, "STAGES", ctx.params.SF_STAGE_NAME)) ? "exists" : "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(
      `CREATE STAGE IF NOT EXISTS ${ctx.params.SF_STAGE_NAME}
        STORAGE_INTEGRATION = ${ctx.params.SF_STORAGE_INTEGRATION_NAME}
        URL = 's3://${ctx.params.EXPORT_S3_BUCKET}/${ctx.params.EXPORT_S3_PREFIX}'
        FILE_FORMAT = (TYPE = CSV);`,
    );
    return { stageCreatedThisRun: true };
  },

  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`DROP STAGE IF EXISTS ${ctx.params.SF_STAGE_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_stage",
      name: ctx.params.SF_STAGE_NAME,
      attributes: {
        url: `s3://${ctx.params.EXPORT_S3_BUCKET}/${ctx.params.EXPORT_S3_PREFIX}`,
        storageIntegration: ctx.params.SF_STORAGE_INTEGRATION_NAME,
      },
    };
  },

  handoff: {
    terraform: {
      type: "snowflake_stage",
      address: "snowflake_stage.s3_export",
      importId: (ctx) => ctx.params.SF_STAGE_NAME,
    },
    ansibleVar: "snowflake_export_stage",
  },
};
