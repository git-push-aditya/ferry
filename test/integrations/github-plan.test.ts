import { describe, expect, test } from "bun:test";
import { githubRepoStep } from "../../src/providers/github";
import { collaboratorStep } from "../../integrations/github/add-remove-collaborator/steps/collaborator";
import type { Params as CollabParams } from "../../integrations/github/add-remove-collaborator/params";
import { branchProtectionStep } from "../../integrations/github/update-branch-protection/steps/branch-protection";
import type { Params as BranchProtectionParams } from "../../integrations/github/update-branch-protection/params";
import { secretStep } from "../../integrations/github/create-or-update-repo-secret/steps/secret";
import type { Params as RepoSecretParams } from "../../integrations/github/create-or-update-repo-secret/params";
import { orgSecretStep } from "../../integrations/github/create-or-update-org-secret/steps/org-secret";
import type { Params as OrgSecretParams } from "../../integrations/github/create-or-update-org-secret/params";
import { deployKeyStep } from "../../integrations/github/create-deploy-key/steps/deploy-key";
import type { Params as DeployKeyParams } from "../../integrations/github/create-deploy-key/params";
import { webhookStep } from "../../integrations/github/create-webhook/steps/webhook";
import type { Params as WebhookParams } from "../../integrations/github/create-webhook/params";
import { workflowStateStep } from "../../integrations/github/enable-disable-workflow/steps/workflow-state";
import type { Params as WorkflowParams } from "../../integrations/github/enable-disable-workflow/params";
import { dispatchStep } from "../../integrations/github/trigger-workflow-dispatch/steps/dispatch";
import type { Params as DispatchParams } from "../../integrations/github/trigger-workflow-dispatch/params";
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

describe("github dry-run plan: add-remove-collaborator", () => {
  const addParams: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "add", PERMISSION: "push" };
  const removeParams: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "remove" };

  test("missing repo -> conflict, regardless of collaborator state", async () => {
    const ctx = githubCtx(addParams, {}, () => ({ status: 404, data: {} }));
    expect(await collaboratorStep.check(ctx)).toBe("conflict");
  });

  test("add: not a collaborator (404) -> missing", async () => {
    const ctx = githubCtx(addParams, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 404, data: {} };
    });
    expect(await collaboratorStep.check(ctx)).toBe("missing");
  });

  test("add: already a collaborator (204) -> exists", async () => {
    const ctx = githubCtx(addParams, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 204, data: undefined };
    });
    expect(await collaboratorStep.check(ctx)).toBe("exists");
  });

  test("remove: not a collaborator (404) -> exists (already achieved)", async () => {
    const ctx = githubCtx(removeParams, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 404, data: {} };
    });
    expect(await collaboratorStep.check(ctx)).toBe("exists");
  });

  test("remove: currently a collaborator (204) -> missing (needs removing)", async () => {
    const ctx = githubCtx(removeParams, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 204, data: undefined };
    });
    expect(await collaboratorStep.check(ctx)).toBe("missing");
  });
});

describe("github dry-run plan: update-branch-protection", () => {
  const params: BranchProtectionParams = {
    OWNER: "o",
    REPO: "r",
    BRANCH: "main",
    ENABLE_REQUIRED_STATUS_CHECKS: false,
    REQUIRED_STATUS_CHECKS_STRICT: false,
    REQUIRED_STATUS_CHECKS_CONTEXTS: [],
    ENABLE_REQUIRED_PULL_REQUEST_REVIEWS: false,
    DISMISS_STALE_REVIEWS: false,
    REQUIRE_CODE_OWNER_REVIEWS: false,
    REQUIRED_APPROVING_REVIEW_COUNT: undefined,
    ENFORCE_ADMINS: false,
    ENABLE_RESTRICTIONS: false,
    RESTRICTIONS_USERS: [],
    RESTRICTIONS_TEAMS: [],
    RESTRICTIONS_APPS: [],
  };

  test("branch missing -> conflict (never auto-creates a branch)", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await branchProtectionStep.check(ctx)).toBe("conflict");
  });

  test("branch exists -> exists (diff/apply deferred to reconcile)", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: {} }));
    expect(await branchProtectionStep.check(ctx)).toBe("exists");
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

