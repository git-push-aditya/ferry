import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type DescribeSecretCommandOutput,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * Promoted from github/sync-secrets-manager-to-github-secrets's local
 * secrets-manager-read.ts — that file's own comment named this exact
 * promotion trigger: "a second AWS+GitHub or AWS-only task needing the
 * same pattern." snowflake/secrets-manager-snowflake-keypair-sync is that
 * second consumer.
 */

export function isSecretNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "ResourceNotFoundException";
}

export function describeSecret(
  secretsManager: SecretsManagerClient,
  secretId: string,
): Promise<DescribeSecretCommandOutput> {
  return secretsManager.send(new DescribeSecretCommand({ SecretId: secretId }));
}

export async function secretExists(secretsManager: SecretsManagerClient, secretId: string): Promise<boolean> {
  try {
    await describeSecret(secretsManager, secretId);
    return true;
  } catch (err) {
    if (isSecretNotFound(err)) return false;
    throw err;
  }
}

/** The version currently labeled AWSCURRENT — Secrets Manager's own notion of "the live value". */
export function currentVersionId(described: DescribeSecretCommandOutput): string | undefined {
  for (const [versionId, stages] of Object.entries(described.VersionIdsToStages ?? {})) {
    if (stages?.includes("AWSCURRENT")) return versionId;
  }
  return undefined;
}

export function secretTag(described: DescribeSecretCommandOutput, key: string): string | undefined {
  return described.Tags?.find((t) => t.Key === key)?.Value;
}

/** Only ever called once check() has already established a read is needed — plaintext should never be read speculatively. */
export async function getSecretPlaintext(secretsManager: SecretsManagerClient, secretId: string): Promise<string> {
  const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (res.SecretString === undefined) {
    throw new Error(`Secret "${secretId}" has no SecretString value — binary secrets are not supported here`);
  }
  return res.SecretString;
}

/** Create-or-update: CreateSecret if it doesn't exist yet, PutSecretValue (a new version) if it does. */
export async function putSecretValue(
  secretsManager: SecretsManagerClient,
  secretId: string,
  plaintext: string,
): Promise<void> {
  if (await secretExists(secretsManager, secretId)) {
    await secretsManager.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: plaintext }));
    return;
  }
  await secretsManager.send(new CreateSecretCommand({ Name: secretId, SecretString: plaintext }));
}

export async function tagSecret(
  secretsManager: SecretsManagerClient,
  secretId: string,
  key: string,
  value: string,
): Promise<void> {
  await secretsManager.send(new TagResourceCommand({ SecretId: secretId, Tags: [{ Key: key, Value: value }] }));
}

export async function untagSecret(secretsManager: SecretsManagerClient, secretId: string, key: string): Promise<void> {
  await secretsManager.send(new UntagResourceCommand({ SecretId: secretId, TagKeys: [key] }));
}
