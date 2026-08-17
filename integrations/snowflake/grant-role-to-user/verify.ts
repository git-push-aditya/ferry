import type { StepContext } from "../../../src/core/define";
import { grantsToUser, hasRoleGrant, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const rows = await grantsToUser(conn, ctx.params.USER_NAME);
  if (!hasRoleGrant(rows, ctx.params.ROLE_NAME)) {
    throw new Error(
      `Role ${ctx.params.ROLE_NAME} not found among grants to user ${ctx.params.USER_NAME} after grant`,
    );
  }
  ctx.log.success(`Role ${ctx.params.ROLE_NAME} confirmed granted to ${ctx.params.USER_NAME}`);
}