describe("github dry-run plan: create-deploy-key", () => {
  const params: DeployKeyParams = { OWNER: "o", REPO: "r", TITLE: "t", PUBLIC_KEY: "ssh-ed25519 AAAA", READ_ONLY: true };

  test("missing repo -> conflict", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await deployKeyStep.check(ctx)).toBe("conflict");
  });

  test("no matching key on this repo -> missing", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 200, data: [{ id: 1, key: "ssh-ed25519 DIFFERENT" }] };
    });
    expect(await deployKeyStep.check(ctx)).toBe("missing");
  });

  test("exact key content already registered on this repo -> exists", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 200, data: [{ id: 1, key: "ssh-ed25519 AAAA" }] };
    });
    expect(await deployKeyStep.check(ctx)).toBe("exists");
  });
});

describe("github dry-run plan: create-webhook", () => {
  const params: WebhookParams = {
    OWNER: "o",
    REPO: "r",
    URL: "https://example.com/hook",
    CONTENT_TYPE: "json",
    SECRET: undefined,
    EVENTS: ["push"],
    ACTIVE: true,
  };

  test("missing repo -> conflict", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 404, data: {} }));
    expect(await webhookStep.check(ctx)).toBe("conflict");
  });

  test("no hook with matching url+events -> missing", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 200, data: [] };
    });
    expect(await webhookStep.check(ctx)).toBe("missing");
  });

  test("hook with matching url + event set (order-insensitive) -> exists", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return {
        status: 200,
        data: [{ id: 1, active: true, events: ["push"], config: { url: "https://example.com/hook" } }],
      };
    });
    expect(await webhookStep.check(ctx)).toBe("exists");
  });

  test("a hook with the same url but a DIFFERENT event set is not treated as a match", async () => {
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return {
        status: 200,
        data: [{ id: 1, active: true, events: ["pull_request"], config: { url: "https://example.com/hook" } }],
      };
    });
    expect(await webhookStep.check(ctx)).toBe("missing");
  });
});

describe("github dry-run plan: enable-disable-workflow", () => {
  const enableParams: WorkflowParams = { OWNER: "o", REPO: "r", WORKFLOW_ID: "ci.yml", ACTION: "enable" };
  const disableParams: WorkflowParams = { ...enableParams, ACTION: "disable" };

  test("workflow not found -> conflict", async () => {
    const ctx = githubCtx(enableParams, {}, () => ({ status: 404, data: {} }));
    expect(await workflowStateStep.check(ctx)).toBe("conflict");
  });

  test("enable: already active -> exists", async () => {
    const ctx = githubCtx(enableParams, {}, () => ({ status: 200, data: { state: "active" } }));
    expect(await workflowStateStep.check(ctx)).toBe("exists");
  });

  test("enable: disabled_manually -> missing", async () => {
    const ctx = githubCtx(enableParams, {}, () => ({ status: 200, data: { state: "disabled_manually" } }));
    expect(await workflowStateStep.check(ctx)).toBe("missing");
  });

  test("disable: active -> missing", async () => {
    const ctx = githubCtx(disableParams, {}, () => ({ status: 200, data: { state: "active" } }));
    expect(await workflowStateStep.check(ctx)).toBe("missing");
  });

  test("disable: already disabled_manually -> exists", async () => {
    const ctx = githubCtx(disableParams, {}, () => ({ status: 200, data: { state: "disabled_manually" } }));
    expect(await workflowStateStep.check(ctx)).toBe("exists");
  });
});

describe("github dry-run plan: trigger-workflow-dispatch (read-only action-trigger)", () => {
  const params: DispatchParams = {
    OWNER: "o",
    REPO: "r",
    WORKFLOW_ID: "ci.yml",
    REF: "main",
    INPUTS_JSON: {},
    WAIT_FOR_COMPLETION: false,
    POLL_TIMEOUT_MS: 600_000,
    EXPECTED_CONCLUSION: "success",
  };

  test("check() always returns missing so create() re-dispatches every run", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: {} }));
    expect(await dispatchStep.check(ctx)).toBe("missing");
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
