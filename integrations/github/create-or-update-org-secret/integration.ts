import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { mask } from "../../../src/core/report";
import { paramsSchema, type Params } from "./params";
import { orgSecretStep } from "./steps/org-secret";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/create-or-update-org-secret",
  schemaVersion: 1,
  summary:
    "Encrypts and writes an org-scoped Actions secret, reconciling its visibility/selected-repo list independently of the write-blind value.",

  // FORCE_ROTATE arrives as a "true"/"false" string — same ZodEffects cast
  // delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [orgSecretStep],

  verify,

  reportName: (ctx) => `${ctx.params.ORG}-${ctx.params.SECRET_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Org Actions Secret — \`${p.ORG}:${p.SECRET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/create-or-update-org-secret\`.
> The secret value is never included in this report or in ferry's logs.

## GitHub

- Org: \`${p.ORG}\`
- Secret name: \`${p.SECRET_NAME}\`
- Value (masked): \`${mask(p.SECRET_VALUE)}\`
- Visibility: \`${p.VISIBILITY}\`
${p.VISIBILITY === "selected" ? `- Selected repository ids: ${JSON.stringify(p.SELECTED_REPOSITORY_IDS)}` : ""}

## Write-blind limitation

Same as \`create-or-update-repo-secret\`: the value can never be read back,
so drift in the value itself is never detected. Visibility and the
selected-repo list, unlike the value, ARE readable and are reconciled every
run.

## Verification

Verified — confirmed the secret exists on the org with the requested
visibility. The value itself cannot be verified (write-blind API).
`;
  },
});
