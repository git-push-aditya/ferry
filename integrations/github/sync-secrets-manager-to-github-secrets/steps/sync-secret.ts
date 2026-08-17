import type { Step } from "../../../../src/core/define";
import { encryptAndPutSecret, githubClients, type SecretScope } from "../../../../src/providers/github";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "../params";
import {
  currentVersionId,
  describeSecret,
  getSecretPlaintext,
  lastSyncedVersionTag,
  tagLastSyncedVersion,
  untagLastSyncedVersion,
} from "./secrets-manager-read";

function targetScope(p: Params): SecretScope {
  return p.TARGET_SCOPE === "environment"
    ? { kind: "environment", owner: p.OWNER, repo: p.REPO, environment: p.ENVIRONMENT_NAME! }
    : { kind: "repo", owner: p.OWNER, repo: p.REPO };
}

/**
 * Create-or-skip, keyed on a version tag rather than always-reconcile —
 * deliberately, for least-privilege: check() must NOT call GetSecretValue
 * on every plan just to compare (that would mean every `ferry plan`
 * silently reads a live secret value into process memory even when nothing
 * needs to change). Instead it compares Secrets Manager's own notion of
 * "the current version" (VersionIdsToStages' AWSCURRENT label) against the
 * `ferry:last-synced-version` TAG this task itself writes — a tag, not
 * ctx.outputs, since outputs aren't guaranteed to persist across separate
 * CLI invocations the way a resource tag does (same reasoning
 * create-ebs-snapshot/create-ami-from-instance use tags for cross-run
 * identity).
 */
export const syncSecretStep: Step<Params> = {
  id: "sync-secret",
  title: "Sync a Secrets Manager value into a GitHub Actions secret",

  async check(ctx) {
    const { secretsManager } = awsClients(ctx);
    const { rest } = githubClients(ctx);
    const p = ctx.params;

    if ((await rest.raw("GET", `/repos/${p.OWNER}/${p.REPO}`)).status === 404) {
      ctx.log.warn(`Repo "${p.OWNER}/${p.REPO}" does not exist — run github/create-repo first.`);
      return "conflict";
    }
    if (p.TARGET_SCOPE === "environment") {
      const envRes = await rest.raw("GET", `/repos/${p.OWNER}/${p.REPO}/environments/${p.ENVIRONMENT_NAME}`);
      if (envRes.status === 404) {
        ctx.log.warn(
          `Environment "${p.ENVIRONMENT_NAME}" does not exist on ${p.OWNER}/${p.REPO} — run ` +
            `github/create-environment first.`,
        );
        return "conflict";
      }
    }

    const described = await describeSecret(secretsManager, p.SOURCE_SECRET_ID);
    const current = currentVersionId(described);
    if (!current) throw new Error(`Secret "${p.SOURCE_SECRET_ID}" has no AWSCURRENT version`);

    return current === lastSyncedVersionTag(described) ? "exists" : "missing";
  },

  async create(ctx) {
    const { secretsManager } = awsClients(ctx);
    const { rest } = githubClients(ctx);
    const p = ctx.params;

    const described = await describeSecret(secretsManager, p.SOURCE_SECRET_ID);
    const versionId = currentVersionId(described);
    if (!versionId) throw new Error(`Secret "${p.SOURCE_SECRET_ID}" has no AWSCURRENT version`);

    // Read the plaintext only now that check() has established the source
    // changed. Held in this local variable only — never assigned to
    // ctx.outputs, resource(), or logged.
    const plaintext = await getSecretPlaintext(secretsManager, p.SOURCE_SECRET_ID);
    const syncStartedAtIso = new Date().toISOString();

    await encryptAndPutSecret(rest, targetScope(p), p.TARGET_SECRET_NAME, plaintext);
    await tagLastSyncedVersion(secretsManager, p.SOURCE_SECRET_ID, versionId);

    ctx.log.success(
      `Synced Secrets Manager version ${versionId} of "${p.SOURCE_SECRET_ID}" into GitHub secret ` +
        `"${p.TARGET_SECRET_NAME}"`,
    );

    return { secretsSyncedThisRun: true, syncedVersionId: versionId, syncStartedAtIso };
  },

  /**
   * The GitHub-side prior value (if any) was never readable — same
   * write-blind limitation as create-or-update-repo-secret's rollback.
   * Additionally, this rollback does NOT revert the source Secrets Manager
   * secret's own value (it was only ever read, never modified) — it only
   * removes the version-sync tag, so the next run re-detects a "needs
   * sync" state instead of incorrectly believing a rolled-back GitHub
   * secret is still in sync.
   */
  async rollback(ctx) {
    if (ctx.outputs.secretsSyncedThisRun !== true) return;
    const { secretsManager } = awsClients(ctx);
    await untagLastSyncedVersion(secretsManager, ctx.params.SOURCE_SECRET_ID);
    ctx.log.warn(
      `Removed the "${ctx.params.SOURCE_SECRET_ID}" sync-version tag so the next run re-syncs. The ` +
        `GitHub-side secret's prior value (if any) was never readable and was NOT restored or removed.`,
    );
  },

  resource(ctx) {
    const p = ctx.params;
    const scopeLabel = p.TARGET_SCOPE === "environment" ? `${p.OWNER}/${p.REPO}:${p.ENVIRONMENT_NAME}` : `${p.OWNER}/${p.REPO}`;
    return {
      type: "github_actions_secret",
      name: `${scopeLabel}:${p.TARGET_SECRET_NAME}`,
      attributes: {
        owner: p.OWNER,
        repo: p.REPO,
        name: p.TARGET_SECRET_NAME,
        sourceSecretId: p.SOURCE_SECRET_ID,
        syncedVersionId: String(ctx.outputs.syncedVersionId ?? ""),
      },
    };
  },
};
