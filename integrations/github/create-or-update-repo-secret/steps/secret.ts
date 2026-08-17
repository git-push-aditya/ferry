import type { Step } from "../../../../src/core/define";
import {
  deleteSecret,
  encryptAndPutSecret,
  githubClients,
  repoState,
  secretExists,
} from "../../../../src/providers/github";
import type { Params } from "../params";

/**
 * Write-blind, per this provider's central limitation: `GET
 * .../actions/secrets/{name}` returns metadata only, never the value, so
 * "exists" here only ever means "a secret by this name is present" — never
 * "holds the value params want." Deliberately create-or-skip (not
 * always-reconcile) in the default mode: re-encrypting and re-PUTting on
 * every run regardless of check() would be wasteful and would churn
 * `updated_at` with no behavior change. FORCE_ROTATE=true flips check() to
 * always report "missing", routing every run through create() instead —
 * safe because PUT is idempotent-by-verb even though the ciphertext differs
 * byte-for-byte each call (sealed-box encryption is randomized; only the
 * decrypted plaintext matters).
 */
export const secretStep: Step<Params> = {
  id: "repo-secret",
  title: "Create or update the repo Actions secret",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, SECRET_NAME, FORCE_ROTATE } = ctx.params;

    if ((await repoState(rest, OWNER, REPO)) === "missing") {
      ctx.log.warn(`Repo "${OWNER}/${REPO}" does not exist — run github/create-repo first.`);
      return "conflict";
    }
    if (FORCE_ROTATE) return "missing";

    return (await secretExists(rest, { kind: "repo", owner: OWNER, repo: REPO }, SECRET_NAME))
      ? "exists"
      : "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, SECRET_NAME, SECRET_VALUE } = ctx.params;

    const result = await encryptAndPutSecret(
      rest,
      { kind: "repo", owner: OWNER, repo: REPO },
      SECRET_NAME,
      SECRET_VALUE,
    );
    ctx.log.success(
      result.created
        ? `Created secret "${SECRET_NAME}" on ${OWNER}/${REPO}`
        : `Overwrote existing secret "${SECRET_NAME}" on ${OWNER}/${REPO}`,
    );
    return { githubSecretCreatedThisRun: result.created };
  },

  /**
   * The prior value (if any) was never readable — write-blind, confirmed.
   * A 201 (this run alone created the secret) can be cleanly deleted; a 204
   * (this run overwrote a pre-existing secret) is left in place with a loud
   * warning, since deleting it would leave the repo with NO secret at all —
   * a worse outcome than "possibly wrong value."
   */
  async rollback(ctx) {
    const { OWNER, REPO, SECRET_NAME } = ctx.params;
    if (ctx.outputs.githubSecretCreatedThisRun !== true) {
      ctx.log.warn(
        `Secret "${SECRET_NAME}" on ${OWNER}/${REPO} existed before this run and its prior value was ` +
          `never readable — leaving the current value in place rather than deleting it.`,
      );
      return;
    }
    const { rest } = githubClients(ctx);
    await deleteSecret(rest, { kind: "repo", owner: OWNER, repo: REPO }, SECRET_NAME);
  },

  resource(ctx) {
    const { OWNER, REPO, SECRET_NAME } = ctx.params;
    return {
      type: "github_actions_secret",
      name: `${OWNER}/${REPO}:${SECRET_NAME}`,
      attributes: { owner: OWNER, repo: REPO, name: SECRET_NAME },
    };
  },
};
