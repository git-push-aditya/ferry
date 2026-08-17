import type { Step } from "../../../../src/core/define";
import { roleState, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * `CREATE ROLE`, then the role's initial privilege set. Uses
 * `CREATE ROLE IF NOT EXISTS` — cheap extra safety against a race between
 * check() and create() — and never `CREATE OR REPLACE`, which would silently
 * drop any grants the role already had.
 */
export const roleStep: Step<Params> = {
  id: "snowflake-role",
  title: "Create Snowflake role",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    return roleState(conn, ctx.params.ROLE_NAME);
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`CREATE ROLE IF NOT EXISTS ${ctx.params.ROLE_NAME};`);

    for (const grant of ctx.params.INITIAL_GRANTS) {
      await conn.runQuery(
        `GRANT ${grant.privilege} ON ${grant.onType} ${grant.onName} TO ROLE ${ctx.params.ROLE_NAME};`,
      );
    }

    return { roleCreatedThisRun: true };
  },

  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    // Dropping the role revokes all its grants atomically — no need to
    // individually revoke the initial grants first.
    await conn.runQuery(`DROP ROLE IF EXISTS ${ctx.params.ROLE_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_role",
      name: ctx.params.ROLE_NAME,
      attributes: {
        roleName: ctx.params.ROLE_NAME,
        grantCount: String(ctx.params.INITIAL_GRANTS.length),
      },
    };
  },
};
