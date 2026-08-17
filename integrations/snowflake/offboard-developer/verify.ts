import type { StepContext } from "../../../src/core/define";
import { descUser, grantsToUser, snowflakeClients, userState } from "../../../src/providers/snowflake";
import type { Params } from "./params";

/**
 * Live proof the offboarding actually stuck, not just that the statements
 * returned success. Which check applies depends on which path was taken.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const { USER_NAME, HARD_DELETE } = ctx.params;

  if (HARD_DELETE) {
    if ((await userState(conn, USER_NAME)) !== "missing") {
      throw new Error(`${USER_NAME} still exists after DROP USER`);
    }
    ctx.log.success(`Verified ${USER_NAME} no longer exists`);
    return;
  }

  const properties = await descUser(conn, USER_NAME);
  if (properties.get("DISABLED")?.toLowerCase() !== "true") {
    throw new Error(`${USER_NAME} is not DISABLED after offboarding`);
  }

  const grants = await grantsToUser(conn, USER_NAME);
  if (grants.length > 0) {
    throw new Error(`${USER_NAME} still has ${grants.length} role grant(s) after offboarding`);
  }

  ctx.log.success(`Verified ${USER_NAME} is disabled with no role grants remaining`);
}
