import type { GithubClient } from "./client";
import { GithubApiError } from "./errors";

export interface RequiredStatusChecks {
  strict: boolean;
  contexts?: string[];
  checks?: { context: string; app_id?: number }[];
}

export interface RequiredPullRequestReviews {
  dismiss_stale_reviews?: boolean;
  require_code_owner_reviews?: boolean;
  required_approving_review_count?: number;
}

export interface Restrictions {
  users?: string[];
  teams?: string[];
  apps?: string[];
}

/** The desired document, as PUT expects it — `enforce_admins` is a bare boolean here. */
export interface DesiredBranchProtection {
  required_status_checks: RequiredStatusChecks | null;
  required_pull_request_reviews: RequiredPullRequestReviews | null;
  enforce_admins: boolean | null;
  restrictions: Restrictions | null;
}

/**
 * The live document, as GET returns it — `enforce_admins` comes back as
 * `{ enabled: boolean }`, a real, documented asymmetry between this
 * endpoint's read and write shapes (PUT takes a bare boolean, GET wraps it).
 * Everything else round-trips in the same shape both ways.
 */
export interface LiveBranchProtection {
  required_status_checks?: RequiredStatusChecks | null;
  required_pull_request_reviews?: RequiredPullRequestReviews | null;
  enforce_admins?: { enabled: boolean } | null;
  restrictions?: Restrictions | null;
}

export async function branchExists(client: GithubClient, owner: string, repo: string, branch: string): Promise<boolean> {
  const path = `/repos/${owner}/${repo}/branches/${branch}`;
  const res = await client.raw("GET", path);
  if (res.status === 404) return false;
  if (res.status === 200) return true;
  throw new GithubApiError("GET", path, res.status, res.data);
}

/** 404 when no protection is configured, 200 with the current ruleset otherwise — confirmed. */
export async function getBranchProtection(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<LiveBranchProtection | undefined> {
  const path = `/repos/${owner}/${repo}/branches/${branch}/protection`;
  const res = await client.raw<LiveBranchProtection>("GET", path);
  if (res.status === 404) return undefined;
  if (res.status !== 200) throw new GithubApiError("GET", path, res.status, res.data);
  return res.data;
}

/** Whole-document PUT — confirmed a genuine full-replace API, with each sub-requirement nullable to disable it. */
export async function putBranchProtection(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
  doc: DesiredBranchProtection,
): Promise<void> {
  await client.request("PUT", `/repos/${owner}/${repo}/branches/${branch}/protection`, {
    body: doc,
    okStatuses: [200],
  });
}

/** Confirmed: fully removes protection, 204. */
export async function deleteBranchProtection(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  await client.request("DELETE", `/repos/${owner}/${repo}/branches/${branch}/protection`, {
    okStatuses: [204, 404],
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * True when a live document (GET shape) matches a desired document (PUT
 * shape) field-for-field, normalizing the one shape asymmetry
 * (`enforce_admins`) before comparing.
 */
export function branchProtectionMatches(live: LiveBranchProtection, desired: DesiredBranchProtection): boolean {
  const liveEnforceAdmins = live.enforce_admins?.enabled ?? false;
  const desiredEnforceAdmins = desired.enforce_admins ?? false;
  if (liveEnforceAdmins !== desiredEnforceAdmins) return false;

  return (
    stableStringify(live.required_status_checks ?? null) === stableStringify(desired.required_status_checks) &&
    stableStringify(live.required_pull_request_reviews ?? null) ===
      stableStringify(desired.required_pull_request_reviews) &&
    stableStringify(live.restrictions ?? null) === stableStringify(desired.restrictions)
  );
}
