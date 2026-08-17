import type { Step, StepOutputs } from "../../../../src/core/define";
import {
  grantsOfRole,
  grantsToUser,
  snowflakeClients,
  userState,
  type SnowflakeConnection,
  type SnowflakeRow,
} from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** `SHOW GRANTS TO USER` / `SHOW GRANTS OF ROLE` return the role name under a "role" (or "ROLE") column. */
function roleNameOf(row: SnowflakeRow): string {
  return String(row["role"] ?? row["ROLE"] ?? "");
}

/** `SHOW GRANTS TO ROLE` returns the privilege under a "privilege" (or "PRIVILEGE") column. */
function privilegeOf(row: SnowflakeRow): string {
  return String(row["privilege"] ?? row["PRIVILEGE"] ?? "");
}

function grantedOnOf(row: SnowflakeRow): string {
  return String(row["granted_on"] ?? row["GRANTED_ON"] ?? "");
}

function nameOf(row: SnowflakeRow): string {
  return String(row["name"] ?? row["NAME"] ?? "");
}

export interface RolePrivilege {
  privilege: string;
  grantedOn: string;
  name: string;
}

export interface RoleAudit {
  roleName: string;
  /** Every privilege/object this role itself holds, from `SHOW GRANTS TO ROLE`. */
  privileges: RolePrivilege[];
  /** Parent roles this role has been granted to, from `SHOW GRANTS OF ROLE` (role-hierarchy walk). */
  grantedToRoles: string[];
}

export interface AuditReport {
  userName: string;
  disabled: string;
  defaultRole: string;
  hasRsaKey: boolean;
  roles: RoleAudit[];
}

/**
 * Walks `SHOW GRANTS TO ROLE` for a single role, plus `SHOW GRANTS OF ROLE`
 * for its role-hierarchy parents. Snowflake role grants can form a DAG, not
 * strictly a tree, so callers must guard against cycles with a visited set —
 * done here by only ever calling this once per distinct role name.
 */
async function auditRole(conn: SnowflakeConnection, roleName: string): Promise<RoleAudit> {
  const [privilegeRows, ofRoleRows] = await Promise.all([
    conn.runQuery(`SHOW GRANTS TO ROLE ${roleName};`),
    grantsOfRole(conn, roleName),
  ]);

  const privileges: RolePrivilege[] = privilegeRows.map((row) => ({
    privilege: privilegeOf(row),
    grantedOn: grantedOnOf(row),
    name: nameOf(row),
  }));

  // "OF ROLE" lists what the role has itself been granted to (its parents),
  // filtered to rows that are themselves roles rather than users.
  const grantedToRoles = ofRoleRows
    .filter((row) => String(row["granted_to"] ?? row["GRANTED_TO"] ?? "").toUpperCase() === "ROLE")
    .map((row) => String(row["grantee_name"] ?? row["GRANTEE_NAME"] ?? ""))
    .filter((name) => name.length > 0);

  return { roleName, privileges, grantedToRoles };
}

/**
 * Read-only reporting step. check() always returns "missing" so create()
 * (the actual read-and-report work) runs on every invocation — this "step"
 * never reaches a skippable "exists" state, since every run re-audits fresh
 * data. No resource() and an empty rollback(): nothing is ever mutated.
 *
 * SINGLE-ACCOUNT SCOPE: this audits whichever Snowflake account the root
 * `.env` currently points at. Ferry loads one credential set per provider id
 * from the root `.env`, so auditing staging AND prod in one run would need
 * two simultaneous, distinct Snowflake connections — a shape the current
 * provider model doesn't support. To audit both, run this integration
 * twice, once per account, with the corresponding root `.env` active each
 * time. See README.md.
 */
export const auditStep: Step<Params> = {
  id: "audit-user-access",
  title: "Audit a user's roles and effective privileges",

  async check() {
    return "missing";
  },

  async create(ctx): Promise<StepOutputs> {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME } = ctx.params;

    if ((await userState(conn, USER_NAME)) !== "exists") {
      throw new Error(`Cannot audit ${USER_NAME}: no such Snowflake user in this account`);
    }

    const [grants, descRows] = await Promise.all([
      grantsToUser(conn, USER_NAME),
      conn.runQuery(`DESC USER ${USER_NAME};`),
    ]);

    const properties = new Map<string, string>();
    for (const row of descRows) {
      const key = String(row["property"] ?? row["PROPERTY"] ?? "");
      const value = String(row["value"] ?? row["VALUE"] ?? "");
      if (key) properties.set(key, value);
    }

    const roleNames = [...new Set(grants.map(roleNameOf).filter((r) => r.length > 0))];
    const roles = await Promise.all(roleNames.map((role) => auditRole(conn, role)));

    const rsaFp = properties.get("RSA_PUBLIC_KEY_FP") ?? "";
    const rsaFp2 = properties.get("RSA_PUBLIC_KEY_2_FP") ?? "";

    const report: AuditReport = {
      userName: USER_NAME,
      disabled: properties.get("DISABLED") ?? "unknown",
      defaultRole: properties.get("DEFAULT_ROLE") ?? "",
      hasRsaKey: Boolean(rsaFp) || Boolean(rsaFp2),
      roles,
    };

    ctx.log.info(
      `Audited ${USER_NAME}: ${roles.length} role(s), ` +
        `${roles.reduce((n, r) => n + r.privileges.length, 0)} total privilege grant(s)`,
    );

    return { auditReport: JSON.stringify(report) };
  },

  async rollback() {
    // Nothing was ever created or changed — a read-only audit has nothing
    // to undo.
  },
};
