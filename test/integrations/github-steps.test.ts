import { beforeAll, describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import { githubRepoStep } from "../../src/providers/github";
import { secretStep } from "../../integrations/github/create-or-update-repo-secret/steps/secret";
import type { Params as RepoSecretParams } from "../../integrations/github/create-or-update-repo-secret/params";
import { orgSecretStep } from "../../integrations/github/create-or-update-org-secret/steps/org-secret";
import type { Params as OrgSecretParams } from "../../integrations/github/create-or-update-org-secret/params";
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

// ---------------------------------------------------------------------------
// update-branch-protection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// create-webhook
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// enable-disable-workflow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// trigger-workflow-dispatch
// ---------------------------------------------------------------------------

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
