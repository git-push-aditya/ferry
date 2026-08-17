import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { cutoverOldKeyStep } from "./steps/cutover-old-key";
import { mintNewKeyStep } from "./steps/mint-new-key";
import { verify } from "./verify";

/**
 * Genuinely zero-downtime rotation using Snowflake's two RSA key slots.
 * Modelled as two steps in sequence — mint, then a human-gated cutover — in
 * the same spirit as this repo's AWS access-key rotation: mint the
 * replacement first, let the operator migrate connections and confirm they
 * work, then retire the old credential in a separate, deliberate action.
 */
export default defineIntegration<Params>({
  id: "snowflake/rotate-user-key-pair",
  schemaVersion: 1,
  summary:
    "Zero-downtime RSA key rotation for a Snowflake user: mints the new key into the unused slot, then — once CONFIRM_CUTOVER=true — retires the old one.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["snowflake"],

  steps: [connectStep, mintNewKeyStep, cutoverOldKeyStep],

  verify,

  reportName: (ctx) => ctx.params.USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const newSlot = String(ctx.outputs.newKeySlot ?? "?");
    const oldSlot = ctx.outputs.oldKeySlot as string | undefined;

    return `# Snowflake Key Rotation — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/rotate-user-key-pair\`.

## What happened

- User: \`${p.USER_NAME}\`
- New key minted into slot \`${newSlot}\`
- Cutover: ${oldSlot ? `old key cleared from slot \`${oldSlot}\`` : "**not yet run** — re-run with `CONFIRM_CUTOVER=true` once connections are migrated"}

## Next steps

${
  oldSlot
    ? "Rotation complete. The new key is now the only key on this user."
    : "Update every configured Snowflake connection for this user to use the new key, confirm they authenticate successfully, then re-run this integration with `CONFIRM_CUTOVER=true` to retire the old key."
}

## Verification

\`DESC USER ${p.USER_NAME}\` shows the new key's fingerprint populated${
      oldSlot ? ", and the old key's fingerprint now empty" : ""
    }.
`;
  },
});
