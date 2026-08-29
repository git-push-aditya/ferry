import { generateKeyPairSync } from "node:crypto";
import type { Step } from "../../../../src/core/define";
import { awsClients, describeSecret, isSecretNotFound, putSecretValue, secretTag, tagSecret, untagSecret } from "../../../../src/providers/aws";
import { descUser, snowflakeClients } from "../../../../src/providers/snowflake";
import { cleanPublicKey, SYNCED_FINGERPRINT_TAG_KEY, type Params } from "../params";

const RSA_PUBLIC_KEY_FP = "RSA_PUBLIC_KEY_FP";

/**
 * The one task in this codebase that generates private-key material itself
 * — a deliberate departure from snowflake/rotate-user-key-pair, which never
 * touches a private key at all (it only ever receives an already-generated
 * public half). That existing task's stance is a real security posture,
 * not an oversight; this task departs from it because the entire point
 * here is a machine-to-machine credential nobody has to hand-generate and
 * copy-paste. See README for the full reasoning — flagged there for
 * explicit review, not decided silently.
 *
 * The private key exists only in local process memory for the duration of
 * this step's create() call. It is never written to ctx.outputs,
 * resource(), or any log line.
 *
 * Idempotency is reversed from github/sync-secrets-manager-to-github-
 * secrets: that task tags the AWS-side secret with an AWS-native VersionId
 * since AWS is the source of truth. Here Snowflake is the source of truth
 * and exposes no version number — so the AWS secret is tagged with
 * Snowflake's own DESC USER RSA_PUBLIC_KEY_FP fingerprint, read back FROM
 * Snowflake after every key-set rather than computed independently. This
 * avoids needing to reproduce Snowflake's exact fingerprint algorithm.
 */
export const syncCredentialStep: Step<Params> = {
  id: "sync-credential",
  title: "Sync a fresh Snowflake key-pair credential into Secrets Manager",

  async check(ctx) {
    if (ctx.params.FORCE_ROTATE) return "missing";

    const conn = await snowflakeClients(ctx).connection();
    const props = await descUser(conn, ctx.params.SF_USER_NAME);
    const liveFingerprint = props.get(RSA_PUBLIC_KEY_FP) ?? "";
    if (!liveFingerprint) return "missing";

    const { secretsManager } = awsClients(ctx);
    let syncedFingerprint: string | undefined;
    try {
      const described = await describeSecret(secretsManager, ctx.params.AWS_SECRET_NAME);
      syncedFingerprint = secretTag(described, SYNCED_FINGERPRINT_TAG_KEY);
    } catch (err) {
      if (!isSecretNotFound(err)) throw err;
    }

    return syncedFingerprint === liveFingerprint ? "exists" : "missing";
  },

  async create(ctx) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(
      `ALTER USER ${ctx.params.SF_USER_NAME} SET RSA_PUBLIC_KEY = '${cleanPublicKey(publicKey)}';`,
    );

    const props = await descUser(conn, ctx.params.SF_USER_NAME);
    const fingerprint = props.get(RSA_PUBLIC_KEY_FP);
    if (!fingerprint) {
      throw new Error(`DESC USER did not report ${RSA_PUBLIC_KEY_FP} after setting the new key`);
    }

    const { secretsManager } = awsClients(ctx);
    await putSecretValue(secretsManager, ctx.params.AWS_SECRET_NAME, privateKey);
    await tagSecret(secretsManager, ctx.params.AWS_SECRET_NAME, SYNCED_FINGERPRINT_TAG_KEY, fingerprint);

    ctx.log.success(
      `Synced a new key pair for "${ctx.params.SF_USER_NAME}" into secret "${ctx.params.AWS_SECRET_NAME}"`,
    );

    // The plaintext private key is deliberately not returned here.
    return { credentialSyncedThisRun: true, syncedFingerprint: fingerprint };
  },

  /**
   * Removes only the sync tag, so the next run correctly re-detects "needs
   * sync" — never unsets the Snowflake-side key and never touches the AWS
   * secret's value, since a real consumer may already be using the new
   * credential by the time something later in the run fails.
   */
  async rollback(ctx) {
    if (ctx.outputs.credentialSyncedThisRun !== true) return;
    const { secretsManager } = awsClients(ctx);
    try {
      await untagSecret(secretsManager, ctx.params.AWS_SECRET_NAME, SYNCED_FINGERPRINT_TAG_KEY);
    } catch (err) {
      if (!isSecretNotFound(err)) throw err;
    }
    ctx.log.warn(
      `Rollback removed the sync tag on "${ctx.params.AWS_SECRET_NAME}" only — the Snowflake-side key ` +
        `and the secret's value were left in place; a real consumer may already be using the new credential.`,
    );
  },

  resource(ctx) {
    return {
      type: "snowflake_service_credential",
      name: ctx.params.SF_USER_NAME,
      attributes: {
        user: ctx.params.SF_USER_NAME,
        secretName: ctx.params.AWS_SECRET_NAME,
        publicKeyFingerprint: String(ctx.outputs.syncedFingerprint ?? ""),
      },
    };
  },
};
