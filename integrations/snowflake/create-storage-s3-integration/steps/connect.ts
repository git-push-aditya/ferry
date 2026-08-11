import type { Step } from "../../../../src/core/define";
import { snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Opening the connection is a read, so it belongs in check() — which means
 * `--dry-run` validates the Snowflake credentials for real instead of just
 * claiming it would. The connection is memoised on the provider client and
 * reused by every later step; the engine closes it after rollback.
 */
export const connectStep: Step<Params> = {
  id: "snowflake-connect",
  title: "Connect to Snowflake",

  async check(ctx) {
    await snowflakeClients(ctx).connection();
    ctx.log.info("Connected; SELECT 1 self-check passed");
    return "exists";
  },

  // Nothing to create or undo: a connection is not a resource.
  async rollback() {},
};
