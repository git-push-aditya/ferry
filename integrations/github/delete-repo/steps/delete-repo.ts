import type { Step } from "../../../../src/core/define";
import { githubClients, repoState } from "../../../../src/providers/github";
import type { Params } from "../params";

/**
 * Inverted create-or-skip, mirroring aws/s3/delete-empty-bucket's
 * deleteBucketStep: the target state is "the repo is gone", so check()
 * returns "missing" when the deletion still needs to happen (repo present)
 * and "exists" when it's already achieved (repo already gone — a re-run
 * after a successful delete is a clean no-op).
 */
export const deleteRepoStep: Step<Params> = {
  id: "delete-repo",
  title: "Delete the GitHub repo",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const state = await repoState(rest, ctx.params.OWNER, ctx.params.REPO);
    return state === "missing" ? "exists" : "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO } = ctx.params;
    // GitHub's delete is synchronous per its own docs — no async lifecycle to poll.
    await rest.request("DELETE", `/repos/${OWNER}/${REPO}`, { okStatuses: [204] });
    ctx.log.success(`Deleted ${OWNER}/${REPO}`);
    return { repoDeletedThisRun: true };
  },

  /**
   * No meaningful undo — a deleted repo's commit history, issues, PRs, and
   * settings are not restorable by this tool (GitHub support can sometimes
   * restore within a short window, but that's a human/support-ticket path,
   * not an API call). Same honesty as delete-empty-bucket/terminate-instance.
   */
  async rollback(ctx) {
    if (ctx.outputs.repoDeletedThisRun !== true) return;
    ctx.log.warn(
      `"${ctx.params.OWNER}/${ctx.params.REPO}" was deleted this run and CANNOT be restored by ` +
        `this tool — commit history, issues, PRs, and settings are gone for good.`,
    );
  },

  resource(ctx) {
    return {
      type: "github_repo",
      name: `${ctx.params.OWNER}/${ctx.params.REPO}`,
      attributes: { owner: ctx.params.OWNER, name: ctx.params.REPO, action: "deleted" },
    };
  },
};
