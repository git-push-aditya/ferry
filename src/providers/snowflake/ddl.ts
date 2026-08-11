import type { SnowflakeConnection, SnowflakeRow } from "./client";

/**
 * SHOW ... LIKE uses SQL LIKE patterns, where '_' matches any single character —
 * and our resource names contain underscores. Row count alone would report a
 * near-miss name as "already exists" and silently skip registering rollback,
 * so match the returned name exactly (Snowflake upper-cases bare identifiers).
 */
export function showMatchesExactly(rows: SnowflakeRow[], name: string): boolean {
  const target = name.toUpperCase();
  return rows.some((row) => String(row.name ?? row.NAME ?? "").toUpperCase() === target);
}

/** Flattens `DESC INTEGRATION` / `DESC STAGE` output into property → value. */
export function descProperties(rows: SnowflakeRow[]): Map<string, string> {
  const properties = new Map<string, string>();
  for (const row of rows) {
    const property = String(row.property ?? row.PROPERTY ?? "");
    const value = String(row.property_value ?? row.PROPERTY_VALUE ?? "");
    properties.set(property, value);
  }
  return properties;
}

export async function showsExactly(
  conn: SnowflakeConnection,
  objectType: "INTEGRATIONS" | "STAGES",
  name: string,
): Promise<boolean> {
  return showMatchesExactly(await conn.runQuery(`SHOW ${objectType} LIKE '${name}';`), name);
}
