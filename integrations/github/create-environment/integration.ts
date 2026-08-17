import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { environmentStep } from "./steps/environment";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/create-environment",
  schemaVersion: 1,
  summary: "Creates a deployment environment with reviewers/wait-timer/branch policy, proven by reading it back.",

  // ENABLE_DEPLOYMENT_BRANCH_POLICY etc. arrive as "true"/"false" strings —
  // same ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [environmentStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.ENVIRONMENT_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Environment — \`${p.OWNER}/${p.REPO}:${p.ENVIRONMENT_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/create-environment\`.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Environment: \`${p.ENVIRONMENT_NAME}\`
- Wait timer: ${p.WAIT_TIMER} minute(s)
- Reviewers: ${p.REVIEWERS.length}
- Deployment branch policy: ${p.ENABLE_DEPLOYMENT_BRANCH_POLICY ? `protected_branches=${p.PROTECTED_BRANCHES}, custom_branch_policies=${p.CUSTOM_BRANCH_POLICIES}` : "(none)"}

## Gotcha

Deleting this environment (via rollback, or manually) also removes every
secret scoped to it — a wider blast radius than deleting a single repo
secret.

## Verification

Verified — re-read the environment and confirmed its settings match what
was requested.
`;
  },
});
