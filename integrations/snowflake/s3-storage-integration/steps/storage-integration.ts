import type { Step } from "../../../../src/core/define";
import { roleArn } from "../../../../src/providers/aws";
import { descProperties, showsExactly, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

const roleArnOf = (ctx: { accountId: string; params: Params }) =>
  roleArn(ctx.accountId, ctx.params.AWS_STORAGE_ROLE_NAME);

const locationOf = (params: Params) => `s3://${params.EXPORT_S3_BUCKET}/${params.EXPORT_S3_PREFIX}`;

function alterSql(params: Params, arn: string, location: string): string {
  return `ALTER STORAGE INTEGRATION ${params.SF_STORAGE_INTEGRATION_NAME} SET
        STORAGE_AWS_ROLE_ARN = '${arn}',
        ENABLED = TRUE,
        STORAGE_ALLOWED_LOCATIONS = ('${location}');`;
}

/**
 * Artifact D.
 *
 * Uses `CREATE ... IF NOT EXISTS` plus `ALTER ... SET` and **never**
 * `CREATE OR REPLACE`: replacing the integration regenerates its external id,
 * which silently invalidates the IAM trust policy that was built around the old
 * one. That failure looks like an unrelated Access Denied hours later.
 */
export const storageIntegrationStep: Step<Params> = {
  id: "storage-integration",
  title: "Create/reconcile Snowflake storage integration (artifact D)",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    return (await showsExactly(conn, "INTEGRATIONS", ctx.params.SF_STORAGE_INTEGRATION_NAME))
      ? "exists"
      : "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const arn = roleArnOf(ctx);
    const location = locationOf(ctx.params);

    await conn.runQuery(
      `CREATE STORAGE INTEGRATION IF NOT EXISTS ${ctx.params.SF_STORAGE_INTEGRATION_NAME}
        TYPE = EXTERNAL_STAGE
        STORAGE_PROVIDER = 'S3'
        STORAGE_AWS_ROLE_ARN = '${arn}'
        ENABLED = TRUE
        STORAGE_ALLOWED_LOCATIONS = ('${location}');`,
    );
    await conn.runQuery(alterSql(ctx.params, arn, location));

    return { storageIntegrationCreatedThisRun: true, storageIntegrationRoleArn: arn };
  },

  /**
   * The integration was already there, so this run only re-points it. The prior
   * role ARN and allowed locations are captured first: rollback has to be able
   * to put a pre-existing integration back exactly as it found it.
   */
  async reconcile(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const before = descProperties(
      await conn.runQuery(`DESC INTEGRATION ${ctx.params.SF_STORAGE_INTEGRATION_NAME};`),
    );
    const priorRoleArn = before.get("STORAGE_AWS_ROLE_ARN") ?? "";
    const priorLocations = before.get("STORAGE_ALLOWED_LOCATIONS") ?? "";

    const arn = roleArnOf(ctx);
    const location = locationOf(ctx.params);
    await conn.runQuery(alterSql(ctx.params, arn, location));

    if (priorRoleArn !== arn || priorLocations !== location) {
      ctx.log.info(`Re-pointed existing integration (was role ${priorRoleArn || "<unset>"})`);
    }

    return {
      storageIntegrationRoleArn: arn,
      priorStorageIntegrationRoleArn: priorRoleArn,
      priorStorageIntegrationLocations: priorLocations,
    };
  },

  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();

    if (ctx.outputs.storageIntegrationCreatedThisRun === true) {
      await conn.runQuery(
        `DROP STORAGE INTEGRATION IF EXISTS ${ctx.params.SF_STORAGE_INTEGRATION_NAME};`,
      );
      return;
    }

    // Reconciled an integration that already existed: restore what it had.
    const priorRoleArn = String(ctx.outputs.priorStorageIntegrationRoleArn ?? "");
    const priorLocations = String(ctx.outputs.priorStorageIntegrationLocations ?? "");
    if (!priorRoleArn && !priorLocations) return;
    await conn.runQuery(alterSql(ctx.params, priorRoleArn, priorLocations));
  },

  resource(ctx) {
    return {
      type: "snowflake_storage_integration",
      name: ctx.params.SF_STORAGE_INTEGRATION_NAME,
      attributes: { storageAwsRoleArn: roleArnOf(ctx), allowedLocation: locationOf(ctx.params) },
    };
  },

  handoff: {
    terraform: {
      type: "snowflake_storage_integration",
      address: "snowflake_storage_integration.s3_export",
      importId: (ctx) => ctx.params.SF_STORAGE_INTEGRATION_NAME,
    },
  },
};
