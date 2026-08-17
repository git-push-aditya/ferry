import { beforeAll, describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
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
import { deleteRepoStep } from "../../integrations/github/delete-repo/steps/delete-repo";
import { githubCtx, type Call } from "../helpers/github-fake-client";

let PUBLIC_KEY_B64: string;

beforeAll(async () => {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  PUBLIC_KEY_B64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
});

// ---------------------------------------------------------------------------
// create-repo (githubRepoStep)
// ---------------------------------------------------------------------------

describe("create-repo (githubRepoStep)", () => {
  function makeStep(allowDestructiveRollback = false) {
    return githubRepoStep<{ OWNER: string; REPO: string; OWNER_TYPE: "user" | "org" }>({
      owner: (p) => p.OWNER,
      repo: (p) => p.REPO,
      ownerType: (p) => p.OWNER_TYPE,
      autoInit: () => true,
      allowDestructiveRollback: () => allowDestructiveRollback,
    });
  }

  test("create() posts to /user/repos for a personal account", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(
      { OWNER: "o", REPO: "r", OWNER_TYPE: "user" as const },
      {},
      () => ({ status: 201, data: { html_url: "https://github.com/o/r" } }),
      calls,
    );
    const outputs = await makeStep().create!(ctx);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/user/repos" });
    expect((calls[0]!.body as { name: string }).name).toBe("r");
    expect(outputs).toEqual({ githubRepoCreatedThisRun: true, githubRepoHtmlUrl: "https://github.com/o/r" });
  });

  test("create() posts to /orgs/{owner}/repos for an org account", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx({ OWNER: "acme", REPO: "r", OWNER_TYPE: "org" as const }, {}, () => ({
      status: 201,
      data: { html_url: "https://github.com/acme/r" },
    }), calls);
    await makeStep().create!(ctx);
    expect(calls[0]!.path).toBe("/orgs/acme/repos");
  });

  test("rollback does NOT delete without ALLOW_DESTRUCTIVE_ROLLBACK", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx({ OWNER: "o", REPO: "r", OWNER_TYPE: "user" as const }, {}, () => ({ status: 204, data: {} }), calls);
    await makeStep(false).rollback(ctx);
    expect(calls).toHaveLength(0);
  });

  test("rollback deletes when ALLOW_DESTRUCTIVE_ROLLBACK=true", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx({ OWNER: "o", REPO: "r", OWNER_TYPE: "user" as const }, {}, () => ({ status: 204, data: {} }), calls);
    await makeStep(true).rollback(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r", body: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// delete-repo
// ---------------------------------------------------------------------------

describe("delete-repo", () => {
  const params = { OWNER: "o", REPO: "r", ALLOW_DESTRUCTIVE_TEARDOWN: true };

  test("create() deletes the repo", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, () => ({ status: 204, data: {} }), calls);
    const outputs = await deleteRepoStep.create!(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r", body: undefined }]);
    expect(outputs).toEqual({ repoDeletedThisRun: true });
  });

  test("rollback never re-creates — logs only, no API calls", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { repoDeletedThisRun: true }, () => ({ status: 200, data: {} }), calls);
    await deleteRepoStep.rollback(ctx);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// add-remove-collaborator
// ---------------------------------------------------------------------------

describe("add-remove-collaborator", () => {
  test("create() add: 201 -> invitationCreated true", async () => {
    const params: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "add", PERMISSION: "push" };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, () => ({ status: 201, data: {} }), calls);
    const outputs = await collaboratorStep.create!(ctx);
    expect(outputs).toEqual({ collaboratorAddedThisRun: true, collaboratorInvitationCreated: true });
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/repos/o/r/collaborators/bob",
      body: { permission: "push" },
    });
  });

  test("create() add: 204 -> invitationCreated false (ambiguous 'already had access' case)", async () => {
    const params: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "add", PERMISSION: "push" };
    const ctx = githubCtx(params, {}, () => ({ status: 204, data: {} }));
    const outputs = await collaboratorStep.create!(ctx);
    expect(outputs).toEqual({ collaboratorAddedThisRun: true, collaboratorInvitationCreated: false });
  });

  test("create() remove: reads permission before removing, captures it for rollback", async () => {
    const params: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "remove" };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.endsWith("/permission")) return { status: 200, data: { permission: "push" } };
      return { status: 204, data: {} };
    }, calls);
    const outputs = await collaboratorStep.create!(ctx);
    expect(outputs).toEqual({ collaboratorRemovedThisRun: true, collaboratorPriorPermission: "push" });
    expect(calls[0]!.path).toBe("/repos/o/r/collaborators/bob/permission");
    expect(calls[1]).toEqual({ method: "DELETE", path: "/repos/o/r/collaborators/bob", body: undefined });
  });

  test("rollback add: DELETEs the collaborator this run added", async () => {
    const params: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "add", PERMISSION: "push" };
    const calls: Call[] = [];
    const ctx = githubCtx(params, { collaboratorAddedThisRun: true, collaboratorInvitationCreated: true }, () => ({
      status: 204,
      data: {},
    }), calls);
    await collaboratorStep.rollback(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r/collaborators/bob", body: undefined }]);
  });

  test("rollback remove: re-PUTs at the captured prior permission", async () => {
    const params: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "remove" };
    const calls: Call[] = [];
    const ctx = githubCtx(
      params,
      { collaboratorRemovedThisRun: true, collaboratorPriorPermission: "admin" },
      () => ({ status: 204, data: {} }),
      calls,
    );
    await collaboratorStep.rollback(ctx);
    expect(calls).toEqual([
      { method: "PUT", path: "/repos/o/r/collaborators/bob", body: { permission: "admin" } },
    ]);
  });

  test("rollback remove: no-op if no prior permission was captured", async () => {
    const params: CollabParams = { OWNER: "o", REPO: "r", USERNAME: "bob", ACTION: "remove" };
    const calls: Call[] = [];
    const ctx = githubCtx(params, { collaboratorRemovedThisRun: true, collaboratorPriorPermission: "" }, () => ({
      status: 204,
      data: {},
    }), calls);
    await collaboratorStep.rollback(ctx);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// update-branch-protection
// ---------------------------------------------------------------------------

describe("update-branch-protection", () => {
  const BASE: BranchProtectionParams = {
    OWNER: "o",
    REPO: "r",
    BRANCH: "main",
    ENABLE_REQUIRED_STATUS_CHECKS: true,
    REQUIRED_STATUS_CHECKS_STRICT: true,
    REQUIRED_STATUS_CHECKS_CONTEXTS: ["ci"],
    ENABLE_REQUIRED_PULL_REQUEST_REVIEWS: false,
    DISMISS_STALE_REVIEWS: false,
    REQUIRE_CODE_OWNER_REVIEWS: false,
    REQUIRED_APPROVING_REVIEW_COUNT: undefined,
    ENFORCE_ADMINS: true,
    ENABLE_RESTRICTIONS: false,
    RESTRICTIONS_USERS: [],
    RESTRICTIONS_TEAMS: [],
    RESTRICTIONS_APPS: [],
  };

  test("reconcile() PUTs the full document and captures the prior one when it differs", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(BASE, {}, (method) => {
      if (method === "GET") {
        return { status: 200, data: { enforce_admins: { enabled: false }, required_status_checks: null } };
      }
      return { status: 200, data: {} };
    }, calls);
    const outputs = await branchProtectionStep.reconcile!(ctx);
    expect(outputs.branchProtectionChanged).toBe(true);
    expect(outputs.branchProtectionHadPrior).toBe(true);
    expect(calls[1]).toMatchObject({ method: "PUT" });
    expect((calls[1]!.body as { enforce_admins: boolean }).enforce_admins).toBe(true);
  });

  test("reconcile() is a no-op when the live document already matches", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(BASE, {}, () => ({
      status: 200,
      data: {
        required_status_checks: { strict: true, contexts: ["ci"] },
        required_pull_request_reviews: null,
        enforce_admins: { enabled: true },
        restrictions: null,
      },
    }), calls);
    await branchProtectionStep.reconcile!(ctx);
    expect(calls).toHaveLength(1); // GET only, no PUT
  });

  test("rollback DELETEs protection when there was no prior document", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(BASE, { branchProtectionChanged: true, branchProtectionHadPrior: false }, () => ({
      status: 204,
      data: {},
    }), calls);
    await branchProtectionStep.rollback(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r/branches/main/protection", body: undefined }]);
  });

  test("rollback PUTs the prior document back verbatim when one existed", async () => {
    const prior = { enforce_admins: { enabled: false }, required_status_checks: null };
    const calls: Call[] = [];
    const ctx = githubCtx(
      BASE,
      { branchProtectionChanged: true, branchProtectionHadPrior: true, branchProtectionPriorDocumentJson: JSON.stringify(prior) },
      () => ({ status: 200, data: {} }),
      calls,
    );
    await branchProtectionStep.rollback(ctx);
    expect(calls[0]!.method).toBe("PUT");
    expect((calls[0]!.body as { enforce_admins: boolean | null }).enforce_admins).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// create-or-update-repo-secret
// ---------------------------------------------------------------------------

describe("create-or-update-repo-secret", () => {
  const params: RepoSecretParams = { OWNER: "o", REPO: "r", SECRET_NAME: "S", SECRET_VALUE: "v", FORCE_ROTATE: false };

  test("create(): fetches the public key, encrypts, and PUTs — 201 marks it created-this-run", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.endsWith("/public-key")) return { status: 200, data: { key_id: "k1", key: PUBLIC_KEY_B64 } };
      return { status: 201, data: {} };
    }, calls);
    const outputs = await secretStep.create!(ctx);
    expect(outputs).toEqual({ githubSecretCreatedThisRun: true });
    expect(calls[1]!.method).toBe("PUT");
    expect((calls[1]!.body as { key_id: string }).key_id).toBe("k1");
  });

  test("rollback deletes a secret this run created (201)", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { githubSecretCreatedThisRun: true }, () => ({ status: 204, data: {} }), calls);
    await secretStep.rollback(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r/actions/secrets/S", body: undefined }]);
  });

  test("rollback leaves an overwritten secret (204) in place, no API call", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { githubSecretCreatedThisRun: false }, () => ({ status: 204, data: {} }), calls);
    await secretStep.rollback(ctx);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// create-or-update-org-secret
// ---------------------------------------------------------------------------

describe("create-or-update-org-secret", () => {
  test("create(): writes the value with visibility/selected ids in the same PUT", async () => {
    const params: OrgSecretParams = {
      ORG: "acme",
      SECRET_NAME: "S",
      SECRET_VALUE: "v",
      VISIBILITY: "selected",
      SELECTED_REPOSITORY_IDS: [1, 2],
      FORCE_ROTATE: false,
    };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.endsWith("/public-key")) return { status: 200, data: { key_id: "k1", key: PUBLIC_KEY_B64 } };
      return { status: 201, data: {} };
    }, calls);
    await orgSecretStep.create!(ctx);
    const body = calls[1]!.body as { visibility: string; selected_repository_ids: number[] };
    expect(body.visibility).toBe("selected");
    expect(body.selected_repository_ids).toEqual([1, 2]);
  });

  test("reconcile(): visibility unchanged, selected-ids differ -> uses the lighter repositories-only endpoint, no value rewrite", async () => {
    const params: OrgSecretParams = {
      ORG: "acme",
      SECRET_NAME: "S",
      SECRET_VALUE: "v",
      VISIBILITY: "selected",
      SELECTED_REPOSITORY_IDS: [3],
      FORCE_ROTATE: false,
    };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.endsWith("/repositories") && method === "GET") return { status: 200, data: { repositories: [{ id: 1 }] } };
      if (path.endsWith("/repositories") && method === "PUT") return { status: 204, data: {} };
      return { status: 200, data: { visibility: "selected" } };
    }, calls);
    const outputs = await orgSecretStep.reconcile!(ctx);
    expect(outputs.orgSecretSelectedIdsChanged).toBe(true);
    expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/public-key"))).toBe(false);
    const putRepos = calls.find((c) => c.method === "PUT" && c.path.endsWith("/repositories"));
    expect(putRepos!.body).toEqual({ selected_repository_ids: [3] });
  });

  test("reconcile(): visibility enum change re-encrypts the value (only place a full rewrite is required)", async () => {
    const params: OrgSecretParams = {
      ORG: "acme",
      SECRET_NAME: "S",
      SECRET_VALUE: "v",
      VISIBILITY: "all",
      SELECTED_REPOSITORY_IDS: [],
      FORCE_ROTATE: false,
    };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.endsWith("/public-key")) return { status: 200, data: { key_id: "k1", key: PUBLIC_KEY_B64 } };
      if (path.endsWith("/actions/secrets/S") && method === "GET") return { status: 200, data: { visibility: "private" } };
      return { status: 204, data: {} };
    }, calls);
    const outputs = await orgSecretStep.reconcile!(ctx);
    expect(outputs.orgSecretVisibilityChanged).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/public-key"))).toBe(true);
  });

  test("reconcile(): nothing changed -> no writes at all", async () => {
    const params: OrgSecretParams = {
      ORG: "acme",
      SECRET_NAME: "S",
      SECRET_VALUE: "v",
      VISIBILITY: "all",
      SELECTED_REPOSITORY_IDS: [],
      FORCE_ROTATE: false,
    };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: { visibility: "all" } }), calls);
    const outputs = await orgSecretStep.reconcile!(ctx);
    expect(outputs).toEqual({});
    expect(calls).toHaveLength(1); // the visibility GET only
  });
});

