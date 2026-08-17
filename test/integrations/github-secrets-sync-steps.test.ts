import { beforeAll, describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import type { StepContext } from "../../src/core/define";
import { syncSecretStep } from "../../integrations/github/sync-secrets-manager-to-github-secrets/steps/sync-secret";
import type { Params } from "../../integrations/github/sync-secrets-manager-to-github-secrets/params";
import { fakeGithubClient, NO_LOG, type Call } from "../helpers/github-fake-client";

let PUBLIC_KEY_B64: string;

beforeAll(async () => {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  PUBLIC_KEY_B64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
});

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function syncCtx(
  params: Params,
  outputs: Record<string, unknown>,
  sendSecretsManager: (command: FakeCommand) => unknown,
  githubHandle: (method: string, path: string, body: unknown) => { status: number; data?: unknown } | Error,
  githubCalls: Call[] = [],
): StepContext<Params> {
  const secretsManager = {
    async send(command: FakeCommand) {
      const reply = sendSecretsManager(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: {
      aws: { s3: secretsManager, iam: secretsManager, sts: secretsManager, ec2: secretsManager, ssm: secretsManager, secretsManager, region: "us-east-1" },
      github: { rest: fakeGithubClient(githubHandle, githubCalls) },
    },
    accountId: "",
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const REPO_PARAMS: Params = {
  SOURCE_SECRET_ID: "my-secret",
  OWNER: "o",
  REPO: "r",
  TARGET_SCOPE: "repo",
  ENVIRONMENT_NAME: undefined,
  TARGET_SECRET_NAME: "TARGET",
};

describe("sync-secret: check()", () => {
  test("missing repo -> conflict", async () => {
    const ctx = syncCtx(REPO_PARAMS, {}, () => ({}), () => ({ status: 404, data: {} }));
    expect(await syncSecretStep.check(ctx)).toBe("conflict");
  });

  test("no last-synced tag yet -> missing", async () => {
    const ctx = syncCtx(
      REPO_PARAMS,
      {},
      (cmd) => {
        if (cmd.constructor.name === "DescribeSecretCommand") {
          return { VersionIdsToStages: { v1: ["AWSCURRENT"] }, Tags: [] };
        }
        throw new Error(`unexpected ${cmd.constructor.name}`);
      },
      () => ({ status: 200, data: {} }),
    );
    expect(await syncSecretStep.check(ctx)).toBe("missing");
  });

  test("current version matches the last-synced tag -> exists (skip, no plaintext read)", async () => {
    const ctx = syncCtx(
      REPO_PARAMS,
      {},
      (cmd) => {
        if (cmd.constructor.name === "DescribeSecretCommand") {
          return { VersionIdsToStages: { v1: ["AWSCURRENT"] }, Tags: [{ Key: "ferry:last-synced-version", Value: "v1" }] };
        }
        if (cmd.constructor.name === "GetSecretValueCommand") throw new Error("check() must never read the plaintext value");
        throw new Error(`unexpected ${cmd.constructor.name}`);
      },
      () => ({ status: 200, data: {} }),
    );
    expect(await syncSecretStep.check(ctx)).toBe("exists");
  });

  test("current version differs from the last-synced tag -> missing (needs a re-sync)", async () => {
    const ctx = syncCtx(
      REPO_PARAMS,
      {},
      (cmd) => {
        if (cmd.constructor.name === "DescribeSecretCommand") {
          return { VersionIdsToStages: { v2: ["AWSCURRENT"] }, Tags: [{ Key: "ferry:last-synced-version", Value: "v1" }] };
        }
        throw new Error(`unexpected ${cmd.constructor.name}`);
      },
      () => ({ status: 200, data: {} }),
    );
    expect(await syncSecretStep.check(ctx)).toBe("missing");
  });

  test("environment scope: missing environment -> conflict", async () => {
    const params: Params = { ...REPO_PARAMS, TARGET_SCOPE: "environment", ENVIRONMENT_NAME: "prod" };
    const ctx = syncCtx(params, {}, () => ({}), (method, path) => {
      if (path === "/repos/o/r") return { status: 200, data: {} };
      return { status: 404, data: {} };
    });
    expect(await syncSecretStep.check(ctx)).toBe("conflict");
  });
});

describe("sync-secret: create()", () => {
  test("reads the plaintext, writes the GitHub secret, then tags the source with the synced version", async () => {
    const githubCalls: Call[] = [];
    const awsSent: string[] = [];
    const ctx = syncCtx(
      REPO_PARAMS,
      {},
      (cmd) => {
        awsSent.push(cmd.constructor.name);
        if (cmd.constructor.name === "DescribeSecretCommand") return { VersionIdsToStages: { v1: ["AWSCURRENT"] } };
        if (cmd.constructor.name === "GetSecretValueCommand") return { SecretString: "topsecret" };
        if (cmd.constructor.name === "TagResourceCommand") {
          expect(cmd.input.Tags).toEqual([{ Key: "ferry:last-synced-version", Value: "v1" }]);
          return {};
        }
        throw new Error(`unexpected ${cmd.constructor.name}`);
      },
      (method, path) => {
        if (path.endsWith("/public-key")) return { status: 200, data: { key_id: "k1", key: PUBLIC_KEY_B64 } };
        return { status: 201, data: {} };
      },
      githubCalls,
    );

    const outputs = await syncSecretStep.create!(ctx);
    expect(outputs.secretsSyncedThisRun).toBe(true);
    expect(outputs.syncedVersionId).toBe("v1");
    expect(awsSent).toEqual(["DescribeSecretCommand", "GetSecretValueCommand", "TagResourceCommand"]);
    expect(githubCalls[1]!.path).toBe("/repos/o/r/actions/secrets/TARGET");
    // The plaintext value must never leak into ctx.outputs.
    expect(JSON.stringify(outputs)).not.toContain("topsecret");
  });

  test("throws if the source secret has no AWSCURRENT version", async () => {
    const ctx = syncCtx(
      REPO_PARAMS,
      {},
      (cmd) => {
        if (cmd.constructor.name === "DescribeSecretCommand") return { VersionIdsToStages: {} };
        throw new Error(`unexpected ${cmd.constructor.name}`);
      },
      () => ({ status: 200, data: {} }),
    );
    await expect(syncSecretStep.create!(ctx)).rejects.toThrow(/no AWSCURRENT version/);
  });
});

describe("sync-secret: rollback()", () => {
  test("removes the sync-version tag and never touches the GitHub-side secret", async () => {
    const githubCalls: Call[] = [];
    const awsSent: string[] = [];
    const ctx = syncCtx(
      REPO_PARAMS,
      { secretsSyncedThisRun: true },
      (cmd) => {
        awsSent.push(cmd.constructor.name);
        return {};
      },
      () => ({ status: 200, data: {} }),
      githubCalls,
    );
    await syncSecretStep.rollback(ctx);
    expect(awsSent).toEqual(["UntagResourceCommand"]);
    expect(githubCalls).toHaveLength(0);
  });

  test("no-op if this run never synced anything", async () => {
    const awsSent: string[] = [];
    const ctx = syncCtx(REPO_PARAMS, {}, (cmd) => {
      awsSent.push(cmd.constructor.name);
      return {};
    }, () => ({ status: 200, data: {} }));
    await syncSecretStep.rollback(ctx);
    expect(awsSent).toHaveLength(0);
  });
});
