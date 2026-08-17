import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { mask } from "../../../src/core/report";
import { paramsSchema, type Params } from "./params";
import { secretStep } from "./steps/secret";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/create-or-update-repo-secret",
  schemaVersion: 1,
  summary: "Encrypts and writes a repo Actions secret via libsodium sealed-box, proven by confirming presence.",

  // FORCE_ROTATE arrives as a "true"/"false" string — same ZodEffects cast
  // delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [secretStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.SECRET_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Actions Secret — \`${p.OWNER}/${p.REPO}:${p.SECRET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/create-or-update-repo-secret\`.
> The secret value is never included in this report or in ferry's logs.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Secret name: \`${p.SECRET_NAME}\`
- Value (masked): \`${mask(p.SECRET_VALUE)}\`
- Force-rotated this run: ${p.FORCE_ROTATE ? "yes" : "no"}

## Write-blind limitation

GitHub never returns a secret's value once written — this integration
cannot detect drift between the live value and what params request, so a
secret changed by hand (or another tool) will never be corrected unless
\`FORCE_ROTATE=true\`.

## Verification

Verified — confirmed the secret exists on the repo. The value itself cannot
be verified (write-blind API).
`;
  },
});
