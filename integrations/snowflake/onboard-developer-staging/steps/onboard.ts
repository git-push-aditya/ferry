import type { Step } from "../../../../src/core/define";
import { snowflakeClients, sqlLiteral, userState } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * `RSA_PUBLIC_KEY` wants only the base64 body — no PEM header/footer lines.
 * Accept either shape: strip any `-----BEGIN...-----`/`-----END...-----`
 * lines if present, and collapse the remaining whitespace so a
 * copy-pasted multi-line key becomes one contiguous base64 string.
 */
export function cleanPublicKeyBase64(publicKey: string): string {
  return publicKey
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^-----(BEGIN|END)/.test(line))
    .join("");
}

/**
 * Onboards a developer as a brand-new Snowflake user: creates the user with
 * key-pair-only auth (no password) and grants the default role. This is a
 * one-shot bundle, not a diff — a user that already exists is left entirely
 * alone (rotating keys, changing roles, or adding a second key are separate,
 * deliberate tasks: rotate-user-key-pair / update-user-role /
 * add-public-key-to-existing-user).
 *
 * One step, not three: create-user, grant-role, and capturing the outcome
 * are not independently rollback-able here — a failure partway through
 * onboarding should unwind the whole thing, not leave a half-onboarded user
 * with no role or a role but no key.
 */
export const onboardStep: Step<Params> = {
  id: "onboard-developer",
  title: "Create developer user with key-pair auth and default role",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    return userState(conn, ctx.params.USER_NAME);
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const { USER_NAME, EMAIL, PUBLIC_KEY, DEFAULT_ROLE } = ctx.params;
    const rsaPublicKey = cleanPublicKeyBase64(PUBLIC_KEY);

    // No password: this developer authenticates with the key pair only.
    // DEFAULT_ROLE is an identifier (validated by snowflakeIdentifier), not
    // a literal, so it is not passed through sqlLiteral.
    await conn.runQuery(
      `CREATE USER ${USER_NAME}
        EMAIL = ${sqlLiteral(EMAIL)},
        RSA_PUBLIC_KEY = ${sqlLiteral(rsaPublicKey)},
        DEFAULT_ROLE = ${DEFAULT_ROLE},
        MUST_CHANGE_PASSWORD = FALSE;`,
    );

    // The role must already exist — a real precondition. This task does not
    // create roles on the fly (see create-role, a separate task); if it's
    // missing, Snowflake's own error surfaces clearly here.
    await conn.runQuery(`GRANT ROLE ${DEFAULT_ROLE} TO USER ${USER_NAME};`);

    return { userCreatedThisRun: true };
  },

  /**
   * Dropping the user revokes its role grant atomically too — no separate
   * REVOKE needed, since rollback only fires when create() ran this run,
   * meaning the user is entirely this run's creation with no prior history.
   */
  async rollback(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    await conn.runQuery(`DROP USER IF EXISTS ${ctx.params.USER_NAME};`);
  },

  resource(ctx) {
    return {
      type: "snowflake_user",
      name: ctx.params.USER_NAME,
      attributes: { userName: ctx.params.USER_NAME, defaultRole: ctx.params.DEFAULT_ROLE },
    };
  },
};
