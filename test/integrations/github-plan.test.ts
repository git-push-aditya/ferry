import { describe, expect, test } from "bun:test";
import { githubRepoStep } from "../../src/providers/github";
import { secretStep } from "../../integrations/github/create-or-update-repo-secret/steps/secret";
import type { Params as RepoSecretParams } from "../../integrations/github/create-or-update-repo-secret/params";
import { orgSecretStep } from "../../integrations/github/create-or-update-org-secret/steps/org-secret";
import type { Params as OrgSecretParams } from "../../integrations/github/create-or-update-org-secret/params";
import { environmentStep } from "../../integrations/github/create-environment/steps/environment";
import type { Params as EnvironmentParams } from "../../integrations/github/create-environment/params";
import { environmentSecretStep } from "../../integrations/github/add-environment-secret/steps/environment-secret";
import type { Params as EnvSecretParams } from "../../integrations/github/add-environment-secret/params";
import { confirmDestructiveStep } from "../../integrations/github/delete-repo/steps/confirm-destructive";
import { deleteRepoStep } from "../../integrations/github/delete-repo/steps/delete-repo";
import type { Params as DeleteRepoParams } from "../../integrations/github/delete-repo/params";
import { githubCtx } from "../helpers/github-fake-client";

const REPO_OK = (status = 200) => (method: string, path: string) =>
  path === "/repos/o/r" ? { status, data: {} } : { status: 404, data: {} };

describe("github dry-run plan: create-repo (githubRepoStep)", () => {
  const step = githubRepoStep<{ OWNER: string; REPO: string; OWNER_TYPE: "user" | "org"; ALLOW_DESTRUCTIVE_ROLLBACK: boolean }>({
    owner: (p) => p.OWNER,
    repo: (p) => p.REPO,
    ownerType: (p) => p.OWNER_TYPE,
    autoInit: () => true,
    allowDestructiveRollback: (p) => p.ALLOW_DESTRUCTIVE_ROLLBACK,
  });
  const params = { OWNER: "o", REPO: "r", OWNER_TYPE: "user" as const, ALLOW_DESTRUCTIVE_ROLLBACK: false };

  test("repo missing -> missing", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await step.check(ctx)).toBe("missing");
  });

  test("repo already exists -> exists", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: {} }));
    expect(await step.check(ctx)).toBe("exists");
  });
});

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

describe("github dry-run plan: create-or-update-repo-secret", () => {
  const params: RepoSecretParams = { OWNER: "o", REPO: "r", SECRET_NAME: "S", SECRET_VALUE: "v", FORCE_ROTATE: false };

  test("missing repo -> conflict", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await secretStep.check(ctx)).toBe("conflict");
  });

  test("secret absent -> missing", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 404, data: {} };
    });
    expect(await secretStep.check(ctx)).toBe("missing");
  });

  test("secret present -> exists (create-or-skip, not always-reconcile)", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 200, data: {} };
    });
    expect(await secretStep.check(ctx)).toBe("exists");
  });

  test("FORCE_ROTATE=true -> always missing, even if the secret is present", async () => {
    const ctx = githubCtx({ ...params, FORCE_ROTATE: true }, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 200, data: {} };
    });
    expect(await secretStep.check(ctx)).toBe("missing");
  });
});

describe("github dry-run plan: create-or-update-org-secret", () => {
  const params: OrgSecretParams = {
    ORG: "acme",
    SECRET_NAME: "S",
    SECRET_VALUE: "v",
    VISIBILITY: "private",
    SELECTED_REPOSITORY_IDS: [],
    FORCE_ROTATE: false,
  };

  test("secret absent -> missing", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await orgSecretStep.check(ctx)).toBe("missing");
  });

  test("secret present -> exists (routes to reconcile(), the visibility diff layer)", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: {} }));
    expect(await orgSecretStep.check(ctx)).toBe("exists");
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

describe("github dry-run plan: add-environment-secret", () => {
  const params: EnvSecretParams = {
    OWNER: "o",
    REPO: "r",
    ENVIRONMENT_NAME: "production",
    SECRET_NAME: "S",
    SECRET_VALUE: "v",
    FORCE_ROTATE: false,
  };

  test("missing environment -> conflict (never auto-creates one)", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await environmentSecretStep.check(ctx)).toBe("conflict");
  });

  test("environment exists, secret absent -> missing", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.includes("/environments/production") && !path.includes("secrets")) return { status: 200, data: {} };
      return { status: 404, data: {} };
    });
    expect(await environmentSecretStep.check(ctx)).toBe("missing");
  });
});
