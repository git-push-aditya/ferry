import { beforeAll, describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import { githubRepoStep } from "../../src/providers/github";
import { environmentStep } from "../../integrations/github/create-environment/steps/environment";
import type { Params as EnvironmentParams } from "../../integrations/github/create-environment/params";
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

// ---------------------------------------------------------------------------
// create-or-update-org-secret
// ---------------------------------------------------------------------------

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

