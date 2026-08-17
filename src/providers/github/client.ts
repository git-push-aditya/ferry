import type { GithubCredentials } from "./credentials";
import { GithubApiError } from "./errors";

export const GITHUB_PROVIDER_ID = "github";
export const GITHUB_API_BASE = "https://api.github.com";

export interface GithubResponse<T> {
  status: number;
  data: T;
}

export interface GithubRequestOptions {
  body?: unknown;
  /** Statuses that do NOT throw. Defaults to the common success set. */
  okStatuses?: number[];
}

export interface GithubClient {
  readonly token: string;

  /**
   * Never throws on a non-2xx status — callers that need to distinguish e.g.
   * 404-vs-200 as two valid outcomes (GitHub's presence checks almost never
   * map to a single AWS-style "NotFound exception") use this directly.
   */
  raw<T = unknown>(method: string, path: string, body?: unknown): Promise<GithubResponse<T>>;

  /** Throws GithubApiError unless the response status is one of `okStatuses`. */
  request<T = unknown>(
    method: string,
    path: string,
    opts?: GithubRequestOptions,
  ): Promise<GithubResponse<T>>;
}

function makeGithubClient(env: GithubCredentials): GithubClient {
  const token = env.GITHUB_TOKEN;

  async function raw<T>(method: string, path: string, body?: unknown): Promise<GithubResponse<T>> {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown;
    if (!text) {
      data = undefined;
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data: data as T };
  }

  async function request<T>(
    method: string,
    path: string,
    opts: GithubRequestOptions = {},
  ): Promise<GithubResponse<T>> {
    const okStatuses = opts.okStatuses ?? [200, 201, 204];
    const response = await raw<T>(method, path, opts.body);
    if (!okStatuses.includes(response.status)) {
      throw new GithubApiError(method, path, response.status, response.data);
    }
    return response;
  }

  return { token, raw, request };
}

export interface GithubClients {
  rest: GithubClient;
}

export function makeGithubClients(env: GithubCredentials): GithubClients {
  return { rest: makeGithubClient(env) };
}

/** Typed accessor so steps don't cast `ctx.clients` themselves. */
export function githubClients(ctx: { clients: Record<string, unknown> }): GithubClients {
  const clients = ctx.clients[GITHUB_PROVIDER_ID] as GithubClients | undefined;
  if (!clients) {
    throw new Error(`This step needs GitHub clients — add "github" to the integration's credentials`);
  }
  return clients;
}

/**
 * `/user` works for a classic PAT and for a fine-grained PAT regardless of
 * its granted scopes (basic identity is always readable) — App installation
 * tokens are out of scope for this probe, per the provider module's own
 * PAT-only assumption.
 */
export async function resolveGithubIdentity(clients: GithubClients): Promise<{ description: string }> {
  const res = await clients.rest.request<{ login?: string }>("GET", "/user");
  return { description: `provisioning as GitHub user "${res.data.login ?? "(unknown)"}"` };
}
