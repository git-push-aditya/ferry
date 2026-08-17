import type { Step, StepOutputs } from "../../../../src/core/define";
import { grantsToUser, snowflakeClients, userState } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** `SHOW GRANTS TO USER` returns the role name under a "role" (or "ROLE") column. */
function roleNameOf(row: Record<string, unknown>): string {
  return String(row["role"] ?? row["ROLE"] ?? "");
}

/**
 * Offboards a developer: revokes every currently-granted role, then either
 * disables the user (default, reversible) or drops it outright (opt-in,
 * irreversible). This is the inverse of the usual create-or-skip shape —
 * "already offboarded" is the clean, skippable state.
 */
export const offboardStep: Step<Params> = {
  id: "offboard-developer",
  title: "Offboard developer: revoke roles, then disable or drop the user",

  /**
   * Inverted create-or-skip: a user that's already gone (dropped, or never
   * existed) has nothing left to offboard — "exists" in this inverted sense
   * means "clean, no-op". A present user still needs offboarding, so it maps
   * to "missing" — the state that routes to create().
   */
  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const state = await userState(conn, ctx.params.USER_NAME);
    return state === "missing" ? "exists" : "missing";
  },

  async create(ctx): Promise<StepOutputs> {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME, HARD_DELETE, OFFBOARD_REASON } = ctx.params;

    // Capture the currently granted roles before revoking anything — this is
    // what makes the disable path a real, complete rollback, and what the
    // report shows regardless of which path is taken.
    const grants = await grantsToUser(conn, USER_NAME);
    const roleList = grants.map(roleNameOf).filter((r) => r.length > 0);

    for (const role of roleList) {
      await conn.runQuery(`REVOKE ROLE ${role} FROM USER ${USER_NAME};`);
    }

    if (HARD_DELETE) {
      // Opt-in, irreversible path — only taken when explicitly requested.
      await conn.runQuery(`DROP USER ${USER_NAME};`);
      ctx.log.warn(
        `${USER_NAME} was HARD DELETED (DROP USER) — this is irreversible; Snowflake has no UNDROP for users`,
      );
    } else {
      // Default, reversible path: blocks login and aborts running/scheduled
      // sessions without destroying the account, its ownership records, or
      // its query history.
      await conn.runQuery(`ALTER USER ${USER_NAME} SET DISABLED = TRUE;`);
      ctx.log.success(`${USER_NAME} disabled (DISABLED = TRUE) — reversible`);
    }

    if (OFFBOARD_REASON) {
      ctx.log.info(`Offboard reason: ${OFFBOARD_REASON}`);
    }

    return {
      hardDeleted: HARD_DELETE,
      revokedRoles: JSON.stringify(roleList),
    };
  },

  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME } = ctx.params;
    const hardDeleted = ctx.outputs.hardDeleted === true;

    if (hardDeleted) {
      // Cannot restore: a dropped user cannot be recreated with its prior
      // identity, history, or grants by this tool. Loudly say so and make
      // no API calls, rather than pretending a bare-shell recreation is
      // equivalent.
      ctx.log.warn(
        `${USER_NAME} was permanently dropped (HARD_DELETE) — rollback CANNOT recreate it. ` +
          "Snowflake has no UNDROP for users; the account, its history, and its prior grants are gone for good.",
      );
      return;
    }

    // Disable path: fully reversible. Re-enable, then re-grant every role
    // that was captured before the revoke loop ran.
    await conn.runQuery(`ALTER USER ${USER_NAME} SET DISABLED = FALSE;`);

    const roleList = JSON.parse(String(ctx.outputs.revokedRoles ?? "[]")) as string[];
    for (const role of roleList) {
      await conn.runQuery(`GRANT ROLE ${role} TO USER ${USER_NAME};`);
    }
  },

  resource(ctx) {
    const roleList = JSON.parse(String(ctx.outputs.revokedRoles ?? "[]")) as string[];
    return {
      type: "snowflake_user",
      name: ctx.params.USER_NAME,
      attributes: {
        userName: ctx.params.USER_NAME,
        action: ctx.params.HARD_DELETE ? "dropped" : "disabled",
        revokedRoleCount: String(roleList.length),
      },
    };
  },
};
