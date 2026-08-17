import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { syncSecretStep } from "./steps/sync-secret";
import { verify } from "./verify";

/**
 * The second AWS+GitHub combined task: takes a value that already lives in
 * AWS Secrets Manager (this project's existing trust boundary for
 * credentials) and pushes a copy into a GitHub Actions repo or environment
 * secret, so a workflow can consume it via `secrets.*` context without a
 * manual copy-paste step. A real, competing alternative for callers who
 * could instead grant setup-github-actions-oidc-role's own role read access
 * to Secrets Manager directly — this task exists specifically for callers
 * who want a GitHub-native secret instead.
 */
export default defineIntegration<Params>({
  id: "github/sync-secrets-manager-to-github-secrets",
  schemaVersion: 1,
  summary:
    "Syncs an AWS Secrets Manager value into a GitHub Actions repo/environment secret, keyed on a version tag so re-runs skip an unchanged source.",

  // The .refine() on TARGET_SCOPE/ENVIRONMENT_NAME is a real ZodEffects
  // shape z.ZodType<P>'s plain-object generic doesn't model — same cast
  // update-security-group-rules's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws", "github"],

  steps: [syncSecretStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.TARGET_SECRET_NAME}-sync`,

  report(ctx) {
    const p = ctx.params;
    return `# Secrets Manager → GitHub Secret Sync — \`${p.TARGET_SECRET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/sync-secrets-manager-to-github-secrets\`.
> The secret value is never included in this report or in ferry's logs.

## Source

- Secrets Manager secret: \`${p.SOURCE_SECRET_ID}\`
- Synced version id: \`${ctx.outputs.syncedVersionId ?? "(already in sync — not re-read this run)"}\`

## Target

- GitHub scope: \`${p.TARGET_SCOPE}\`
- Repo: \`${p.OWNER}/${p.REPO}\`
${p.TARGET_SCOPE === "environment" ? `- Environment: \`${p.ENVIRONMENT_NAME}\`` : ""}
- Secret name: \`${p.TARGET_SECRET_NAME}\`

## Design note

This is a least-privilege-motivated one-way sync: \`check()\` compares
Secrets Manager's own current-version marker against a
\`ferry:last-synced-version\` tag this task writes, rather than reading the
live value on every \`ferry plan\` — the plaintext is only ever read once a
real change is detected.

## Verification

Verified — confirmed the Secrets Manager tag matches the version synced
this run, and the GitHub secret's \`updated_at\` moved at or after this
run's own sync timestamp. The GitHub-side value itself cannot be verified
(write-blind API).
`;
  },
});
