import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { deployKeyStep } from "./steps/deploy-key";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/create-deploy-key",
  schemaVersion: 1,
  summary: "Registers an SSH deploy key on a repo, proven by re-reading it and confirming read_only.",

  // READ_ONLY arrives as a "true"/"false" string — same ZodEffects cast
  // delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [deployKeyStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.TITLE}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Deploy Key — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/create-deploy-key\`.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Title: \`${p.TITLE}\`
- Key id: \`${ctx.outputs.deployKeyId ?? ""}\`
- Read-only: ${p.READ_ONLY}

## Verification

Verified — re-read the deploy key and confirmed \`read_only\` matches what
was requested.
`;
  },
});
