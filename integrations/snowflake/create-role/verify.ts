import type { StepContext } from "../../../src/core/define";
import { roleState, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();

  const state = await roleState(conn, ctx.params.ROLE_NAME);
  if (state !== "exists") {
    throw new Error(`Role ${ctx.params.ROLE_NAME} not found after create`);
  }
  ctx.log.success(`Role ${ctx.params.ROLE_NAME} exists`);

  if (ctx.params.INITIAL_GRANTS.length === 0) return;

  const rows = await conn.runQuery(`SHOW GRANTS TO ROLE ${ctx.params.ROLE_NAME};`);
  for (const grant of ctx.params.INITIAL_GRANTS) {
    const found = rows.some((row) => {
      const privilege = String(row.privilege ?? row.PRIVILEGE ?? "").toUpperCase();
      const name = String(row.name ?? row.NAME ?? "").toUpperCase();
      return privilege === grant.privilege.toUpperCase() && name === grant.onName.toUpperCase();
    });
    if (!found) {
      throw new Error(
        `Expected grant ${grant.privilege} ON ${grant.onType} ${grant.onName} not found on role ${ctx.params.ROLE_NAME}`,
      );
    }
  }
  ctx.log.success(`All ${ctx.params.INITIAL_GRANTS.length} initial grant(s) confirmed`);
}
