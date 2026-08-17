import type { Step } from "../../../../../../src/core/define";
import type { Params } from "../params";

/**
 * A tiny local guard, placed first in the steps array, ahead of the actual
 * teardown. This integration destroys access keys, the login profile
 * password, MFA devices, and every policy/group attachment with no recovery
 * path — so it hard-gates on an explicit human confirmation rather than
 * proceeding on a bare "the user exists" precondition. check() returns
 * "conflict" (never "missing") when the flag is false, aborting cleanly in
 * the plan phase before any mutation, same as iamRoleExistsGuardStep's own
 * "fold to conflict, don't silently skip" idiom.
 *
 * Deliberately duplicated from delete-user's copy of this same ~15-line
 * guard rather than shared — matches this codebase's tolerance for two
 * bespoke copies of a genuinely small piece; the destructive AWS API
 * sequence itself (iamUserTeardownStep) is not duplicated.
 */
export const confirmDestructiveStep: Step<Params> = {
  id: "confirm-destructive-teardown",
  title: "Confirm destructive offboarding teardown is explicitly allowed",

  async check(ctx) {
    if (!ctx.params.ALLOW_DESTRUCTIVE_TEARDOWN) {
      ctx.log.warn(
        `Set ALLOW_DESTRUCTIVE_TEARDOWN=true to proceed — this permanently destroys credentials ` +
          `with no recovery path (access keys, login profile password, MFA devices, and every ` +
          `policy/group attachment for "${ctx.params.IAM_USER_NAME}").`,
      );
      return "conflict";
    }
    return "exists";
  },

  async rollback() {
    // A read-only precondition changes nothing, so there is nothing to undo.
  },
};
