import type { Step } from "../../../../src/core/define";
import {
  deleteSecret,
  encryptAndPutSecret,
  getOrgSecretVisibility,
  githubClients,
  secretExists,
  setOrgSecretSelectedRepositories,
} from "../../../../src/providers/github";
import type { Params } from "../params";

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Two-layer shape, same idea as create-security-group's group-existence-vs-
 * rule-set split: check()="missing" (value never written, or FORCE_ROTATE)
 * routes to create() — a full write including visibility. check()="exists"
 * routes to reconcile() — a diff-only layer over the genuinely-readable
 * visibility/selected-repos sub-piece, still write-blind for the value
 * itself. GitHub has no way to change an org secret's `visibility` enum
 * without resupplying `encrypted_value` in the same PUT, so a visibility-
 * enum change re-encrypts SECRET_VALUE (already held in params for the
 * whole run's duration); a selected-repo-list-only change uses the
 * dedicated repositories endpoint instead, touching nothing about the value.
 */
export const orgSecretStep: Step<Params> = {
  id: "org-secret",
  title: "Create or reconcile the org Actions secret",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const { ORG, SECRET_NAME, FORCE_ROTATE } = ctx.params;
    if (FORCE_ROTATE) return "missing";
    return (await secretExists(rest, { kind: "org", org: ORG }, SECRET_NAME)) ? "exists" : "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { ORG, SECRET_NAME, SECRET_VALUE, VISIBILITY, SELECTED_REPOSITORY_IDS } = ctx.params;

    const result = await encryptAndPutSecret(rest, { kind: "org", org: ORG }, SECRET_NAME, SECRET_VALUE, {
      visibility: VISIBILITY,
      selectedRepositoryIds: SELECTED_REPOSITORY_IDS,
    });
    ctx.log.success(
      result.created
        ? `Created org secret "${SECRET_NAME}" on ${ORG} (visibility: ${VISIBILITY})`
        : `Overwrote existing org secret "${SECRET_NAME}" on ${ORG}`,
    );
    return { githubSecretCreatedThisRun: result.created };
  },

  async reconcile(ctx) {
    const { rest } = githubClients(ctx);
    const { ORG, SECRET_NAME, SECRET_VALUE, VISIBILITY, SELECTED_REPOSITORY_IDS } = ctx.params;

    const current = await getOrgSecretVisibility(rest, ORG, SECRET_NAME);
    if (!current) {
      // Vanished between check() and here (a race with a concurrent delete)
      // — fall back to a full write.
      const result = await encryptAndPutSecret(rest, { kind: "org", org: ORG }, SECRET_NAME, SECRET_VALUE, {
        visibility: VISIBILITY,
        selectedRepositoryIds: SELECTED_REPOSITORY_IDS,
      });
      return { githubSecretCreatedThisRun: result.created };
    }

    if (current.visibility !== VISIBILITY) {
      await encryptAndPutSecret(rest, { kind: "org", org: ORG }, SECRET_NAME, SECRET_VALUE, {
        visibility: VISIBILITY,
        selectedRepositoryIds: SELECTED_REPOSITORY_IDS,
      });
      ctx.log.success(`Changed org secret "${SECRET_NAME}" visibility: ${current.visibility} -> ${VISIBILITY}`);
      return {
        orgSecretPriorVisibility: current.visibility,
        orgSecretPriorSelectedIds: JSON.stringify(current.selectedRepositoryIds ?? []),
        orgSecretVisibilityChanged: true,
      };
    }

    if (VISIBILITY === "selected" && !sameIds(current.selectedRepositoryIds ?? [], SELECTED_REPOSITORY_IDS)) {
      await setOrgSecretSelectedRepositories(rest, ORG, SECRET_NAME, SELECTED_REPOSITORY_IDS);
      ctx.log.success(`Updated org secret "${SECRET_NAME}" selected-repository list`);
      return {
        orgSecretPriorSelectedIds: JSON.stringify(current.selectedRepositoryIds ?? []),
        orgSecretSelectedIdsChanged: true,
      };
    }

    ctx.log.info(`Org secret "${SECRET_NAME}" visibility/selection already matches — no-op`);
    return {};
  },

  async rollback(ctx) {
    const { rest } = githubClients(ctx);
    const { ORG, SECRET_NAME } = ctx.params;

    if (ctx.outputs.githubSecretCreatedThisRun === true) {
      await deleteSecret(rest, { kind: "org", org: ORG }, SECRET_NAME);
      return;
    }
    if (ctx.outputs.githubSecretCreatedThisRun === false) {
      ctx.log.warn(
        `Org secret "${SECRET_NAME}" on ${ORG} existed before this run and its prior value was never ` +
          `readable — leaving the current value in place rather than deleting it.`,
      );
      return;
    }
    if (ctx.outputs.orgSecretVisibilityChanged === true) {
      const priorVisibility = String(ctx.outputs.orgSecretPriorVisibility) as "all" | "private" | "selected";
      const priorSelectedIds = JSON.parse(String(ctx.outputs.orgSecretPriorSelectedIds ?? "[]")) as number[];
      ctx.log.warn(
        `Restoring org secret "${SECRET_NAME}" visibility to "${priorVisibility}" requires re-supplying ` +
          `its value — SECRET_VALUE is still held in params for this run, so this restores visibility ` +
          `correctly but cannot know whether the value itself should also change.`,
      );
      await encryptAndPutSecret(
        rest,
        { kind: "org", org: ORG },
        SECRET_NAME,
        ctx.params.SECRET_VALUE,
        { visibility: priorVisibility, selectedRepositoryIds: priorSelectedIds },
      );
      return;
    }
    if (ctx.outputs.orgSecretSelectedIdsChanged === true) {
      const priorSelectedIds = JSON.parse(String(ctx.outputs.orgSecretPriorSelectedIds ?? "[]")) as number[];
      await setOrgSecretSelectedRepositories(rest, ORG, SECRET_NAME, priorSelectedIds);
    }
  },

  resource(ctx) {
    const { ORG, SECRET_NAME, VISIBILITY } = ctx.params;
    return {
      type: "github_actions_org_secret",
      name: `${ORG}:${SECRET_NAME}`,
      attributes: { org: ORG, name: SECRET_NAME, visibility: VISIBILITY },
    };
  },
};
