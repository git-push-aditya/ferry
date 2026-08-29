import type { Step } from "../../../../src/core/define";
import { descUser, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Optional, and always-reconcile when it applies. Ordering matters and is
 * encoded by this step's position after `roles`: DEFAULT_ROLE must already be
 * granted before it can be set, or the user gets a session that cannot assume
 * their own default. `params.ts` enforces the same rule statically by
 * requiring DEFAULT_ROLE to appear in ROLES, so by the time this runs the
 * grant is guaranteed to have happened.
 */
export const defaultRoleStep: Step<Params> = {
  id: "default-role",
  title: "Set the user's default role",

  async check(ctx) {
    const { USER_NAME, DEFAULT_ROLE } = ctx.params;
    if (!DEFAULT_ROLE) return "exists";

    const conn = await snowflakeClients(ctx).connection();
    const properties = await descUser(conn, USER_NAME);
    const current = properties.get("DEFAULT_ROLE") ?? "";

    if (current.toUpperCase() === DEFAULT_ROLE.toUpperCase()) {
      ctx.log.info(`DEFAULT_ROLE for ${USER_NAME} is already ${DEFAULT_ROLE}`);
      return "exists";
    }
    return "missing";
  },

  async reconcile(ctx) {
    const { USER_NAME, DEFAULT_ROLE } = ctx.params;
    if (!DEFAULT_ROLE) return {};

    const conn = await snowflakeClients(ctx).connection();
    const properties = await descUser(conn, USER_NAME);
    const priorDefaultRole = properties.get("DEFAULT_ROLE") ?? "";

    // DEFAULT_ROLE takes an unquoted identifier, not a string literal;
    // DEFAULT_ROLE is already validated safe by snowflakeIdentifier.
    await conn.runQuery(`ALTER USER ${USER_NAME} SET DEFAULT_ROLE = ${DEFAULT_ROLE};`);
    ctx.log.success(
      `Set DEFAULT_ROLE for ${USER_NAME} to ${DEFAULT_ROLE} (was ${priorDefaultRole || "<unset>"})`,
    );

    return { priorDefaultRole };
  },

  /** A reconcile's rollback is a restore, not a delete — put the prior value back. */
  async rollback(ctx) {
    const { USER_NAME, DEFAULT_ROLE } = ctx.params;
    if (!DEFAULT_ROLE) return;

    const prior = String(ctx.outputs.priorDefaultRole ?? "");
    const conn = await snowflakeClients(ctx).connection();

    if (!prior) {
      await conn.runQuery(`ALTER USER ${USER_NAME} UNSET DEFAULT_ROLE;`);
      return;
    }
    await conn.runQuery(`ALTER USER ${USER_NAME} SET DEFAULT_ROLE = ${prior};`);
  },

  /**
   * Always declared, because `reconcile()` runs on every apply (the engine
   * routes here whenever `create()` is absent) even when DEFAULT_ROLE is
   * unset and the reconcile is a no-op. The sentinel keeps the ledger honest
   * about the difference rather than implying a default role was set.
   */
  resource(ctx) {
    return {
      type: "snowflake_user_default_role",
      name: ctx.params.USER_NAME,
      attributes: {
        user: ctx.params.USER_NAME,
        defaultRole: ctx.params.DEFAULT_ROLE ?? "(not managed by this run)",
      },
    };
  },
};
