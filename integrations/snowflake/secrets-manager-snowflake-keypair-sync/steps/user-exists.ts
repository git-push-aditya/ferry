import type { Step } from "../../../../src/core/define";
import { snowflakeClients, userState } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Precondition: this integration never creates a Snowflake user — same
 * "missing folds into conflict" shape as iamRoleExistsGuardStep.
 */
export const userExistsGuardStep: Step<Params> = {
  id: "user-exists",
  title: "Confirm the Snowflake user already exists",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const state = await userState(conn, ctx.params.SF_USER_NAME);
    if (state === "missing") {
      ctx.log.error(
        `Snowflake user "${ctx.params.SF_USER_NAME}" does not exist. This integration operates on ` +
          `an existing user and does not create one.`,
      );
      return "conflict";
    }
    return state;
  },

  async rollback() {},
};
