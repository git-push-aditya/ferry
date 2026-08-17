import type { Step } from "../../../../src/core/define";
import type { Params } from "../params";

/**
 * A tiny local guard, placed first, ahead of the actual delete. Mirrors
 * aws/iam/user/delete-user's confirmDestructiveStep: check() returns
 * "conflict" (never "missing") when the flag is false, aborting cleanly in
 * the plan phase before any mutation.
 */
export const confirmDestructiveStep: Step<Params> = {
  id: "confirm-destructive-teardown",
  title: "Confirm destructive repo deletion is explicitly allowed",

  async check(ctx) {
    if (!ctx.params.ALLOW_DESTRUCTIVE_TEARDOWN) {
      ctx.log.warn(
        `Set ALLOW_DESTRUCTIVE_TEARDOWN=true to proceed — this permanently deletes ` +
          `"${ctx.params.OWNER}/${ctx.params.REPO}" with no recovery path this tool can invoke ` +
          `(commit history, issues, PRs, and settings are all gone for good).`,
      );
      return "conflict";
    }
    return "exists";
  },

  async rollback() {
    // A read-only precondition changes nothing, so there is nothing to undo.
  },
};
