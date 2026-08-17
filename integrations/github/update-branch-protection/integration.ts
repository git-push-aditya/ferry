import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { desiredBranchProtection, paramsSchema, type Params } from "./params";
import { branchProtectionStep } from "./steps/branch-protection";
import { verify } from "./verify";

/**
 * Reconciles a branch's protection ruleset to an exact desired document —
 * never creates the branch itself. Run github/create-repo (or push a first
 * commit) first if the branch doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "github/update-branch-protection",
  schemaVersion: 1,
  summary: "Reconciles a branch's protection ruleset to an exact desired document, proven with a read-back comparison.",

  // Every ENABLE_*/boolean flag arrives as a "true"/"false" string — same
  // ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [branchProtectionStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.BRANCH}-protection`,

  report(ctx) {
    const p = ctx.params;
    const desired = desiredBranchProtection(p);

    return `# Branch Protection — \`${p.OWNER}/${p.REPO}@${p.BRANCH}\`

> Generated ${new Date().toISOString()} by \`ferry github/update-branch-protection\`.

## Desired document

\`\`\`json
${JSON.stringify(desired, null, 2)}
\`\`\`

## Changed this run

${ctx.outputs.branchProtectionChanged === true ? "yes" : "no (already matched)"}

## Verification

Verified — re-read branch protection and confirmed it matches the document
above field-for-field.
`;
  },
});
