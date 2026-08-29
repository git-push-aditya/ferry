import type { Step } from "../../../../src/core/define";
import { grantsToUser, hasRoleGrant, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** Role names a `SHOW GRANTS TO USER` result says the user currently holds. */
function heldRoles(rows: Array<Record<string, unknown>>): string[] {
  return rows
    .filter((r) => String(r.granted_to ?? r.GRANTED_TO ?? "").toUpperCase() === "USER")
    .map((r) => String(r.role ?? r.ROLE ?? ""))
    .filter(Boolean);
}

/**
 * True if the error is Snowflake's "does not exist or not authorized" for
 * `SHOW GRANTS TO USER` against a user that isn't there. Carried over from
 * the former revoke-role-from-user: a nonexistent user trivially holds no
 * roles, which is a real state this step has to reason about rather than
 * crash on.
 */
function isUserNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not exist or not authorized/i.test(message);
}

/**
 * Converge, not command. `check()` diffs the user's live role set against
 * ROLES and reports `missing` when anything needs granting (or, with
 * PRUNE_UNMANAGED_ROLES, revoking); `create()` applies both lists.
 *
 * This is the one place the three former integrations genuinely differed, and
 * expressing it as a set diff collapses them: granting is a non-empty add
 * list, revoking is a non-empty remove list, and a role change is both at
 * once. Re-running is a true no-op because the diff comes out empty, which
 * `GRANT`/`REVOKE` as standalone verbs never gave us.
 */
export const rolesStep: Step<Params> = {
  id: "user-roles",
  title: "Converge the user's granted roles",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME, ROLES, PRUNE_UNMANAGED_ROLES } = ctx.params;

    let rows;
    try {
      rows = await grantsToUser(conn, USER_NAME);
    } catch (err) {
      if (isUserNotFound(err)) {
        // A user that does not exist cannot be converged, and this step does
        // not create users. Surface it in the plan rather than at apply time.
        ctx.log.warn(`User ${USER_NAME} does not exist — create it before assigning roles.`);
        return "conflict";
      }
      throw err;
    }

    const toGrant = ROLES.filter((r) => !hasRoleGrant(rows, r));
    const toRevoke = PRUNE_UNMANAGED_ROLES
      ? heldRoles(rows).filter((r) => !ROLES.some((d) => d.toUpperCase() === r.toUpperCase()))
      : [];

    if (toGrant.length === 0 && toRevoke.length === 0) {
      ctx.log.info(`${USER_NAME} already holds exactly the requested roles`);
      return "exists";
    }

    if (toGrant.length > 0) ctx.log.info(`Will grant: ${toGrant.join(", ")}`);
    if (toRevoke.length > 0) ctx.log.info(`Will revoke: ${toRevoke.join(", ")}`);
    return "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME, ROLES, PRUNE_UNMANAGED_ROLES } = ctx.params;

    const rows = await grantsToUser(conn, USER_NAME);
    const toGrant = ROLES.filter((r) => !hasRoleGrant(rows, r));
    const toRevoke = PRUNE_UNMANAGED_ROLES
      ? heldRoles(rows).filter((r) => !ROLES.some((d) => d.toUpperCase() === r.toUpperCase()))
      : [];

    for (const role of toGrant) {
      await conn.runQuery(`GRANT ROLE ${role} TO USER ${USER_NAME};`);
      ctx.log.success(`Granted ${role} to ${USER_NAME}`);
    }
    for (const role of toRevoke) {
      await conn.runQuery(`REVOKE ROLE ${role} FROM USER ${USER_NAME};`);
      ctx.log.success(`Revoked ${role} from ${USER_NAME}`);
    }

    // Recorded so rollback restores exactly the delta this run applied, and
    // nothing that was already true beforehand.
    return {
      rolesGrantedThisRun: JSON.stringify(toGrant),
      rolesRevokedThisRun: JSON.stringify(toRevoke),
    };
  },

  /** Undo this run's delta only: revoke what we granted, re-grant what we revoked. */
  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME } = ctx.params;

    const granted = JSON.parse(String(ctx.outputs.rolesGrantedThisRun ?? "[]")) as string[];
    const revoked = JSON.parse(String(ctx.outputs.rolesRevokedThisRun ?? "[]")) as string[];

    for (const role of granted) {
      await conn.runQuery(`REVOKE ROLE ${role} FROM USER ${USER_NAME};`);
    }
    for (const role of revoked) {
      await conn.runQuery(`GRANT ROLE ${role} TO USER ${USER_NAME};`);
    }
  },

  resource(ctx) {
    return {
      type: "snowflake_user_role_set",
      name: ctx.params.USER_NAME,
      attributes: {
        user: ctx.params.USER_NAME,
        roles: ctx.params.ROLES.join(","),
        pruned: String(ctx.params.PRUNE_UNMANAGED_ROLES),
      },
    };
  },
};
