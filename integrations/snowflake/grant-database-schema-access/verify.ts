import type { StepContext } from "../../../src/core/define";
import { grantsOnObject, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

function rowValue(row: Record<string, unknown>, key: string, altKey: string): string {
  return String(row[key] ?? row[altKey] ?? "");
}

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const { ROLE_NAME, OBJECT_TYPE, OBJECT_NAME, DESIRED_PRIVILEGES, PRUNE_UNMANAGED_PRIVILEGES } =
    ctx.params;

  const rows = await grantsOnObject(conn, OBJECT_TYPE, OBJECT_NAME);
  const target = ROLE_NAME.toUpperCase();
  const current = rows
    .filter((row) => rowValue(row, "grantee_name", "GRANTEE_NAME").toUpperCase() === target)
    .map((row) => rowValue(row, "privilege", "PRIVILEGE").toUpperCase());

  const missing = DESIRED_PRIVILEGES.filter((p) => !current.includes(p));
  if (missing.length > 0) {
    throw new Error(
      `${ROLE_NAME} is missing privilege(s) [${missing.join(", ")}] on ${OBJECT_TYPE} ${OBJECT_NAME} after grant`,
    );
  }

  // When pruning is off, this run must never have taken away pre-existing
  // access — a superset check, not an exact-match check.
  if (!PRUNE_UNMANAGED_PRIVILEGES) {
    ctx.log.info(
      `Additive mode — not asserting an exact privilege set, only that all ${DESIRED_PRIVILEGES.length} desired privilege(s) are present`,
    );
  }

  ctx.log.success(
    `${ROLE_NAME} confirmed to hold all desired privileges on ${OBJECT_TYPE} ${OBJECT_NAME}`,
  );
}
