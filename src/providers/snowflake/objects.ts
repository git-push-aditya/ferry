import type { StepState } from "../../core/define";
import type { SnowflakeConnection, SnowflakeRow } from "./client";
import { descProperties, showMatchesExactly } from "./ddl";

/**
 * Snowflake string literals are single-quoted; a literal single quote inside
 * one must be doubled, or the SQL text truncates silently at the first
 * embedded quote (a name like "O'Brien" or a multi-line RSA key would
 * otherwise break the statement, not just mis-render it).
 */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function showState(
  conn: SnowflakeConnection,
  objectType: "USERS" | "ROLES" | "WAREHOUSES",
  name: string,
): Promise<StepState> {
  const rows = await conn.runQuery(`SHOW ${objectType} LIKE ${sqlLiteral(name)};`);
  return showMatchesExactly(rows, name) ? "exists" : "missing";
}

export function userState(conn: SnowflakeConnection, name: string): Promise<StepState> {
  return showState(conn, "USERS", name);
}

export function roleState(conn: SnowflakeConnection, name: string): Promise<StepState> {
  return showState(conn, "ROLES", name);
}

export function warehouseState(conn: SnowflakeConnection, name: string): Promise<StepState> {
  return showState(conn, "WAREHOUSES", name);
}

/** Flattens `DESC USER`/`SHOW USERS`-style property rows the same way descProperties does for integrations/stages. */
export async function descUser(conn: SnowflakeConnection, name: string): Promise<Map<string, string>> {
  return descProperties(await conn.runQuery(`DESC USER ${name};`));
}

export async function descWarehouse(
  conn: SnowflakeConnection,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await conn.runQuery(`SHOW WAREHOUSES LIKE ${sqlLiteral(name)};`);
  return rows.find((r) => showMatchesExactly([r], name));
}

/** `SHOW GRANTS TO USER <name>` — every role currently granted to a user. */
export async function grantsToUser(conn: SnowflakeConnection, name: string): Promise<SnowflakeRow[]> {
  return conn.runQuery(`SHOW GRANTS TO USER ${name};`);
}

/** `SHOW GRANTS OF ROLE <name>` — every user/role this role is granted to. */
export async function grantsOfRole(conn: SnowflakeConnection, name: string): Promise<SnowflakeRow[]> {
  return conn.runQuery(`SHOW GRANTS OF ROLE ${name};`);
}

/** `SHOW GRANTS ON <objectType> <name>` — every privilege granted on an object. */
export async function grantsOnObject(
  conn: SnowflakeConnection,
  objectType: string,
  name: string,
): Promise<SnowflakeRow[]> {
  return conn.runQuery(`SHOW GRANTS ON ${objectType} ${name};`);
}

function grantRow(row: SnowflakeRow, key: string, altKey: string): string {
  return String(row[key] ?? row[altKey] ?? "");
}

/** True if `roleName` is currently granted to `userName` (per SHOW GRANTS TO USER's "role" column). */
export function hasRoleGrant(rows: SnowflakeRow[], roleName: string): boolean {
  const target = roleName.toUpperCase();
  return rows.some((row) => grantRow(row, "role", "ROLE").toUpperCase() === target);
}
