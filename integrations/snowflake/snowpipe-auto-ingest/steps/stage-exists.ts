import type { Step } from "../../../../src/core/define";
import { showsExactly, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Precondition: this integration never creates a stage — run
 * snowflake/create-storage-s3-integration first. Same "missing folds into
 * conflict" shape as iamRoleExistsGuardStep, for the same reason: without
 * this, a missing stage would silently plan a skip and the real failure
 * would only surface as a raw SQL compilation error partway through apply.
 */
export const stageExistsGuardStep: Step<Params> = {
  id: "stage-exists",
  title: "Confirm the stage already exists",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const exists = await showsExactly(conn, "STAGES", ctx.params.SF_STAGE_NAME);
    if (!exists) {
      ctx.log.error(
        `Stage "${ctx.params.SF_STAGE_NAME}" does not exist. This integration operates on an ` +
          `existing stage and does not create one — run snowflake/create-storage-s3-integration first.`,
      );
      return "conflict";
    }
    return "exists";
  },

  async rollback() {},
};
