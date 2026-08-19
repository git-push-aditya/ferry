import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { syncCredentialStep } from "../../integrations/snowflake/secrets-manager-snowflake-keypair-sync/steps/sync-credential";
import type { Params } from "../../integrations/snowflake/secrets-manager-snowflake-keypair-sync/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 400 } });
}

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function ctxFor(
  params: Params,
  outputs: Record<string, unknown>,
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>,
  sendSecretsManager: (command: FakeCommand) => unknown,
): StepContext<Params> {
  const conn = { connection: {}, runQuery, close: async () => {} };
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
      snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} },
      aws: { s3: secretsManager, iam: secretsManager, sts: secretsManager, ec2: secretsManager, ssm: secretsManager, secretsManager, ecr: secretsManager, region: "us-east-1" },
    },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const PARAMS: Params = {
  SF_USER_NAME: "svc_ci_user",
  AWS_SECRET_NAME: "ferry/svc-ci-user-key",
  FORCE_ROTATE: false,
};

function descUserRows(fp: string): Record<string, unknown>[] {
  return [{ property: "RSA_PUBLIC_KEY_FP", property_value: fp }];
}

describe("secrets-manager-snowflake-keypair-sync: check()", () => {
  test("no key on the user yet -> missing", async () => {
    const ctx = ctxFor(PARAMS, {}, async () => descUserRows(""), () => ({}));
    expect(await syncCredentialStep.check(ctx)).toBe("missing");
  });

  test("secret not found -> missing", async () => {
    const ctx = ctxFor(
      PARAMS,
      {},
      async () => descUserRows("SHA256:abc123"),
      () => awsError("ResourceNotFoundException"),
    );
    expect(await syncCredentialStep.check(ctx)).toBe("missing");
  });

  test("tag matches live fingerprint -> exists (skip, no key generated)", async () => {
    const ctx = ctxFor(
      PARAMS,
      {},
      async () => descUserRows("SHA256:abc123"),
      () => ({ Tags: [{ Key: "ferry:synced-pubkey-fp", Value: "SHA256:abc123" }] }),
    );
    expect(await syncCredentialStep.check(ctx)).toBe("exists");
  });

  test("tag differs from live fingerprint -> missing (needs resync)", async () => {
    const ctx = ctxFor(
      PARAMS,
      {},
      async () => descUserRows("SHA256:new-fp"),
      () => ({ Tags: [{ Key: "ferry:synced-pubkey-fp", Value: "SHA256:old-fp" }] }),
    );
    expect(await syncCredentialStep.check(ctx)).toBe("missing");
  });

  test("FORCE_ROTATE=true always -> missing, without reading Snowflake or AWS", async () => {
    const ctx = ctxFor(
      { ...PARAMS, FORCE_ROTATE: true },
      {},
      async () => {
        throw new Error("check() must not read Snowflake when FORCE_ROTATE is set");
      },
      () => {
        throw new Error("check() must not read AWS when FORCE_ROTATE is set");
      },
    );
    expect(await syncCredentialStep.check(ctx)).toBe("missing");
  });
});

describe("secrets-manager-snowflake-keypair-sync: create()", () => {
  test("generates a key pair, sets it on the user, pushes to Secrets Manager, tags with the fresh fingerprint — and never leaks the private key", async () => {
    const sqlSent: string[] = [];
    const awsSent: FakeCommand[] = [];
    const ctx = ctxFor(
      PARAMS,
      {},
      async (sql) => {
        sqlSent.push(sql);
        if (sql.startsWith("ALTER USER")) return [];
        return descUserRows("SHA256:freshfp");
      },
      (cmd) => {
        awsSent.push(cmd);
        if (cmd.constructor.name === "DescribeSecretCommand") return awsError("ResourceNotFoundException");
        return {};
      },
    );

    const outputs = await syncCredentialStep.create!(ctx);
    expect(outputs.credentialSyncedThisRun).toBe(true);
    expect(outputs.syncedFingerprint).toBe("SHA256:freshfp");

    // The private key must never appear in the returned outputs.
    expect(JSON.stringify(outputs)).not.toContain("PRIVATE KEY");

    expect(sqlSent[0]).toContain("ALTER USER svc_ci_user SET RSA_PUBLIC_KEY = '");
    expect(sqlSent[0]).not.toContain("-----BEGIN"); // cleanPublicKey stripped the PEM armor

    const commandNames = awsSent.map((c) => c.constructor.name);
    expect(commandNames).toEqual([
      "DescribeSecretCommand",
      "CreateSecretCommand",
      "TagResourceCommand",
    ]);
    const createCall = awsSent.find((c) => c.constructor.name === "CreateSecretCommand")!;
    expect(String(createCall.input.SecretString)).toContain("PRIVATE KEY");
    const tagCall = awsSent.find((c) => c.constructor.name === "TagResourceCommand")!;
    expect(tagCall.input.Tags).toEqual([{ Key: "ferry:synced-pubkey-fp", Value: "SHA256:freshfp" }]);
  });

  test("throws if DESC USER reports no fingerprint after setting the key", async () => {
    const ctx = ctxFor(
      PARAMS,
      {},
      async (sql) => (sql.startsWith("ALTER USER") ? [] : []),
      () => ({}),
    );
    await expect(syncCredentialStep.create!(ctx)).rejects.toThrow(/did not report/);
  });
});

describe("secrets-manager-snowflake-keypair-sync: rollback()", () => {
  test("removes only the sync tag, never touches the secret value or the Snowflake key", async () => {
    const awsSent: string[] = [];
    const sqlSent: string[] = [];
    const ctx = ctxFor(
      PARAMS,
      { credentialSyncedThisRun: true },
      async (sql) => {
        sqlSent.push(sql);
        return [];
      },
      (cmd) => {
        awsSent.push(cmd.constructor.name);
        return {};
      },
    );
    await syncCredentialStep.rollback(ctx);
    expect(awsSent).toEqual(["UntagResourceCommand"]);
    expect(sqlSent).toEqual([]);
  });

  test("no-op if this run never synced anything", async () => {
    const awsSent: string[] = [];
    const ctx = ctxFor(PARAMS, {}, async () => [], (cmd) => {
      awsSent.push(cmd.constructor.name);
      return {};
    });
    await syncCredentialStep.rollback(ctx);
    expect(awsSent).toHaveLength(0);
  });
});

describe("secrets-manager-snowflake-keypair-sync: resource()", () => {
  test("never includes the private key", () => {
    const ctx = ctxFor(PARAMS, { syncedFingerprint: "SHA256:abc" }, async () => [], () => ({}));
    const resource = syncCredentialStep.resource!(ctx);
    expect(JSON.stringify(resource)).not.toContain("PRIVATE KEY");
    expect(resource.attributes?.publicKeyFingerprint).toBe("SHA256:abc");
  });
});
