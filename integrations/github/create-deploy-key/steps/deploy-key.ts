import type { Step } from "../../../../src/core/define";
import { githubClients, repoState } from "../../../../src/providers/github";
import type { Params } from "../params";

interface DeployKey {
  id: number;
  key: string;
  title?: string;
  read_only?: boolean;
}

async function listDeployKeys(
  clients: ReturnType<typeof githubClients>,
  owner: string,
  repo: string,
): Promise<DeployKey[]> {
  const res = await clients.rest.request<DeployKey[]>("GET", `/repos/${owner}/${repo}/keys`);
  return res.data;
}

/** Deploy key material always starts with the algorithm token — comparing full trimmed strings is exact. */
function sameKey(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Deploy key titles are NOT enforced unique by GitHub — same non-unique
 * surface class as webhooks. Identity is therefore the key's public-key
 * fingerprint itself (the raw key string), found by listing this repo's
 * keys and matching by content.
 *
 * GitHub additionally deduplicates identical public keys across the WHOLE
 * platform: a raw POST of a key already registered anywhere returns 422
 * "key is already in use" — a real GitHub-side uniqueness constraint,
 * different from the title-not-unique fact above. That case is only
 * discoverable via the 422 at create() time, not via a query this step can
 * make in advance (see README's flagged lower-confidence note).
 */
export const deployKeyStep: Step<Params> = {
  id: "deploy-key",
  title: "Ensure a deploy key registered on the repo",

  async check(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, PUBLIC_KEY } = ctx.params;

    if ((await repoState(clients.rest, OWNER, REPO)) === "missing") {
      ctx.log.warn(`Repo "${OWNER}/${REPO}" does not exist — run github/create-repo first.`);
      return "conflict";
    }

    const keys = await listDeployKeys(clients, OWNER, REPO);
    const match = keys.find((k) => sameKey(k.key, PUBLIC_KEY));
    return match ? "exists" : "missing";
  },

  async create(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, TITLE, PUBLIC_KEY, READ_ONLY } = ctx.params;

    const res = await clients.rest.raw<DeployKey & { message?: string }>(
      "POST",
      `/repos/${OWNER}/${REPO}/keys`,
      { title: TITLE, key: PUBLIC_KEY, read_only: READ_ONLY },
    );

    if (res.status === 422) {
      throw new Error(
        `GitHub rejected this deploy key as already in use — it's registered on some other repo on ` +
          `the platform already (GitHub deduplicates public keys account-wide). Details: ${res.data.message ?? "(none)"}`,
      );
    }
    if (res.status !== 201) {
      throw new Error(`Failed to create deploy key on ${OWNER}/${REPO}: HTTP ${res.status}`);
    }

    ctx.log.success(`Registered deploy key "${TITLE}" on ${OWNER}/${REPO} (read_only: ${READ_ONLY})`);
    return { deployKeyId: res.data.id, deployKeyCreatedThisRun: true };
  },

  async rollback(ctx) {
    const keyId = ctx.outputs.deployKeyId as number | undefined;
    if (keyId === undefined) return;
    const { rest } = githubClients(ctx);
    const { OWNER, REPO } = ctx.params;
    await rest.request("DELETE", `/repos/${OWNER}/${REPO}/keys/${keyId}`, { okStatuses: [204, 404] });
  },

  resource(ctx) {
    const { OWNER, REPO, TITLE, READ_ONLY } = ctx.params;
    return {
      type: "github_deploy_key",
      name: `${OWNER}/${REPO}:${TITLE}`,
      attributes: {
        owner: OWNER,
        repo: REPO,
        keyId: String(ctx.outputs.deployKeyId ?? ""),
        readOnly: String(READ_ONLY),
      },
    };
  },
};
