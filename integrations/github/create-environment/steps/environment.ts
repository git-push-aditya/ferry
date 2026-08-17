import type { Step } from "../../../../src/core/define";
import { githubClients, repoState } from "../../../../src/providers/github";
import { desiredDeploymentBranchPolicy, type Params } from "../params";

interface EnvironmentRead {
  id?: number;
}

/**
 * Create-or-skip, mirroring create-security-group: environment identity
 * (its name) doesn't change once created, and a mismatched wait_timer/
 * reviewers/deployment-branch-policy on an already-existing environment is
 * not reconciled by this task — check() is a shallow presence probe, same
 * "check is shallow, not drift detection" rule used throughout this
 * project. `PUT` is itself idempotent-by-verb (a PUT to a non-existent
 * environment name creates it), reinforcing (not replacing) this check().
 */
export const environmentStep: Step<Params> = {
  id: "environment",
  title: "Ensure a deployment environment",

  async check(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, ENVIRONMENT_NAME } = ctx.params;

    if ((await repoState(clients.rest, OWNER, REPO)) === "missing") {
      ctx.log.warn(`Repo "${OWNER}/${REPO}" does not exist — run github/create-repo first.`);
      return "conflict";
    }

    const res = await clients.rest.raw("GET", `/repos/${OWNER}/${REPO}/environments/${ENVIRONMENT_NAME}`);
    if (res.status === 404) return "missing";
    if (res.status === 200) return "exists";
    throw new Error(`Failed to read environment "${ENVIRONMENT_NAME}" on ${OWNER}/${REPO}: HTTP ${res.status}`);
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, ENVIRONMENT_NAME, WAIT_TIMER, REVIEWERS } = ctx.params;

    const res = await rest.request<EnvironmentRead>(
      "PUT",
      `/repos/${OWNER}/${REPO}/environments/${ENVIRONMENT_NAME}`,
      {
        okStatuses: [200, 201],
        body: {
          wait_timer: WAIT_TIMER,
          reviewers: REVIEWERS,
          deployment_branch_policy: desiredDeploymentBranchPolicy(ctx.params),
        },
      },
    );

    ctx.log.success(`Environment "${ENVIRONMENT_NAME}" ensured on ${OWNER}/${REPO}`);
    return { environmentId: res.data.id ?? null, environmentCreatedThisRun: true };
  },

  /**
   * Real and complete for an environment this run created — but deleting an
   * environment also removes its secrets, a wider blast radius than
   * deleting a single repo secret (worth the README callout).
   */
  async rollback(ctx) {
    if (ctx.outputs.environmentCreatedThisRun !== true) return;
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, ENVIRONMENT_NAME } = ctx.params;
    await rest.request("DELETE", `/repos/${OWNER}/${REPO}/environments/${ENVIRONMENT_NAME}`, {
      okStatuses: [204, 404],
    });
  },

  resource(ctx) {
    const { OWNER, REPO, ENVIRONMENT_NAME } = ctx.params;
    return {
      type: "github_environment",
      name: `${OWNER}/${REPO}:${ENVIRONMENT_NAME}`,
      attributes: { owner: OWNER, repo: REPO, name: ENVIRONMENT_NAME },
    };
  },
};
