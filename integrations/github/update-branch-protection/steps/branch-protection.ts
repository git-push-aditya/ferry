import type { Step } from "../../../../src/core/define";
import {
  branchExists,
  branchProtectionMatches,
  deleteBranchProtection,
  getBranchProtection,
  githubClients,
  putBranchProtection,
} from "../../../../src/providers/github";
import { desiredBranchProtection, type Params } from "../params";

/**
 * Always-reconcile, self-idempotent, whole-document PUT — the cleanest
 * analogue to s3VersioningStep in this whole provider: no diff math needed,
 * unlike the security-group-rules add/remove case, because branch
 * protection is a genuine full-replace API.
 *
 * check() never creates the branch itself (real precondition, same
 * non-auto-create discipline as update-security-group-rules refusing to
 * create its target group) — a missing branch is "conflict". Once the
 * branch exists, check() reports "exists" regardless of current protection
 * content: the diff/apply is reconcile()'s job, matching the project's
 * "check is shallow, not drift detection" rule.
 */
export const branchProtectionStep: Step<Params> = {
  id: "branch-protection",
  title: "Reconcile branch protection to the desired state",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, BRANCH } = ctx.params;
    if (!(await branchExists(rest, OWNER, REPO, BRANCH))) {
      ctx.log.warn(`Branch "${BRANCH}" does not exist on ${OWNER}/${REPO} — this task never creates one.`);
      return "conflict";
    }
    return "exists";
  },

  async reconcile(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, BRANCH } = ctx.params;
    const desired = desiredBranchProtection(ctx.params);

    const prior = await getBranchProtection(rest, OWNER, REPO, BRANCH);
    if (prior && branchProtectionMatches(prior, desired)) {
      ctx.log.info(`Branch protection on ${OWNER}/${REPO}@${BRANCH} already matches — no-op`);
      return { branchProtectionHadPrior: true, branchProtectionPriorDocumentJson: JSON.stringify(prior) };
    }

    await putBranchProtection(rest, OWNER, REPO, BRANCH, desired);
    ctx.log.success(`Branch protection on ${OWNER}/${REPO}@${BRANCH} reconciled`);

    return {
      branchProtectionHadPrior: Boolean(prior),
      branchProtectionPriorDocumentJson: prior ? JSON.stringify(prior) : "",
      branchProtectionChanged: true,
    };
  },

  /** A real, complete restore either way — PUT the prior document back verbatim, or DELETE if there was none. */
  async rollback(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, BRANCH } = ctx.params;
    if (ctx.outputs.branchProtectionChanged !== true) return;

    if (ctx.outputs.branchProtectionHadPrior === true) {
      const prior = JSON.parse(String(ctx.outputs.branchProtectionPriorDocumentJson));
      await putBranchProtection(rest, OWNER, REPO, BRANCH, {
        required_status_checks: prior.required_status_checks ?? null,
        required_pull_request_reviews: prior.required_pull_request_reviews ?? null,
        enforce_admins: prior.enforce_admins?.enabled ?? null,
        restrictions: prior.restrictions ?? null,
      });
    } else {
      await deleteBranchProtection(rest, OWNER, REPO, BRANCH);
    }
  },

  resource(ctx) {
    const { OWNER, REPO, BRANCH } = ctx.params;
    return {
      type: "github_branch_protection",
      name: `${OWNER}/${REPO}@${BRANCH}`,
      attributes: { owner: OWNER, repo: REPO, branch: BRANCH },
    };
  },
};
