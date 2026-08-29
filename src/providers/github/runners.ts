import type { GithubClient } from "./client";
import { GithubApiError } from "./errors";

/**
 * Self-hosted runners can be registered against a repo or an org. Both use
 * identical payloads under a different path prefix, the same shape as
 * `SecretScope` in secrets.ts.
 */
export type RunnerScope =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "org"; org: string };

function runnersBasePath(scope: RunnerScope): string {
  return scope.kind === "repo"
    ? `/repos/${scope.owner}/${scope.repo}/actions/runners`
    : `/orgs/${scope.org}/actions/runners`;
}

/** Human-readable target for logs and resource names. */
export function runnerScopeLabel(scope: RunnerScope): string {
  return scope.kind === "repo" ? `${scope.owner}/${scope.repo}` : scope.org;
}

export interface SelfHostedRunner {
  id: number;
  name: string;
  /** "online" | "offline" — GitHub's own vocabulary. */
  status: string;
  busy: boolean;
  labels: Array<{ id?: number; name: string; type?: string }>;
}

/** `GET .../actions/runners` — paginated; this walks every page. */
export async function listRunners(
  client: GithubClient,
  scope: RunnerScope,
): Promise<SelfHostedRunner[]> {
  const base = runnersBasePath(scope);
  const all: SelfHostedRunner[] = [];

  for (let page = 1; ; page++) {
    const res = await client.request<{ total_count: number; runners: SelfHostedRunner[] }>(
      "GET",
      `${base}?per_page=100&page=${page}`,
    );
    const batch = res.data.runners ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/** Runner names are not enforced-unique by GitHub, so this returns the first match. */
export async function findRunnerByName(
  client: GithubClient,
  scope: RunnerScope,
  name: string,
): Promise<SelfHostedRunner | undefined> {
  const runners = await listRunners(client, scope);
  return runners.find((r) => r.name === name);
}

/** `GET .../actions/runners/{id}` — undefined when the runner is gone. */
export async function getRunner(
  client: GithubClient,
  scope: RunnerScope,
  runnerId: number,
): Promise<SelfHostedRunner | undefined> {
  const path = `${runnersBasePath(scope)}/${runnerId}`;
  const res = await client.raw("GET", path);
  if (res.status === 404) return undefined;
  if (res.status === 200) return res.data as SelfHostedRunner;
  throw new GithubApiError("GET", path, res.status, res.data);
}

export interface JitConfigRequest {
  name: string;
  /** Runner group. 1 is "Default" on every account. */
  runnerGroupId: number;
  labels: string[];
  /** "none" opts the runner out of the default self-hosted/OS/arch labels. */
  workFolder?: string;
}

export interface JitConfig {
  /** Base64 blob passed to `run.sh --jitconfig`. Single-use and short-lived. */
  encodedJitConfig: string;
  runner: SelfHostedRunner;
}

/**
 * `POST .../actions/runners/generate-jitconfig`.
 *
 * **This call is mutating and single-use.** It registers the runner as a side
 * effect and returns a credential that cannot be reissued -- so it must never
 * be called from a `check()`, which the engine treats as a safe, repeatable
 * read. Call it from `create()` only, and capture `runner.id` immediately:
 * that id is the only handle you will ever have for deregistering it.
 *
 * Preferred over the legacy `registration-token` flow: no separate `config.sh`
 * step, and it is a single registration rather than a reusable token sitting
 * in plaintext instance metadata. The tradeoff is a tighter validity window
 * than the legacy token's hour -- see the integration README.
 */
export async function generateJitConfig(
  client: GithubClient,
  scope: RunnerScope,
  req: JitConfigRequest,
): Promise<JitConfig> {
  const res = await client.request<{ encoded_jit_config: string; runner: SelfHostedRunner }>(
    "POST",
    `${runnersBasePath(scope)}/generate-jitconfig`,
    {
      body: {
        name: req.name,
        runner_group_id: req.runnerGroupId,
        labels: req.labels,
        work_folder: req.workFolder ?? "_work",
      },
    },
  );
  return { encodedJitConfig: res.data.encoded_jit_config, runner: res.data.runner };
}

/** `DELETE .../actions/runners/{id}`. Idempotent enough: a 404 is success. */
export async function deleteRunner(
  client: GithubClient,
  scope: RunnerScope,
  runnerId: number,
): Promise<void> {
  const path = `${runnersBasePath(scope)}/${runnerId}`;
  const res = await client.raw("DELETE", path);
  if (res.status === 204 || res.status === 404) return;
  throw new GithubApiError("DELETE", path, res.status, res.data);
}
