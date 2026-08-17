import type { Step } from "../../../../src/core/define";
import { grantsToUser, hasRoleGrant, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Grants an existing role to an existing user. Neither the user nor the role
 * is created here — both are real preconditions; if either is missing, the
 * GRANT statement itself errors clearly at apply time (Snowflake names the
 * missing object), which is an acceptable failure mode rather than adding
 * extra guard steps.
 */
export const grantStep: Step<Params> = {
  id: "snowflake-role-grant",
  title: "Grant Snowflake role to user",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const rows = await grantsToUser(conn, ctx.params.USER_NAME);
    return hasRoleGrant(rows, ctx.params.ROLE_NAME) ? "exists" : "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`GRANT ROLE ${ctx.params.ROLE_NAME} TO USER ${ctx.params.USER_NAME};`);
    return { roleGrantedThisRun: true };
  },

  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`REVOKE ROLE ${ctx.params.ROLE_NAME} FROM USER ${ctx.params.USER_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_role_grant",
      name: `${ctx.params.USER_NAME}:${ctx.params.ROLE_NAME}`,
      attributes: { user: ctx.params.USER_NAME, role: ctx.params.ROLE_NAME },
    };
  },
};
