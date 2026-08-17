import type { Step } from "../../../../src/core/define";
import { grantsToUser, hasRoleGrant, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * True if the error is Snowflake's "does not exist or not authorized" for
 * `SHOW GRANTS TO USER` against a user that isn't there. A nonexistent user
 * trivially has no grant to revoke, so this is treated as the already-clean
 * target state, not a failure.
 */
function isUserNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not exist or not authorized/i.test(message);
}

/**
 * Inverted create-or-skip, per the plan's stated convention for
 * revoke/drop/disable tasks: `check()` reports `exists` (skip, nothing to do)
 * when the role is already absent from the user's grants, and `missing`
 * (route to create(), the action slot) when the role is still granted and
 * needs revoking.
 */
export const revokeStep: Step<Params> = {
  id: "revoke-role-from-user",
  title: "Revoke role from user",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    let rows;
    try {
      rows = await grantsToUser(conn, ctx.params.USER_NAME);
    } catch (err) {
      if (isUserNotFound(err)) {
        ctx.log.info(`User ${ctx.params.USER_NAME} does not exist — nothing to revoke`);
        return "exists";
      }
      throw err;
    }

    if (!hasRoleGrant(rows, ctx.params.ROLE_NAME)) {
      ctx.log.info(`${ctx.params.ROLE_NAME} is not currently granted to ${ctx.params.USER_NAME}`);
      return "exists";
    }

    return "missing";
  },

  // The action slot Ferry routes to when check() says the revoke still needs
  // to happen.
  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`REVOKE ROLE ${ctx.params.ROLE_NAME} FROM USER ${ctx.params.USER_NAME};`);

    const rows = await grantsToUser(conn, ctx.params.USER_NAME);
    if (hasRoleGrant(rows, ctx.params.ROLE_NAME)) {
      throw new Error(
        `REVOKE ROLE ${ctx.params.ROLE_NAME} FROM USER ${ctx.params.USER_NAME} did not take effect`,
      );
    }
    ctx.log.success(`Revoked ${ctx.params.ROLE_NAME} from ${ctx.params.USER_NAME}`);

    return { revokedThisRun: true };
  },

  // Safe and simple: a role grant carries no other state, so restoring it is
  // just re-granting exactly what this run removed.
  async rollback(ctx) {
    if (ctx.outputs.revokedThisRun !== true) return;
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`GRANT ROLE ${ctx.params.ROLE_NAME} TO USER ${ctx.params.USER_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_role_grant",
      name: `${ctx.params.USER_NAME}:${ctx.params.ROLE_NAME}`,
      attributes: { user: ctx.params.USER_NAME, role: ctx.params.ROLE_NAME, action: "revoked" },
    };
  },
};
