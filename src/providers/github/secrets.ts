import sodium from "libsodium-wrappers";
import type { GithubClient } from "./client";
import { GithubApiError } from "./errors";

export type SecretScope =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "org"; org: string }
  | { kind: "environment"; owner: string; repo: string; environment: string };

function secretsBasePath(scope: SecretScope): string {
  switch (scope.kind) {
    case "repo":
      return `/repos/${scope.owner}/${scope.repo}/actions/secrets`;
    case "org":
      return `/orgs/${scope.org}/actions/secrets`;
    case "environment":
      return `/repos/${scope.owner}/${scope.repo}/environments/${scope.environment}/secrets`;
  }
}

export interface PublicKey {
  keyId: string;
  key: string;
}

/** `GET .../secrets/public-key` — confirmed to return `key_id` + `key` (base64), scoped identically at every level. */
export async function fetchPublicKey(client: GithubClient, scope: SecretScope): Promise<PublicKey> {
  const res = await client.request<{ key_id: string; key: string }>(
    "GET",
    `${secretsBasePath(scope)}/public-key`,
  );
  return { keyId: res.data.key_id, key: res.data.key };
}

let sodiumReady: Promise<typeof sodium> | undefined;
async function loadedSodium(): Promise<typeof sodium> {
  sodiumReady ??= sodium.ready.then(() => sodium);
  return sodiumReady;
}

/**
 * libsodium sealed-box encrypt + base64 — the only documented way to write a
 * GitHub Actions secret (there is no plaintext-write path). Matches GitHub's
 * own documented Node.js example byte-for-byte (from_base64/crypto_box_seal/
 * to_base64, all with the ORIGINAL base64 variant).
 */
export async function sealedBoxEncrypt(publicKeyBase64: string, plaintext: string): Promise<string> {
  const lib = await loadedSodium();
  const messageBytes = lib.from_string(plaintext);
  const keyBytes = lib.from_base64(publicKeyBase64, lib.base64_variants.ORIGINAL);
  const encryptedBytes = lib.crypto_box_seal(messageBytes, keyBytes);
  return lib.to_base64(encryptedBytes, lib.base64_variants.ORIGINAL);
}

/** `GET .../secrets/{name}` returns metadata only (created_at/updated_at) — confirmed, never the value. */
export async function secretExists(client: GithubClient, scope: SecretScope, name: string): Promise<boolean> {
  const path = `${secretsBasePath(scope)}/${name}`;
  const res = await client.raw("GET", path);
  if (res.status === 404) return false;
  if (res.status === 200) return true;
  throw new GithubApiError("GET", path, res.status, res.data);
}

export interface SecretMetadata {
  createdAt: string;
  updatedAt: string;
}

/** Same write-blind GET as secretExists, surfacing the timestamps instead of a bare boolean. */
export async function getSecretMetadata(
  client: GithubClient,
  scope: SecretScope,
  name: string,
): Promise<SecretMetadata | undefined> {
  const path = `${secretsBasePath(scope)}/${name}`;
  const res = await client.raw<{ created_at?: string; updated_at?: string }>("GET", path);
  if (res.status === 404) return undefined;
  if (res.status !== 200) throw new GithubApiError("GET", path, res.status, res.data);
  return { createdAt: res.data.created_at ?? "", updatedAt: res.data.updated_at ?? "" };
}

export interface OrgSecretVisibilityInput {
  visibility: "all" | "private" | "selected";
  selectedRepositoryIds?: number[];
}

export interface PutSecretResult {
  /** true = 201 (new secret), false = 204 (an existing secret was overwritten). */
  created: boolean;
}

/**
 * `PUT .../secrets/{name}` with `{ encrypted_value, key_id }`. For org scope,
 * `visibility` (and `selected_repository_ids` when "selected") are additional
 * body fields on this SAME call — GitHub has no way to change an org secret's
 * visibility without resupplying the encrypted value in the same request.
 */
export async function putSecret(
  client: GithubClient,
  scope: SecretScope,
  name: string,
  encryptedValue: string,
  keyId: string,
  orgVisibility?: OrgSecretVisibilityInput,
): Promise<PutSecretResult> {
  const body: Record<string, unknown> = { encrypted_value: encryptedValue, key_id: keyId };
  if (scope.kind === "org" && orgVisibility) {
    body.visibility = orgVisibility.visibility;
    if (orgVisibility.visibility === "selected") {
      body.selected_repository_ids = orgVisibility.selectedRepositoryIds ?? [];
    }
  }
  const res = await client.request(
    "PUT",
    `${secretsBasePath(scope)}/${name}`,
    { body, okStatuses: [201, 204] },
  );
  return { created: res.status === 201 };
}

export async function deleteSecret(client: GithubClient, scope: SecretScope, name: string): Promise<void> {
  await client.request("DELETE", `${secretsBasePath(scope)}/${name}`, { okStatuses: [204, 404] });
}

/** End-to-end fetch-key + encrypt + write, shared by every secret-writing task. */
export async function encryptAndPutSecret(
  client: GithubClient,
  scope: SecretScope,
  name: string,
  plaintext: string,
  orgVisibility?: OrgSecretVisibilityInput,
): Promise<PutSecretResult> {
  const publicKey = await fetchPublicKey(client, scope);
  const encryptedValue = await sealedBoxEncrypt(publicKey.key, plaintext);
  return putSecret(client, scope, name, encryptedValue, publicKey.keyId, orgVisibility);
}

export interface OrgSecretVisibilityState {
  visibility: "all" | "private" | "selected";
  selectedRepositoryIds?: number[];
}

/**
 * Unlike the secret's value, visibility/selection genuinely IS readable —
 * `GET .../secrets/{name}` returns `visibility` inline, and the selected-repo
 * list has its own read endpoint. This is the one sub-piece of an org secret
 * this provider can honestly diff.
 */
export async function getOrgSecretVisibility(
  client: GithubClient,
  org: string,
  name: string,
): Promise<OrgSecretVisibilityState | undefined> {
  const path = `/orgs/${org}/actions/secrets/${name}`;
  const res = await client.raw<{ visibility?: "all" | "private" | "selected" }>("GET", path);
  if (res.status === 404) return undefined;
  if (res.status !== 200) throw new GithubApiError("GET", path, res.status, res.data);

  const visibility = res.data.visibility ?? "private";
  if (visibility !== "selected") return { visibility };

  const selRes = await client.request<{ repositories: { id: number }[] }>(
    "GET",
    `/orgs/${org}/actions/secrets/${name}/repositories`,
  );
  return { visibility, selectedRepositoryIds: selRes.data.repositories.map((r) => r.id) };
}

/**
 * Replaces the selected-repo list WITHOUT touching the secret's value — the
 * one part of an org secret's config that's reconcilable on its own, used by
 * the always-reconcile layer when only the repo list (not the visibility
 * enum itself) has drifted.
 */
export async function setOrgSecretSelectedRepositories(
  client: GithubClient,
  org: string,
  name: string,
  repositoryIds: number[],
): Promise<void> {
  await client.request("PUT", `/orgs/${org}/actions/secrets/${name}/repositories`, {
    body: { selected_repository_ids: repositoryIds },
    okStatuses: [204],
  });
}
