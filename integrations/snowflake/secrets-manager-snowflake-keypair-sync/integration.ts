import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { syncCredentialStep } from "./steps/sync-credential";
import { userExistsGuardStep } from "./steps/user-exists";
import { verify } from "./verify";

/**
 * Generates a fresh RSA key pair, sets its public half on an existing
 * Snowflake user (slot 1, a plain overwrite — not the careful two-slot
 * zero-downtime dance snowflake/rotate-user-key-pair uses for live users),
 * and pushes the private half into AWS Secrets Manager.
 *
 * SECURITY NOTE, flagged here as prominently as in the README: this is the
 * only integration in this codebase that generates private-key material.
 * snowflake/rotate-user-key-pair deliberately never touches a private key
 * — it only ever receives an already-generated public half from the
 * caller. This integration departs from that stance because the entire
 * point of a Secrets-Manager-backed service credential is that nobody
 * hand-generates and copy-pastes it. Review this design choice before
 * relying on it in production — see README.
 */
export default defineIntegration<Params>({
  id: "snowflake/secrets-manager-snowflake-keypair-sync",
  schemaVersion: 1,
  summary:
    "Generates a Snowflake user key pair and syncs the private half into AWS Secrets Manager, keyed on Snowflake's own fingerprint so re-runs skip an unchanged key.",

  // FORCE_ROTATE arrives as a "true"/"false" string — same ZodEffects cast
  // delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws", "snowflake"],

  steps: [connectStep, userExistsGuardStep, syncCredentialStep],

  verify,

  reportName: (ctx) => ctx.params.SF_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const fingerprint = String(ctx.outputs.syncedFingerprint ?? "(unchanged this run)");

    return `# Snowflake Key-Pair → Secrets Manager Sync — \`${p.SF_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/secrets-manager-snowflake-keypair-sync\`.
> The private key value is never included in this report or in ferry's logs.

## Snowflake

- User: \`${p.SF_USER_NAME}\`
- Public key fingerprint: \`${fingerprint}\`

## AWS

- Secret: \`${p.AWS_SECRET_NAME}\`
- Synced-fingerprint tag: \`${fingerprint}\`

## Verification

Verified — confirmed the secret's synced-fingerprint tag matches the
user's live \`RSA_PUBLIC_KEY_FP\` exactly. The secret's value itself is
never read back by this integration.
`;
  },
});
