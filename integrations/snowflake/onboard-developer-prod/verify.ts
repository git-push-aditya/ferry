import type { StepContext } from "../../../src/core/define";
import { grantsToUser, hasRoleGrant, snowflakeClients, userState } from "../../../src/providers/snowflake";
import type { Params } from "./params";

/**
 * Live proof: the user exists and actually holds the default role — not
 * just that the CREATE/GRANT statements returned success.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const { USER_NAME, DEFAULT_ROLE } = ctx.params;

  if ((await userState(conn, USER_NAME)) !== "exists") {
    throw new Error(`User ${USER_NAME} does not exist after onboarding`);
  }

  const grants = await grantsToUser(conn, USER_NAME);
  if (!hasRoleGrant(grants, DEFAULT_ROLE)) {
    throw new Error(`User ${USER_NAME} is missing the ${DEFAULT_ROLE} role grant`);
  }

  ctx.log.success(`Verified ${USER_NAME} exists with role ${DEFAULT_ROLE} granted`);
}
