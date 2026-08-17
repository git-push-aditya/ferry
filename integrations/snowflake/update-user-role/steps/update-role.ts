import type { Step } from "../../../../src/core/define";
import {
  descUser,
  grantsToUser,
  hasRoleGrant,
  snowflakeClients,
} from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Always-reconcile: `check()` reads the user's current `DEFAULT_ROLE` via
 * `DESC USER` and compares it to the desired `TARGET_DEFAULT_ROLE`. It never
 * returns `exists` when they already match by *converging* in check() itself —
 * it just always reports `missing` when they differ, and the compare-and-set
 * happens once, in reconcile(), matching the always-reconcile idiom used
 * elsewhere in this repo (e.g. `storage-integration`'s reconcile path).
 */
export const updateRoleStep: Step<Params> = {
  id: "update-default-role",
  title: "Set user's default role",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const properties = await descUser(conn, ctx.params.USER_NAME);
    const currentDefaultRole = properties.get("DEFAULT_ROLE") ?? "";

    if (currentDefaultRole.toUpperCase() === ctx.params.TARGET_DEFAULT_ROLE.toUpperCase()) {
      ctx.log.info(
        `DEFAULT_ROLE for ${ctx.params.USER_NAME} is already ${ctx.params.TARGET_DEFAULT_ROLE}`,
      );
      return "exists";
    }

    return "missing";
  },

  /**
   * A real precondition, not something this step grants itself: the target
   * role must already be granted to the user (via grant-role-to-user) before
   * it can be set as their default. Setting DEFAULT_ROLE to a role the user
   * doesn't hold would leave a session that can't actually assume it.
   */
  async reconcile(ctx) {
    const conn = await snowflakeClients(ctx).connection();

    const grantRows = await grantsToUser(conn, ctx.params.USER_NAME);
    if (!hasRoleGrant(grantRows, ctx.params.TARGET_DEFAULT_ROLE)) {
      throw new Error(
        `${ctx.params.TARGET_DEFAULT_ROLE} is not granted to ${ctx.params.USER_NAME} — ` +
          `grant it first (snowflake/grant-role-to-user) before setting it as the default role`,
      );
    }

    const properties = await descUser(conn, ctx.params.USER_NAME);
    const priorDefaultRole = properties.get("DEFAULT_ROLE") ?? "";

    // DEFAULT_ROLE takes an unquoted identifier, not a string literal;
    // TARGET_DEFAULT_ROLE is already validated safe by snowflakeIdentifier,
    // matching how storage-integration.ts embeds its own identifier params
    // without quoting.
    await conn.runQuery(
      `ALTER USER ${ctx.params.USER_NAME} SET DEFAULT_ROLE = ${ctx.params.TARGET_DEFAULT_ROLE};`,
    );
    ctx.log.success(
      `Set DEFAULT_ROLE for ${ctx.params.USER_NAME} to ${ctx.params.TARGET_DEFAULT_ROLE} (was ${priorDefaultRole || "<unset>"})`,
    );

    return { priorDefaultRole };
  },

  // Guard: skip if reconcile() was a no-op and never set the output key
  // (the s3BucketPolicyStep-style rollback guard pattern).
  async rollback(ctx) {
    if (ctx.outputs.priorDefaultRole === undefined) return;
    const conn = await snowflakeClients(ctx).connection();
    const priorDefaultRole = String(ctx.outputs.priorDefaultRole);
    if (!priorDefaultRole) return;
    await conn.runQuery(`ALTER USER ${ctx.params.USER_NAME} SET DEFAULT_ROLE = ${priorDefaultRole};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_user_default_role",
      name: ctx.params.USER_NAME,
      attributes: { user: ctx.params.USER_NAME, defaultRole: ctx.params.TARGET_DEFAULT_ROLE },
    };
  },
};
