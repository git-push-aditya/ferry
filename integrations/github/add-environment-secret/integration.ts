import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { mask } from "../../../src/core/report";
import { paramsSchema, type Params } from "./params";
import { environmentSecretStep } from "./steps/environment-secret";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/add-environment-secret",
  schemaVersion: 1,
  summary: "Encrypts and writes an environment-scoped Actions secret, proven by confirming presence.",

  // FORCE_ROTATE arrives as a "true"/"false" string — same ZodEffects cast
  // delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [environmentSecretStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.ENVIRONMENT_NAME}-${ctx.params.SECRET_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Environment Secret — \`${p.OWNER}/${p.REPO}:${p.ENVIRONMENT_NAME}:${p.SECRET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/add-environment-secret\`.
> The secret value is never included in this report or in ferry's logs.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Environment: \`${p.ENVIRONMENT_NAME}\`
- Secret name: \`${p.SECRET_NAME}\`
- Value (masked): \`${mask(p.SECRET_VALUE)}\`
- Force-rotated this run: ${p.FORCE_ROTATE ? "yes" : "no"}

## Precondition

This task never creates the environment — a missing one is a plan-phase
\`conflict\`. Run \`github/create-environment\` first.

## Verification

Verified — confirmed the secret exists on the environment. The value itself
cannot be verified (write-blind API).
`;
  },
});
