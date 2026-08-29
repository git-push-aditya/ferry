import type { Step } from "../../../../src/core/define";
import {
  deleteSecret,
  encryptAndPutSecret,
  getOrgSecretVisibility,
  githubClients,
  repoState,
  secretExists,
  setOrgSecretSelectedRepositories,
} from "../../../../src/providers/github";
import { scopeOf, targetOf, type Params } from "../params";

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Write-blind, per this provider's central limitation: `GET
 * .../actions/secrets/{name}` returns metadata only, never the value, so
 * "exists" only ever means "a secret by this name is present" -- never "holds
 * the value params want." Deliberately create-or-skip (not always-reconcile)
 * by default: re-encrypting and re-PUTting every run regardless of check()
 * would be wasteful and would churn `updated_at` with no behavior change.
 * FORCE_ROTATE=true flips check() to always report "missing", routing every
 * run through create() -- safe because PUT is idempotent-by-verb even though
 * the ciphertext differs byte-for-byte each call (sealed-box encryption is
 * randomized; only the decrypted plaintext matters).
 *
 * SCOPE=org additionally has a genuinely-readable sub-piece -- `visibility`
 * and the selected-repository list -- so it is the one scope with a
 * meaningful reconcile(). The value stays write-blind at every scope.
 */
export const secretStep: Step<Params> = {
  id: "actions-secret",
  title: "Create or update the Actions secret",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const p = ctx.params;
    const target = targetOf(p);

    // Preconditions: the container has to exist. A missing one is a conflict,
    // not something this integration creates.
    if (p.SCOPE === "repo" || p.SCOPE === "environment") {
      if ((await repoState(rest, p.OWNER!, p.REPO!)) === "missing") {
        ctx.log.warn(`Repo "${p.OWNER}/${p.REPO}" does not exist — create it first.`);
        return "conflict";
      }
    }
    if (p.SCOPE === "environment") {
      const envRes = await rest.raw(
        "GET",
        `/repos/${p.OWNER}/${p.REPO}/environments/${p.ENVIRONMENT_NAME}`,
      );
      if (envRes.status === 404) {
        ctx.log.warn(
          `Environment "${p.ENVIRONMENT_NAME}" does not exist on ${p.OWNER}/${p.REPO} — ` +
            `run github/create-environment first.`,
        );
        return "conflict";
      }
    }

    if (p.FORCE_ROTATE) return "missing";
    return (await secretExists(rest, scopeOf(p), p.SECRET_NAME)) ? "exists" : "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const p = ctx.params;
    const target = targetOf(p);

    const result = await encryptAndPutSecret(
      rest,
      scopeOf(p),
      p.SECRET_NAME,
      p.SECRET_VALUE,
      p.SCOPE === "org"
        ? { visibility: p.VISIBILITY, selectedRepositoryIds: p.SELECTED_REPOSITORY_IDS }
        : undefined,
    );
    const suffix = p.SCOPE === "org" ? ` (visibility: ${p.VISIBILITY})` : "";
    ctx.log.success(
      result.created
        ? `Created secret "${p.SECRET_NAME}" on ${target}${suffix}`
        : `Overwrote existing secret "${p.SECRET_NAME}" on ${target}`,
    );
    return { githubSecretCreatedThisRun: result.created };
  },

  /**
   * Only org scope has anything readable to converge. At repo and environment
   * scope there is nothing to compare, so an existing secret is left alone --
   * FORCE_ROTATE is the way to force a rewrite.
   */
  async reconcile(ctx) {
    const { rest } = githubClients(ctx);
    const p = ctx.params;

    if (p.SCOPE !== "org") {
      ctx.log.info(
        `Secret "${p.SECRET_NAME}" on ${targetOf(p)} already exists and its value is not readable — ` +
          `leaving it alone. Set FORCE_ROTATE=true to overwrite.`,
      );
      return {};
    }

    const org = p.ORG!;
    const current = await getOrgSecretVisibility(rest, org, p.SECRET_NAME);
    if (!current) {
      // Vanished between check() and here (a race with a concurrent delete)
      // — fall back to a full write.
      const result = await encryptAndPutSecret(rest, scopeOf(p), p.SECRET_NAME, p.SECRET_VALUE, {
        visibility: p.VISIBILITY,
        selectedRepositoryIds: p.SELECTED_REPOSITORY_IDS,
      });
      return { githubSecretCreatedThisRun: result.created };
    }

    if (current.visibility !== p.VISIBILITY) {
      await encryptAndPutSecret(rest, scopeOf(p), p.SECRET_NAME, p.SECRET_VALUE, {
        visibility: p.VISIBILITY,
        selectedRepositoryIds: p.SELECTED_REPOSITORY_IDS,
      });
      ctx.log.success(
        `Changed org secret "${p.SECRET_NAME}" visibility: ${current.visibility} -> ${p.VISIBILITY}`,
      );
      return {
        orgSecretPriorVisibility: current.visibility,
        orgSecretPriorSelectedIds: JSON.stringify(current.selectedRepositoryIds ?? []),
        orgSecretVisibilityChanged: true,
      };
    }

    if (
      p.VISIBILITY === "selected" &&
      !sameIds(current.selectedRepositoryIds ?? [], p.SELECTED_REPOSITORY_IDS)
    ) {
      await setOrgSecretSelectedRepositories(rest, org, p.SECRET_NAME, p.SELECTED_REPOSITORY_IDS);
      ctx.log.success(`Updated org secret "${p.SECRET_NAME}" selected-repository list`);
      return {
        orgSecretPriorSelectedIds: JSON.stringify(current.selectedRepositoryIds ?? []),
        orgSecretSelectedIdsChanged: true,
      };
    }

    ctx.log.info(`Org secret "${p.SECRET_NAME}" visibility/selection already matches — no-op`);
    return {};
  },

  /**
   * The prior value (if any) was never readable -- write-blind, confirmed. A
   * 201 (this run alone created the secret) can be cleanly deleted; a 204
   * (this run overwrote a pre-existing secret) is left in place with a loud
   * warning, since deleting it would leave the target with NO secret at all --
   * a worse outcome than "possibly wrong value."
   */
  async rollback(ctx) {
    const { rest } = githubClients(ctx);
    const p = ctx.params;
    const target = targetOf(p);

    if (ctx.outputs.githubSecretCreatedThisRun === true) {
      await deleteSecret(rest, scopeOf(p), p.SECRET_NAME);
      return;
    }
    if (ctx.outputs.githubSecretCreatedThisRun === false) {
      ctx.log.warn(
        `Secret "${p.SECRET_NAME}" on ${target} existed before this run and its prior value was never ` +
          `readable — leaving the current value in place rather than deleting it.`,
      );
      return;
    }
    if (ctx.outputs.orgSecretVisibilityChanged === true) {
      const priorVisibility = String(ctx.outputs.orgSecretPriorVisibility) as
        | "all"
        | "private"
        | "selected";
      const priorSelectedIds = JSON.parse(
        String(ctx.outputs.orgSecretPriorSelectedIds ?? "[]"),
      ) as number[];
      ctx.log.warn(
        `Restoring org secret "${p.SECRET_NAME}" visibility to "${priorVisibility}" requires ` +
          `re-supplying its value — SECRET_VALUE is still held in params for this run, so this ` +
          `restores visibility correctly but cannot know whether the value itself should also change.`,
      );
      await encryptAndPutSecret(rest, scopeOf(p), p.SECRET_NAME, p.SECRET_VALUE, {
        visibility: priorVisibility,
        selectedRepositoryIds: priorSelectedIds,
      });
      return;
    }
    if (ctx.outputs.orgSecretSelectedIdsChanged === true) {
      const priorSelectedIds = JSON.parse(
        String(ctx.outputs.orgSecretPriorSelectedIds ?? "[]"),
      ) as number[];
      await setOrgSecretSelectedRepositories(rest, p.ORG!, p.SECRET_NAME, priorSelectedIds);
    }
  },

  resource(ctx) {
    const p = ctx.params;
    return {
      type: "github_actions_secret",
      name: `${targetOf(p)}:${p.SECRET_NAME}`,
      attributes: { scope: p.SCOPE, target: targetOf(p), name: p.SECRET_NAME },
    };
  },
};
