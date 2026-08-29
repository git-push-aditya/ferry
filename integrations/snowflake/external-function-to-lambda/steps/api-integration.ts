import type { Step } from "../../../../src/core/define";
import { roleArn } from "../../../../src/providers/aws";
import { showsExactly, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

const roleArnOf = (ctx: { accountId: string; params: Params }) => roleArn(ctx.accountId, ctx.params.AWS_API_ROLE_NAME);

/**
 * Uses CREATE ... IF NOT EXISTS, never CREATE OR REPLACE — same reasoning
 * as create-storage-s3-integration's storage-integration step: replacing
 * the integration regenerates its external id, silently invalidating the
 * IAM trust policy built around the old one.
 */
export const apiIntegrationStep: Step<Params> = {
  id: "api-integration",
  title: "Create Snowflake API integration",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    return (await showsExactly(conn, "INTEGRATIONS", ctx.params.SF_API_INTEGRATION_NAME)) ? "exists" : "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const arn = roleArnOf(ctx);
    await conn.runQuery(
      `CREATE API INTEGRATION IF NOT EXISTS ${ctx.params.SF_API_INTEGRATION_NAME}
        API_PROVIDER = aws_api_gateway
        API_AWS_ROLE_ARN = '${arn}'
        API_ALLOWED_PREFIXES = ('${ctx.params.API_GATEWAY_INVOKE_URL}')
        ENABLED = TRUE;`,
    );
    return { apiIntegrationCreatedThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.apiIntegrationCreatedThisRun !== true) return;
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`DROP API INTEGRATION IF EXISTS ${ctx.params.SF_API_INTEGRATION_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_api_integration",
      name: ctx.params.SF_API_INTEGRATION_NAME,
      attributes: { roleArn: roleArnOf(ctx), allowedPrefix: ctx.params.API_GATEWAY_INVOKE_URL },
    };
  },

  handoff: {
    terraform: {
      type: "snowflake_api_integration",
      address: "snowflake_api_integration.this",
      importId: (ctx) => ctx.params.SF_API_INTEGRATION_NAME,
    },
  },
};
