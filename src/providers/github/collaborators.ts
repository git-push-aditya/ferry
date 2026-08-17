import type { GithubClient } from "./client";
import { GithubApiError } from "./errors";

export type CollaboratorState = "member" | "none";

/** `GET .../collaborators/{username}` — confirmed 204 = collaborator, 404 = not. */
export async function collaboratorState(
  client: GithubClient,
  owner: string,
  repo: string,
  username: string,
): Promise<CollaboratorState> {
  const path = `/repos/${owner}/${repo}/collaborators/${username}`;
  const res = await client.raw("GET", path);
  if (res.status === 204) return "member";
  if (res.status === 404) return "none";
  throw new GithubApiError("GET", path, res.status, res.data);
}

/**
 * The collaborator-by-username GET only ever returns 204/404 (no body) —
 * confirmed against the fetched docs. This separate endpoint is the only way
 * to read the permission level a collaborator currently holds, needed by
 * add-remove-collaborator's remove-then-rollback path to capture what to
 * restore.
 */
export async function getCollaboratorPermission(
  client: GithubClient,
  owner: string,
  repo: string,
  username: string,
): Promise<string | undefined> {
  const path = `/repos/${owner}/${repo}/collaborators/${username}/permission`;
  const res = await client.raw<{ permission?: string }>("GET", path);
  if (res.status === 404) return undefined;
  if (res.status !== 200) throw new GithubApiError("GET", path, res.status, res.data);
  return res.data.permission;
}

export interface PutCollaboratorResult {
  /** true = 201 (a new invitation was created), false = 204 (already had access — nothing status-wise changed). */
  invitationCreated: boolean;
}

/**
 * `PUT .../collaborators/{username}`. Per the fetched docs, a 204 also fires
 * when only the permission level changed on an existing collaborator — the
 * API gives no signal distinguishing a true no-op from a permission update,
 * so callers must not claim "nothing changed" on a 204.
 */
export async function putCollaborator(
  client: GithubClient,
  owner: string,
  repo: string,
  username: string,
  permission: string,
): Promise<PutCollaboratorResult> {
  const res = await client.request(
    "PUT",
    `/repos/${owner}/${repo}/collaborators/${username}`,
    { body: { permission }, okStatuses: [201, 204] },
  );
  return { invitationCreated: res.status === 201 };
}

export async function removeCollaborator(
  client: GithubClient,
  owner: string,
  repo: string,
  username: string,
): Promise<void> {
  await client.request("DELETE", `/repos/${owner}/${repo}/collaborators/${username}`, {
    okStatuses: [204, 404],
  });
}
