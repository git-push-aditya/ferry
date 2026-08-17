import { describe, expect, test } from "bun:test";
import { GithubApiError, isGithubNotFound } from "../../src/providers/github/errors";

describe("GithubApiError", () => {
  test("message includes method, path, status and the body's message field", () => {
    const err = new GithubApiError("PUT", "/repos/o/r", 422, { message: "Validation failed" });
    expect(err.name).toBe("GithubApiError");
    expect(err.status).toBe(422);
    expect(err.method).toBe("PUT");
    expect(err.path).toBe("/repos/o/r");
    expect(err.message).toContain("PUT /repos/o/r");
    expect(err.message).toContain("422");
    expect(err.message).toContain("Validation failed");
  });

  test("falls back to a JSON dump when the body has no message field", () => {
    const err = new GithubApiError("GET", "/x", 500, { foo: "bar" });
    expect(err.message).toContain('{"foo":"bar"}');
  });

  test("isGithubNotFound is true only for a GithubApiError-shaped 404", () => {
    expect(isGithubNotFound(new GithubApiError("GET", "/x", 404, {}))).toBe(true);
    expect(isGithubNotFound(new GithubApiError("GET", "/x", 500, {}))).toBe(false);
    expect(isGithubNotFound(new Error("plain"))).toBe(false);
    expect(isGithubNotFound(undefined)).toBe(false);
  });
});
