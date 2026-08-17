import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type DescribeSecretCommandOutput,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * AWS Secrets Manager read/tag isn't reused anywhere else in this project
 * yet, so it stays local per the project's "two bespoke copies are fine, a
 * third gets promoted" convention — a second AWS+GitHub or AWS-only task
 * needing the same pattern would be the trigger to promote this into
 * src/providers/aws/secretsmanager.ts.
 */
export const SYNC_TAG_KEY = "ferry:last-synced-version";

export function describeSecret(
  secretsManager: SecretsManagerClient,
  secretId: string,
): Promise<DescribeSecretCommandOutput> {
  return secretsManager.send(new DescribeSecretCommand({ SecretId: secretId }));
}

/** The version currently labeled AWSCURRENT — Secrets Manager's own notion of "the live value". */
export function currentVersionId(described: DescribeSecretCommandOutput): string | undefined {
  for (const [versionId, stages] of Object.entries(described.VersionIdsToStages ?? {})) {
    if (stages?.includes("AWSCURRENT")) return versionId;
  }
  return undefined;
}

export function lastSyncedVersionTag(described: DescribeSecretCommandOutput): string | undefined {
  return described.Tags?.find((t) => t.Key === SYNC_TAG_KEY)?.Value;
}

/** Only ever called once check() has already established the source changed — see steps/sync-secret.ts. */
export async function getSecretPlaintext(secretsManager: SecretsManagerClient, secretId: string): Promise<string> {
  const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (res.SecretString === undefined) {
    throw new Error(`Secret "${secretId}" has no SecretString value — binary secrets are not supported here`);
  }
  return res.SecretString;
}

/** The write that makes the next run's check() a clean skip. */
export async function tagLastSyncedVersion(
  secretsManager: SecretsManagerClient,
  secretId: string,
  versionId: string,
): Promise<void> {
  await secretsManager.send(
    new TagResourceCommand({ SecretId: secretId, Tags: [{ Key: SYNC_TAG_KEY, Value: versionId }] }),
  );
}

export async function untagLastSyncedVersion(secretsManager: SecretsManagerClient, secretId: string): Promise<void> {
  await secretsManager.send(new UntagResourceCommand({ SecretId: secretId, TagKeys: [SYNC_TAG_KEY] }));
}
