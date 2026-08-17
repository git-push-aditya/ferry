/**
 * GitHub's REST API reports failures as an HTTP status plus a JSON body
 * (`{ message, documentation_url }`), not a typed exception hierarchy the way
 * the AWS SDK throws named exceptions. This wraps that shape so callers get
 * one error type to catch, mirroring src/providers/aws/errors.ts's role for
 * this provider.
 */
export class GithubApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`GitHub API ${method} ${path} failed with ${status}: ${describeBody(body)}`);
    this.name = "GithubApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object" && "message" in (body as Record<string, unknown>)) {
    return String((body as { message?: unknown }).message ?? "");
  }
  return body ? JSON.stringify(body) : "(no body)";
}

export function isGithubNotFound(err: unknown): boolean {
  return (err as { status?: number } | undefined)?.status === 404;
}

export function describeGithubError(err: unknown): string {
  if (err instanceof GithubApiError) {
    switch (err.status) {
      case 401:
        return "GitHub rejected the token — GITHUB_TOKEN is missing, expired, or revoked.";
      case 403:
        return "GitHub denied this call — the token lacks a required scope/permission, or a rate limit was hit.";
      case 404:
        return "GitHub returned 404 — the resource doesn't exist, or the token can't see it.";
      case 422:
        return `GitHub rejected the request as unprocessable: ${describeBody(err.body)}`;
      default:
        return `GitHub API error (HTTP ${err.status}): ${describeBody(err.body)}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
