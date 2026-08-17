import type { GithubClient } from "./client";

export interface GithubWebhook {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string; insecure_ssl?: string };
}

export async function listWebhooks(client: GithubClient, owner: string, repo: string): Promise<GithubWebhook[]> {
  const res = await client.request<GithubWebhook[]>("GET", `/repos/${owner}/${repo}/hooks`);
  return res.data;
}

/**
 * URL is NOT a uniqueness key — confirmed: "multiple webhooks can share the
 * same config." Identity here is a best-effort proxy: exact `config.url` +
 * event-set equality. A second, unrelated webhook with an identical URL and
 * event list would false-positive as a match — a real, documented limitation
 * (see docs/plan/github.md task 8), not a solved problem.
 */
export function findWebhookByConfig(
  hooks: GithubWebhook[],
  url: string,
  events: string[],
): GithubWebhook | undefined {
  const desiredKey = [...events].sort().join(",");
  return hooks.find((h) => h.config.url === url && [...h.events].sort().join(",") === desiredKey);
}

export interface CreateWebhookOptions {
  url: string;
  contentType: "json" | "form";
  /** A shared HMAC secret — never logged. Write-blind, same as Actions secrets: GitHub never returns it. */
  secret?: string;
  events: string[];
  active: boolean;
}

export async function createWebhook(
  client: GithubClient,
  owner: string,
  repo: string,
  opts: CreateWebhookOptions,
): Promise<GithubWebhook> {
  const res = await client.request<GithubWebhook>("POST", `/repos/${owner}/${repo}/hooks`, {
    okStatuses: [201],
    body: {
      config: {
        url: opts.url,
        content_type: opts.contentType,
        secret: opts.secret,
        insecure_ssl: "0",
      },
      events: opts.events,
      active: opts.active,
    },
  });
  return res.data;
}

/** Triggers a synthetic ping event as a connectivity smoke test. A failed ping does not mean create() failed. */
export async function pingWebhook(client: GithubClient, owner: string, repo: string, hookId: number): Promise<boolean> {
  const res = await client.raw("POST", `/repos/${owner}/${repo}/hooks/${hookId}/pings`);
  return res.status === 204;
}

export async function getWebhook(
  client: GithubClient,
  owner: string,
  repo: string,
  hookId: number,
): Promise<GithubWebhook | undefined> {
  const res = await client.raw<GithubWebhook>("GET", `/repos/${owner}/${repo}/hooks/${hookId}`);
  if (res.status === 404) return undefined;
  return res.data;
}

export async function deleteWebhook(
  client: GithubClient,
  owner: string,
  repo: string,
  hookId: number,
): Promise<void> {
  await client.request("DELETE", `/repos/${owner}/${repo}/hooks/${hookId}`, { okStatuses: [204, 404] });
}
