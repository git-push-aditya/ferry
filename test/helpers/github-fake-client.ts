import type { StepContext } from "../../src/core/define";
import { GithubApiError } from "../../src/providers/github/errors";
import type { GithubClient, GithubRequestOptions, GithubResponse } from "../../src/providers/github/client";

export const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

export type FakeHandler = (
  method: string,
  path: string,
  body: unknown,
) => { status: number; data?: unknown } | Error;

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Drives a GithubClient from a handler function instead of real `fetch` — mirrors the AWS SDK fake-send pattern used throughout test/integrations. */
export function fakeGithubClient(handle: FakeHandler, calls: Call[] = []): GithubClient {
  async function raw<T>(method: string, path: string, body?: unknown): Promise<GithubResponse<T>> {
    calls.push({ method, path, body });
    const result = handle(method, path, body);
    if (result instanceof Error) throw result;
    return { status: result.status, data: result.data as T };
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

  return { token: "test-token", raw, request };
}

/** dry-run-shaped ctx: check() only, mirroring iamPlanCtx/iamCtx's own shape for the AWS provider's tests. */
export function githubCtx<P>(
  params: P,
  outputs: Record<string, unknown>,
  handle: FakeHandler,
  calls: Call[] = [],
): StepContext<P> {
  return {
    params,
    creds: {},
    clients: { github: { rest: fakeGithubClient(handle, calls) } },
    accountId: "",
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}
