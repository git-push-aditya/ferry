import type { Step } from "../../../../src/core/define";
import { findExactMatch, snowflakeClients } from "../../../../src/providers/snowflake";
import { argTypesList, functionSignature, type Params } from "../params";

/**
 * Create-only — no settings-drift reconcile. Changing the argument
 * signature or return type after creation requires dropping and
 * recreating the function (Snowflake has no ALTER for those fields), which
 * this step does not attempt automatically.
 */
export const externalFunctionStep: Step<Params> = {
  id: "external-function",
  title: "Create external function",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const rows = await conn.runQuery(`SHOW USER FUNCTIONS LIKE '${ctx.params.SF_EXTERNAL_FUNCTION_NAME}';`);
    return findExactMatch(rows, ctx.params.SF_EXTERNAL_FUNCTION_NAME) ? "exists" : "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const argTypes = argTypesList(ctx.params);
    const argList = argTypes.map((t, i) => `arg${i + 1} ${t}`).join(", ");

    await conn.runQuery(
      `CREATE EXTERNAL FUNCTION ${ctx.params.SF_EXTERNAL_FUNCTION_NAME} (${argList})
        RETURNS ${ctx.params.SF_FUNCTION_RETURNS}
        API_INTEGRATION = ${ctx.params.SF_API_INTEGRATION_NAME}
        AS '${ctx.params.API_GATEWAY_INVOKE_URL}';`,
    );
    ctx.log.success(`Created external function "${functionSignature(ctx.params)}"`);
    return { externalFunctionCreatedThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.externalFunctionCreatedThisRun !== true) return;
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`DROP FUNCTION IF EXISTS ${functionSignature(ctx.params)};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_external_function",
      name: ctx.params.SF_EXTERNAL_FUNCTION_NAME,
      attributes: {
        signature: functionSignature(ctx.params),
        integration: ctx.params.SF_API_INTEGRATION_NAME,
        invokeUrl: ctx.params.API_GATEWAY_INVOKE_URL,
      },
    };
  },

  handoff: {
    terraform: {
      type: "snowflake_external_function",
      address: "snowflake_external_function.this",
      importId: (ctx) => ctx.params.SF_EXTERNAL_FUNCTION_NAME,
    },
  },
};
