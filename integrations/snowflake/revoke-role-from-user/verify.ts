import type { StepContext } from "../../../src/core/define";
import { grantsToUser, hasRoleGrant, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

/**
 * Live functional proof: re-read `SHOW GRANTS TO USER` and confirm the role
 * is now absent. If the user itself is gone (a legitimate outcome — e.g. this
 * ran as part of offboarding after the user was already dropped), that is
 * also a clean success: there is nothing left to grant.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();

  let rows;
  try {
    rows = await grantsToUser(conn, ctx.params.USER_NAME);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist or not authorized/i.test(message)) {
      ctx.log.success(`User ${ctx.params.USER_NAME} does not exist — role is not granted`);
      return;
    }
    throw err;
  }

  if (hasRoleGrant(rows, ctx.params.ROLE_NAME)) {
    throw new Error(
      `${ctx.params.ROLE_NAME} is still granted to ${ctx.params.USER_NAME} after revoke`,
    );
  }

  ctx.log.success(`Confirmed ${ctx.params.ROLE_NAME} is not granted to ${ctx.params.USER_NAME}`);
}