// ---------------------------------------------------------------------------
// create-deploy-key
// ---------------------------------------------------------------------------

describe("create-deploy-key", () => {
  const params: DeployKeyParams = { OWNER: "o", REPO: "r", TITLE: "t", PUBLIC_KEY: "ssh-ed25519 AAAA", READ_ONLY: true };

  test("create() registers the key and captures its id", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, () => ({ status: 201, data: { id: 42, key: "ssh-ed25519 AAAA" } }), calls);
    const outputs = await deployKeyStep.create!(ctx);
    expect(outputs).toEqual({ deployKeyId: 42, deployKeyCreatedThisRun: true });
  });

  test("create() surfaces a platform-wide duplicate-key 422 as a clear error", async () => {
    const ctx = githubCtx(params, {}, () => ({ status: 422, data: { message: "key is already in use" } }));
    await expect(deployKeyStep.create!(ctx)).rejects.toThrow(/already in use/);
  });

  test("rollback deletes the captured key id", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { deployKeyId: 42 }, () => ({ status: 204, data: {} }), calls);
    await deployKeyStep.rollback(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r/keys/42", body: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// create-webhook
// ---------------------------------------------------------------------------

describe("create-webhook", () => {
  const params: WebhookParams = {
    OWNER: "o",
    REPO: "r",
    URL: "https://example.com/hook",
    CONTENT_TYPE: "json",
    SECRET: "shh",
    EVENTS: ["push"],
    ACTIVE: true,
  };

  test("create() creates the hook then pings it — a failed ping does not fail create()", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (method === "POST" && path.endsWith("/hooks")) return { status: 201, data: { id: 7 } };
      if (path.endsWith("/pings")) return { status: 500, data: {} }; // ping fails
      return { status: 200, data: {} };
    }, calls);
    const outputs = await webhookStep.create!(ctx);
    expect(outputs).toEqual({ webhookId: 7, webhookCreatedThisRun: true });
  });

  test("rollback deletes the captured hook id", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { webhookId: 7 }, () => ({ status: 204, data: {} }), calls);
    await webhookStep.rollback(ctx);
    expect(calls).toEqual([{ method: "DELETE", path: "/repos/o/r/hooks/7", body: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// enable-disable-workflow
// ---------------------------------------------------------------------------

describe("enable-disable-workflow", () => {
  test("create() PUTs the enable endpoint", async () => {
    const params: WorkflowParams = { OWNER: "o", REPO: "r", WORKFLOW_ID: "ci.yml", ACTION: "enable" };
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, () => ({ status: 204, data: {} }), calls);
    const outputs = await workflowStateStep.create!(ctx);
    expect(calls).toEqual([
      { method: "PUT", path: "/repos/o/r/actions/workflows/ci.yml/enable", body: undefined },
    ]);
    expect(outputs).toEqual({ workflowToggledThisRun: true });
  });

  test("rollback reverses the toggle", async () => {
    const params: WorkflowParams = { OWNER: "o", REPO: "r", WORKFLOW_ID: "ci.yml", ACTION: "enable" };
    const calls: Call[] = [];
    const ctx = githubCtx(params, { workflowToggledThisRun: true }, () => ({ status: 204, data: {} }), calls);
    await workflowStateStep.rollback(ctx);
    expect(calls).toEqual([
      { method: "PUT", path: "/repos/o/r/actions/workflows/ci.yml/disable", body: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------
// trigger-workflow-dispatch
// ---------------------------------------------------------------------------

describe("trigger-workflow-dispatch", () => {
  test("create() dispatches and correlates the newest matching run", async () => {
    const params: DispatchParams = {
      OWNER: "o",
      REPO: "r",
      WORKFLOW_ID: "ci.yml",
      REF: "main",
      INPUTS_JSON: {},
      WAIT_FOR_COMPLETION: false,
      POLL_TIMEOUT_MS: 5_000,
      EXPECTED_CONCLUSION: "success",
    };
    const now = new Date().toISOString();
    const ctx = githubCtx(params, {}, (method, path) => {
      if (method === "POST" && path.endsWith("/dispatches")) return { status: 204, data: {} };
      if (path.includes("/runs?")) return { status: 200, data: { workflow_runs: [{ id: 99, status: "queued", conclusion: null, created_at: now }] } };
      return { status: 200, data: {} };
    });
    const outputs = await dispatchStep.create!(ctx);
    expect(outputs.workflowDispatchedThisRun).toBe(true);
    expect(outputs.correlatedRunId).toBe(99);
  });

  test("create() with WAIT_FOR_COMPLETION throws when the run concludes with an unexpected result", async () => {
    const params: DispatchParams = {
      OWNER: "o",
      REPO: "r",
      WORKFLOW_ID: "ci.yml",
      REF: "main",
      INPUTS_JSON: {},
      WAIT_FOR_COMPLETION: true,
      POLL_TIMEOUT_MS: 5_000,
      EXPECTED_CONCLUSION: "success",
    };
    const now = new Date().toISOString();
    const ctx = githubCtx(params, {}, (method, path) => {
      if (method === "POST" && path.endsWith("/dispatches")) return { status: 204, data: {} };
      if (path.includes("/runs?")) return { status: 200, data: { workflow_runs: [{ id: 99, status: "queued", conclusion: null, created_at: now }] } };
      if (path === "/repos/o/r/actions/runs/99") return { status: 200, data: { status: "completed", conclusion: "failure" } };
      return { status: 200, data: {} };
    });
    await expect(dispatchStep.create!(ctx)).rejects.toThrow(/concluded "failure"/);
  });

  test("rollback cancels an in-flight correlated run", async () => {
    const params: DispatchParams = {
      OWNER: "o",
      REPO: "r",
      WORKFLOW_ID: "ci.yml",
      REF: "main",
      INPUTS_JSON: {},
      WAIT_FOR_COMPLETION: true,
      POLL_TIMEOUT_MS: 5_000,
      EXPECTED_CONCLUSION: "success",
    };
    const calls: Call[] = [];
    const ctx = githubCtx(params, { correlatedRunId: 99 }, () => ({ status: 202, data: {} }), calls);
    await dispatchStep.rollback(ctx);
    expect(calls).toEqual([{ method: "POST", path: "/repos/o/r/actions/runs/99/cancel", body: undefined }]);
  });

  test("rollback is a no-op when no run was correlated", async () => {
    const params: DispatchParams = {
      OWNER: "o",
      REPO: "r",
      WORKFLOW_ID: "ci.yml",
      REF: "main",
      INPUTS_JSON: {},
      WAIT_FOR_COMPLETION: false,
      POLL_TIMEOUT_MS: 5_000,
      EXPECTED_CONCLUSION: "success",
    };
    const calls: Call[] = [];
    const ctx = githubCtx(params, { correlatedRunId: null }, () => ({ status: 200, data: {} }), calls);
    await dispatchStep.rollback(ctx);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// create-environment
// ---------------------------------------------------------------------------

describe("create-environment", () => {
  const params: EnvironmentParams = {
    OWNER: "o",
    REPO: "r",
    ENVIRONMENT_NAME: "production",
    WAIT_TIMER: 5,
    REVIEWERS: [{ type: "User", id: 1 }],
    ENABLE_DEPLOYMENT_BRANCH_POLICY: false,
    PROTECTED_BRANCHES: false,
    CUSTOM_BRANCH_POLICIES: false,
  };

  test("create() PUTs the environment with wait_timer/reviewers/deployment_branch_policy", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, () => ({ status: 200, data: { id: 5 } }), calls);
    const outputs = await environmentStep.create!(ctx);
    expect(outputs).toEqual({ environmentId: 5, environmentCreatedThisRun: true });
    const body = calls[0]!.body as { wait_timer: number; reviewers: unknown[]; deployment_branch_policy: unknown };
    expect(body.wait_timer).toBe(5);
    expect(body.reviewers).toEqual([{ type: "User", id: 1 }]);
    expect(body.deployment_branch_policy).toBeNull();
  });

  test("rollback deletes an environment this run created", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { environmentCreatedThisRun: true }, () => ({ status: 204, data: {} }), calls);
    await environmentStep.rollback(ctx);
    expect(calls).toEqual([
      { method: "DELETE", path: "/repos/o/r/environments/production", body: undefined },
    ]);
  });

  test("rollback no-ops for a pre-existing environment", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, { environmentCreatedThisRun: false }, () => ({ status: 204, data: {} }), calls);
    await environmentStep.rollback(ctx);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// add-environment-secret
// ---------------------------------------------------------------------------

describe("add-environment-secret", () => {
  const params: EnvSecretParams = {
    OWNER: "o",
    REPO: "r",
    ENVIRONMENT_NAME: "production",
    SECRET_NAME: "S",
    SECRET_VALUE: "v",
    FORCE_ROTATE: false,
  };

  test("create() writes to the environment-scoped secrets path", async () => {
    const calls: Call[] = [];
    const ctx = githubCtx(params, {}, (method, path) => {
      if (path.endsWith("/public-key")) return { status: 200, data: { key_id: "k1", key: PUBLIC_KEY_B64 } };
      return { status: 201, data: {} };
    }, calls);
    await environmentSecretStep.create!(ctx);
    expect(calls[1]!.path).toBe("/repos/o/r/environments/production/secrets/S");
  });
});
