import type { StepContext } from "../../../src/core/define";
import { awsClients, describeSecret, secretTag } from "../../../src/providers/aws";
import { descUser, snowflakeClients } from "../../../src/providers/snowflake";
import { SYNCED_FINGERPRINT_TAG_KEY, type Params } from "./params";

const RSA_PUBLIC_KEY_FP = "RSA_PUBLIC_KEY_FP";

/**
 * Both halves are genuinely checkable here — a real structural advantage
 * over github/sync-secrets-manager-to-github-secrets, where the GitHub
 * side is permanently write-blind. Confirms the AWS secret's tag matches
 * the live Snowflake fingerprint exactly; never reads the secret's value.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const props = await descUser(conn, ctx.params.SF_USER_NAME);
  const liveFingerprint = props.get(RSA_PUBLIC_KEY_FP) ?? "";
  if (!liveFingerprint) {
    throw new Error(`Snowflake user "${ctx.params.SF_USER_NAME}" has no RSA_PUBLIC_KEY_FP after sync`);
  }

  const { secretsManager } = awsClients(ctx);
  const described = await describeSecret(secretsManager, ctx.params.AWS_SECRET_NAME);
  const syncedFingerprint = secretTag(described, SYNCED_FINGERPRINT_TAG_KEY);

  if (syncedFingerprint !== liveFingerprint) {
    throw new Error(
      `Secret "${ctx.params.AWS_SECRET_NAME}"'s synced-fingerprint tag does not match ` +
        `"${ctx.params.SF_USER_NAME}"'s live RSA_PUBLIC_KEY_FP`,
    );
  }

  ctx.log.success(
    `Confirmed "${ctx.params.AWS_SECRET_NAME}" is tagged with the current fingerprint of "${ctx.params.SF_USER_NAME}"'s key`,
  );
}
