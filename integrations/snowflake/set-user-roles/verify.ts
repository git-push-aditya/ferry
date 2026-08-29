import type { StepContext } from "../../../src/core/define";
import { descUser, grantsToUser, hasRoleGrant, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

/**
 * Live check: re-read the user's grants and confirm the set converged --
 * every requested role present, and (when pruning) nothing extra left behind.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const { USER_NAME, ROLES, PRUNE_UNMANAGED_ROLES, DEFAULT_ROLE } = ctx.params;

  const rows = await grantsToUser(conn, USER_NAME);

  for (const role of ROLES) {
    if (!hasRoleGrant(rows, role)) {
      throw new Error(`Expected ${USER_NAME} to hold role ${role} after apply, but it is not granted`);
    }
  }
  ctx.log.success(
    ROLES.length > 0
      ? `Confirmed ${USER_NAME} holds: ${ROLES.join(", ")}`
      : `Confirmed ${USER_NAME} holds no requested roles (empty ROLES)`,
  );

  if (PRUNE_UNMANAGED_ROLES) {
    const held = rows
      .filter((r) => String(r.granted_to ?? r.GRANTED_TO ?? "").toUpperCase() === "USER")
      .map((r) => String(r.role ?? r.ROLE ?? ""))
      .filter(Boolean);
    const extra = held.filter((r) => !ROLES.some((d) => d.toUpperCase() === r.toUpperCase()));
    if (extra.length > 0) {
      throw new Error(
        `PRUNE_UNMANAGED_ROLES was set, but ${USER_NAME} still holds: ${extra.join(", ")}`,
      );
    }
    ctx.log.success(`Confirmed no unmanaged roles remain on ${USER_NAME}`);
  }

  if (DEFAULT_ROLE) {
    const properties = await descUser(conn, USER_NAME);
    const current = properties.get("DEFAULT_ROLE") ?? "";
    if (current.toUpperCase() !== DEFAULT_ROLE.toUpperCase()) {
      throw new Error(`Expected DEFAULT_ROLE ${DEFAULT_ROLE} for ${USER_NAME}, read back "${current}"`);
    }
    ctx.log.success(`Confirmed DEFAULT_ROLE is ${DEFAULT_ROLE}`);
  }
}
