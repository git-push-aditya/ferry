import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { mask } from "../../../../../src/core/report";
import { userArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { cutoverOldKeyStep } from "./steps/cutover-old-key";
import { mintNewKeyStep } from "./steps/mint-new-key";
import { verify } from "./verify";

/**
 * Rotates an IAM user's access key in two explicitly separate, human-gated
 * phases — not a single atomic reconcile. AWS's own documented rotation
 * workflow is: create new key -> update every place the old key's
 * credentials are configured (manual, external to IAM) -> deactivate old key
 * -> (after a soak, confirming nothing broke) delete old key. Ferry has no
 * visibility into which downstream systems were updated, so it cannot safely
 * automate past minting the new key without a human's explicit go-ahead.
 *
 * Run once (mint), migrate your configured credentials to the new key,
 * confirm everything works, then run again with CONFIRM_CUTOVER=true to
 * retire the old key.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/rotate-access-key",
  schemaVersion: 1,
  summary:
    "Two-phase, human-gated access key rotation: mints a second key automatically, then only deactivates + deletes the old key once CONFIRM_CUTOVER=true.",

  // Folder .env values arrive as strings; CONFIRM_CUTOVER/ROTATION_SOAK_MINUTES
  // are transformed (see create-bucket/params.ts for the same precedent).
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [mintNewKeyStep, cutoverOldKeyStep],

  verify,

  reportName: (ctx) => ctx.params.IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const newAccessKeyId = String(ctx.outputs.newAccessKeyId ?? "");
    const oldAccessKeyId = String(ctx.outputs.oldAccessKeyId ?? "");
    const newSecret = String(ctx.outputs.newSecretAccessKey ?? "");
    const mintedThisRun = Boolean(ctx.outputs.newKeyMintedThisRun);
    const cutoverDone = Boolean(ctx.outputs.oldKeyDeletedThisRun);
    const deactivatedOnly = Boolean(ctx.outputs.oldKeyDeactivatedThisRun) && !cutoverDone;

    if (mintedThisRun && newSecret) {
      console.log(`
  ── New access key for ${p.IAM_USER_NAME} — full secret shown once ──
  AWS_ACCESS_KEY_ID=${newAccessKeyId}
  AWS_SECRET_ACCESS_KEY=${newSecret}

  Update every configured credential to use this key, confirm the application
  still works, then re-run this integration with CONFIRM_CUTOVER=true to
  retire the old key (${oldAccessKeyId}).
`);
    }

    const phase = cutoverDone
      ? "Full cutover completed this run"
      : mintedThisRun
        ? "Mint-only (Phase A) completed this run"
        : "No mutation this run (already converged for the current CONFIRM_CUTOVER setting)";

    return `# Rotate Access Key — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/rotate-access-key\`.
> This is a two-phase, human-gated process. The secret access key (if minted
> this run) is **masked** here — it was printed to stdout once, above.

## User

- Name: \`${p.IAM_USER_NAME}\`
- ARN: \`${userArn(ctx.accountId, p.IAM_USER_NAME)}\`

## This run

**${phase}.**

- New key: \`${newAccessKeyId || "(none this run)"}\` ${newSecret ? `— secret: \`${mask(newSecret)}\`` : ""}
- Old key: \`${oldAccessKeyId || "(unknown)"}\` — ${
      cutoverDone
        ? "deactivated **and deleted** this run"
        : deactivatedOnly
          ? "deactivated this run (not yet deleted)"
          : "untouched this run"
    }
- \`CONFIRM_CUTOVER\`: \`${p.CONFIRM_CUTOVER}\`
- \`ROTATION_SOAK_MINUTES\`: \`${p.ROTATION_SOAK_MINUTES}\`

## Next steps

${
  cutoverDone
    ? "Rotation is complete. The old key has been deactivated and deleted — this cannot be undone."
    : `Update every configured credential to use the new key above, confirm the application works, ` +
      `then re-run this integration with \`CONFIRM_CUTOVER=true\` to deactivate and delete the old key ` +
      `\`${oldAccessKeyId || "(unknown)"}\`.`
}
`;
  },
});
