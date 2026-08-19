import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  currentVersionId,
  describeSecret,
  getSecretPlaintext,
  secretTag,
  tagSecret,
  untagSecret,
} from "../../../../src/providers/aws";
import type { DescribeSecretCommandOutput } from "@aws-sdk/client-secrets-manager";

/**
 * Thin, task-specific wrappers around the shared src/providers/aws/
 * secretsmanager.ts primitives, fixed to this task's own tag key. Promoted
 * out of this file when snowflake/secrets-manager-snowflake-keypair-sync
 * became this pattern's second consumer — see that module's header comment.
 */
export const SYNC_TAG_KEY = "ferry:last-synced-version";

export { describeSecret, currentVersionId, getSecretPlaintext };

export function lastSyncedVersionTag(described: DescribeSecretCommandOutput): string | undefined {
  return secretTag(described, SYNC_TAG_KEY);
}

export async function tagLastSyncedVersion(
  secretsManager: SecretsManagerClient,
  secretId: string,
  versionId: string,
): Promise<void> {
  await tagSecret(secretsManager, secretId, SYNC_TAG_KEY, versionId);
}

export async function untagLastSyncedVersion(secretsManager: SecretsManagerClient, secretId: string): Promise<void> {
  await untagSecret(secretsManager, secretId, SYNC_TAG_KEY);
}
