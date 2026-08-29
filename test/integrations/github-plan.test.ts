import { describe, expect, test } from "bun:test";
import { environmentStep } from "../../integrations/github/create-environment/steps/environment";
import type { Params as EnvironmentParams } from "../../integrations/github/create-environment/params";
import { confirmDestructiveStep } from "../../integrations/github/delete-repo/steps/confirm-destructive";
import { deleteRepoStep } from "../../integrations/github/delete-repo/steps/delete-repo";
import type { Params as DeleteRepoParams } from "../../integrations/github/delete-repo/params";
import { githubCtx } from "../helpers/github-fake-client";

const REPO_OK = (status = 200) => (method: string, path: string) =>
  path === "/repos/o/r" ? { status, data: {} } : { status: 404, data: {} };

describe("github dry-run plan: delete-repo", () => {
  const params: DeleteRepoParams = { OWNER: "o", REPO: "r", ALLOW_DESTRUCTIVE_TEARDOWN: false };

  test("confirm-destructive: flag false -> conflict", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: {} }));
    expect(await confirmDestructiveStep.check(ctx)).toBe("conflict");
  });

  test("confirm-destructive: flag true -> exists", async () => {
    const ctx = githubCtx({ ...params, ALLOW_DESTRUCTIVE_TEARDOWN: true }, {}, () => ({ status: 200, data: {} }));
    expect(await confirmDestructiveStep.check(ctx)).toBe("exists");
  });

  test("delete-repo: repo present -> missing (still needs deleting)", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: {} }));
    expect(await deleteRepoStep.check(ctx)).toBe("missing");
  });

  test("delete-repo: repo already gone -> exists (target achieved)", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await deleteRepoStep.check(ctx)).toBe("exists");
  });
});

describe("github dry-run plan: create-environment", () => {
  const params: EnvironmentParams = {
    OWNER: "o",
    REPO: "r",
    ENVIRONMENT_NAME: "production",
    WAIT_TIMER: 0,
    REVIEWERS: [],
    ENABLE_DEPLOYMENT_BRANCH_POLICY: false,
    PROTECTED_BRANCHES: false,
    CUSTOM_BRANCH_POLICIES: false,
  };

  test("missing repo -> conflict", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await environmentStep.check(ctx)).toBe("conflict");
  });

  test("environment absent -> missing", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 404, data: {} };
    });
    expect(await environmentStep.check(ctx)).toBe("missing");
  });

  test("environment present -> exists (create-or-skip, no drift reconcile)", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 200, data: {} };
    });
    expect(await environmentStep.check(ctx)).toBe("exists");
  });
});

