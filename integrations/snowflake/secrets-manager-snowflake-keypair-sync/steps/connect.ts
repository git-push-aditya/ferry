import type { Step } from "../../../../src/core/define";
import { snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/** Same shape as every other snowflake/* integration's local connect step. */
export const connectStep: Step<Params> = {
  id: "snowflake-connect",
  title: "Connect to Snowflake",

  async check(ctx) {
    await snowflakeClients(ctx).connection();
    ctx.log.info("Connected; SELECT 1 self-check passed");
    return "exists";
  },

  async rollback() {},
};
