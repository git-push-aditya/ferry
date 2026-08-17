import type { StepContext } from "../../../src/core/define";
import { awsClients } from "../../../src/providers/aws";
import { getSecretMetadata, githubClients, type SecretScope } from "../../../src/providers/github";
import type { Params } from "./params";
import { describeSecret, lastSyncedVersionTag } from "./steps/secrets-manager-read";

function targetScope(p: Params): SecretScope {
  return p.TARGET_SCOPE === "environment"
    ? { kind: "environment", owner: p.OWNER, repo: p.REPO, environment: p.ENVIRONMENT_NAME! }
    : { kind: "repo", owner: p.OWNER, repo: p.REPO };
}

/**
 * The AWS-side half is genuinely verifiable (the sync-version tag). The
 * GitHub-side half is shallow, same as create-or-update-repo-secret's own
 * verify(): confirms `updated_at` moved at or after this run's own sync
 * timestamp, but cannot confirm the value itself matches — write-blind on
 * that side.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const p = ctx.params;
  const syncStartedAtIso = ctx.outputs.syncStartedAtIso as string | undefined;
  const syncedVersionId = ctx.outputs.syncedVersionId as string | undefined;

  if (syncStartedAtIso && syncedVersionId) {
    const { rest } = githubClients(ctx);
    const metadata = await getSecretMetadata(rest, targetScope(p), p.TARGET_SECRET_NAME);
    if (!metadata) throw new Error(`GitHub secret "${p.TARGET_SECRET_NAME}" does not exist after sync`);
    if (metadata.updatedAt < syncStartedAtIso) {
      throw new Error(
        `GitHub secret "${p.TARGET_SECRET_NAME}" updated_at (${metadata.updatedAt}) is before this run's ` +
          `own sync timestamp (${syncStartedAtIso})`,
      );
    }

    const { secretsManager } = awsClients(ctx);
    const described = await describeSecret(secretsManager, p.SOURCE_SECRET_ID);
    if (lastSyncedVersionTag(described) !== syncedVersionId) {
      throw new Error(`Secrets Manager sync-version tag does not match the version synced this run`);
    }
  }

  ctx.log.success(
    `Confirmed sync-version tag on "${p.SOURCE_SECRET_ID}" and GitHub secret "${p.TARGET_SECRET_NAME}" presence ` +
      `— the GitHub-side value itself cannot be verified (write-blind API)`,
  );
}
