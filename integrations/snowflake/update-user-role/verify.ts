import type { StepContext } from "../../../src/core/define";
import { descUser, snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";

/**
 * Live functional proof: re-`DESC USER` and confirm `DEFAULT_ROLE` matches
 * the target.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const properties = await descUser(conn, ctx.params.USER_NAME);
  const currentDefaultRole = properties.get("DEFAULT_ROLE") ?? "";

  if (currentDefaultRole.toUpperCase() !== ctx.params.TARGET_DEFAULT_ROLE.toUpperCase()) {
    throw new Error(
      `DEFAULT_ROLE for ${ctx.params.USER_NAME} is "${currentDefaultRole}", expected "${ctx.params.TARGET_DEFAULT_ROLE}"`,
    );
  }

  ctx.log.success(
    `Confirmed DEFAULT_ROLE for ${ctx.params.USER_NAME} is ${ctx.params.TARGET_DEFAULT_ROLE}`,
  );
}
