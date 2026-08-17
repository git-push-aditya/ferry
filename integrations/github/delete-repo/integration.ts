import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { confirmDestructiveStep } from "./steps/confirm-destructive";
import { deleteRepoStep } from "./steps/delete-repo";
import { verify } from "./verify";

/**
 * Deletes a GitHub repo. Never creates one — a real precondition, not a
 * cycle. Gated behind ALLOW_DESTRUCTIVE_TEARDOWN, same discipline as
 * aws/iam/user/delete-user/offboard-user.
 */
export default defineIntegration<Params>({
  id: "github/delete-repo",
  schemaVersion: 1,
  summary: "Deletes a GitHub repo after an explicit destructive-teardown confirmation.",

  // ALLOW_DESTRUCTIVE_TEARDOWN arrives as a "true"/"false" string — same
  // ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [confirmDestructiveStep, deleteRepoStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-deleted`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Repo Deletion — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/delete-repo\`.

## GitHub

- Owner: \`${p.OWNER}\`
- Repo: \`${p.REPO}\`
- Deleted this run: ${ctx.outputs.repoDeletedThisRun === true ? "yes" : "no (already gone before this run)"}

## Irreversibility

Everything in this repo — commit history, issues, PRs, settings — is gone
for good. This tool cannot restore it; GitHub support may be able to within
a short window via a manual support request, which is outside this
integration's scope.

## Verification

Verified — confirmed \`GET /repos/${p.OWNER}/${p.REPO}\` now 404s.
`;
  },
});
