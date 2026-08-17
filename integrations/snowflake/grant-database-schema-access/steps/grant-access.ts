import type { Step } from "../../../../src/core/define";
import { grantsOnObject, snowflakeClients } from "../../../../src/providers/snowflake";
import type { SnowflakeRow } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

function rowValue(row: SnowflakeRow, key: string, altKey: string): string {
  return String(row[key] ?? row[altKey] ?? "");
}

/** Privileges `SHOW GRANTS ON <type> <name>` reports as currently held by `roleName`. */
function currentPrivilegesForRole(rows: SnowflakeRow[], roleName: string): string[] {
  const target = roleName.toUpperCase();
  return rows
    .filter((row) => rowValue(row, "grantee_name", "GRANTEE_NAME").toUpperCase() === target)
    .map((row) => rowValue(row, "privilege", "PRIVILEGE").toUpperCase());
}

/**
 * Converges the role's privilege set on the target database/schema to
 * exactly `DESIRED_PRIVILEGES`. Always reconciles (no create()): granting the
 * same privilege twice is a safe no-op, but "the set of privileges this role
 * should have on this object" is naturally a diff-and-converge operation, not
 * a one-shot create — same spirit as `rotate-role-permissions` for AWS IAM,
 * though GRANT/REVOKE here has no attach-before-detach ordering concern the
 * way IAM policy attachment did.
 */
export const grantAccessStep: Step<Params> = {
  id: "grant-access",
  title: "Converge role privileges on database/schema",

  // The desired vs. current diff is what decides whether there's anything to
  // do, not a static missing/exists check — always reconcile.
  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { ROLE_NAME, OBJECT_TYPE, OBJECT_NAME, DESIRED_PRIVILEGES, PRUNE_UNMANAGED_PRIVILEGES } =
      ctx.params;

    // Real preconditions: if the role or the object doesn't exist, the GRANT
    // statement below errors clearly (Snowflake names the missing object) —
    // an acceptable failure mode, matching grant-role-to-user's established
    // pattern of not adding extra guard steps for this.
    const rows = await grantsOnObject(conn, OBJECT_TYPE, OBJECT_NAME);
    const current = currentPrivilegesForRole(rows, ROLE_NAME);

    const toGrant = DESIRED_PRIVILEGES.filter((p) => !current.includes(p));
    const toRevoke = PRUNE_UNMANAGED_PRIVILEGES
      ? current.filter((p) => !DESIRED_PRIVILEGES.includes(p))
      : [];

    if (toGrant.length === 0 && toRevoke.length === 0) {
      ctx.log.info(
        `${ROLE_NAME} already has exactly the desired ${DESIRED_PRIVILEGES.length} privilege(s) on ${OBJECT_TYPE} ${OBJECT_NAME}`,
      );
      return { executedGrants: JSON.stringify([]), executedRevokes: JSON.stringify([]) };
    }

    ctx.log.info(
      `${ROLE_NAME} on ${OBJECT_TYPE} ${OBJECT_NAME}: ${toGrant.length} to grant, ${toRevoke.length} to revoke`,
    );

    const executedGrants: string[] = [];
    if (toGrant.length > 0) {
      await conn.runQuery(
        `GRANT ${toGrant.join(", ")} ON ${OBJECT_TYPE} ${OBJECT_NAME} TO ROLE ${ROLE_NAME};`,
      );
      executedGrants.push(...toGrant);
    }

    const executedRevokes: string[] = [];
    for (const privilege of toRevoke) {
      await conn.runQuery(
        `REVOKE ${privilege} ON ${OBJECT_TYPE} ${OBJECT_NAME} FROM ROLE ${ROLE_NAME};`,
      );
      executedRevokes.push(privilege);
    }

    ctx.log.success(
      `${ROLE_NAME}: granted ${executedGrants.length}, revoked ${executedRevokes.length} on ${OBJECT_TYPE} ${OBJECT_NAME}`,
    );

    return {
      executedGrants: JSON.stringify(executedGrants),
      executedRevokes: JSON.stringify(executedRevokes),
    };
  },

  /**
   * Inverse of what was actually executed, using the EXECUTED lists (not the
   * originally-computed toGrant/toRevoke, which may differ from a partial
   * failure) — restores exactly the privilege set this run found.
   */
  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { ROLE_NAME, OBJECT_TYPE, OBJECT_NAME } = ctx.params;
    const executedGrants = JSON.parse((ctx.outputs.executedGrants as string) ?? "[]") as string[];
    const executedRevokes = JSON.parse((ctx.outputs.executedRevokes as string) ?? "[]") as string[];

    for (const privilege of executedGrants) {
      await conn.runQuery(
        `REVOKE ${privilege} ON ${OBJECT_TYPE} ${OBJECT_NAME} FROM ROLE ${ROLE_NAME};`,
      );
    }
    if (executedRevokes.length > 0) {
      await conn.runQuery(
        `GRANT ${executedRevokes.join(", ")} ON ${OBJECT_TYPE} ${OBJECT_NAME} TO ROLE ${ROLE_NAME};`,
      );
    }
  },

  resource(ctx) {
    const { ROLE_NAME, OBJECT_TYPE, OBJECT_NAME, DESIRED_PRIVILEGES } = ctx.params;
    return {
      type: "snowflake_grant",
      name: `${ROLE_NAME}:${OBJECT_TYPE}:${OBJECT_NAME}`,
      attributes: {
        role: ROLE_NAME,
        objectType: OBJECT_TYPE,
        objectName: OBJECT_NAME,
        privilegeCount: String(DESIRED_PRIVILEGES.length),
      },
    };
  },
};
