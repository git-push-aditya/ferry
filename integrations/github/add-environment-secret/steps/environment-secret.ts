import type { Step } from "../../../../src/core/define";
import { deleteSecret, encryptAndPutSecret, githubClients, secretExists } from "../../../../src/providers/github";
import type { Params } from "../params";

/**
 * Same write-blind shape as create-or-update-repo-secret, scoped to
 * `/repos/{owner}/{repo}/environments/{environment}/secrets/{name}` — the
 * public-key fetch and sealed-box encryption are the identical shared
 * secrets.ts functions, parameterized by scope rather than duplicated. The
 * only addition: check() first confirms the named environment exists (task
 * 11's own job, or pre-existing) — a missing environment is "conflict",
 * same non-auto-create discipline as branch-protection's missing-branch
 * case.
 */
export const environmentSecretStep: Step<Params> = {
  id: "environment-secret",
  title: "Create or update an environment Actions secret",

  async check(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, ENVIRONMENT_NAME, SECRET_NAME, FORCE_ROTATE } = ctx.params;

    const envRes = await clients.rest.raw("GET", `/repos/${OWNER}/${REPO}/environments/${ENVIRONMENT_NAME}`);
    if (envRes.status === 404) {
      ctx.log.warn(
        `Environment "${ENVIRONMENT_NAME}" does not exist on ${OWNER}/${REPO} — run github/create-environment first.`,
      );
      return "conflict";
    }

    if (FORCE_ROTATE) return "missing";

    return (await secretExists(
      clients.rest,
      { kind: "environment", owner: OWNER, repo: REPO, environment: ENVIRONMENT_NAME },
      SECRET_NAME,
    ))
      ? "exists"
      : "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, ENVIRONMENT_NAME, SECRET_NAME, SECRET_VALUE } = ctx.params;

    const result = await encryptAndPutSecret(
      rest,
      { kind: "environment", owner: OWNER, repo: REPO, environment: ENVIRONMENT_NAME },
      SECRET_NAME,
      SECRET_VALUE,
    );
    ctx.log.success(
      result.created
        ? `Created secret "${SECRET_NAME}" on ${OWNER}/${REPO}:${ENVIRONMENT_NAME}`
        : `Overwrote existing secret "${SECRET_NAME}" on ${OWNER}/${REPO}:${ENVIRONMENT_NAME}`,
    );
    return { githubSecretCreatedThisRun: result.created };
  },

  async rollback(ctx) {
    const { OWNER, REPO, ENVIRONMENT_NAME, SECRET_NAME } = ctx.params;
    if (ctx.outputs.githubSecretCreatedThisRun !== true) {
      ctx.log.warn(
        `Secret "${SECRET_NAME}" on ${OWNER}/${REPO}:${ENVIRONMENT_NAME} existed before this run and its ` +
          `prior value was never readable — leaving the current value in place rather than deleting it.`,
      );
      return;
    }
    const { rest } = githubClients(ctx);
    await deleteSecret(
      rest,
      { kind: "environment", owner: OWNER, repo: REPO, environment: ENVIRONMENT_NAME },
      SECRET_NAME,
    );
  },

  resource(ctx) {
    const { OWNER, REPO, ENVIRONMENT_NAME, SECRET_NAME } = ctx.params;
    return {
      type: "github_actions_secret",
      name: `${OWNER}/${REPO}:${ENVIRONMENT_NAME}:${SECRET_NAME}`,
      attributes: { owner: OWNER, repo: REPO, environment: ENVIRONMENT_NAME, name: SECRET_NAME },
    };
  },
};
