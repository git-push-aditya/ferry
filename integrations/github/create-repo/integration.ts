import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { githubRepoStep } from "../../../src/providers/github";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * The root of the dependency graph for every other github/* task that
 * operates on a repo — branch-protection, secrets, collaborators, webhooks,
 * deploy keys, and environments all assume a repo already exists, either
 * from a prior run of this integration or from a repo provisioned outside
 * Ferry. Mirrors aws/iam/role/create-role's role in this project.
 */
export default defineIntegration<Params>({
  id: "github/create-repo",
  schemaVersion: 1,
  summary:
    "Creates a GitHub repo under a user or org account, proven by reading it back and confirming visibility.",

  // The .env-facing input differs from the parsed output (AUTO_INIT/
  // ALLOW_DESTRUCTIVE_ROLLBACK arrive as "true"/"false" strings), a real
  // ZodEffects shape that z.ZodType<P>'s same-Input-as-Output generic
  // doesn't model. Same cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [
    githubRepoStep<Params>({
      owner: (p) => p.OWNER,
      repo: (p) => p.REPO,
      ownerType: (p) => p.OWNER_TYPE,
      description: (p) => p.DESCRIPTION,
      visibility: (p) => p.VISIBILITY,
      autoInit: (p) => p.AUTO_INIT,
      gitignoreTemplate: (p) => p.GITIGNORE_TEMPLATE,
      licenseTemplate: (p) => p.LICENSE_TEMPLATE,
      allowDestructiveRollback: (p) => p.ALLOW_DESTRUCTIVE_ROLLBACK,
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}`,

  report(ctx) {
    const p = ctx.params;
    const htmlUrl = String(ctx.outputs.githubRepoHtmlUrl ?? `https://github.com/${p.OWNER}/${p.REPO}`);

    return `# GitHub Repo — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/create-repo\`.

## GitHub

- Owner: \`${p.OWNER}\` (${p.OWNER_TYPE})
- Repo: \`${p.REPO}\`
- URL: ${htmlUrl}
- Visibility: ${p.VISIBILITY ?? "(GitHub default — private for most accounts)"}
- Auto-init: ${p.AUTO_INIT ? "yes (initial commit + README)" : "no (fully empty repo)"}

## Rollback

Rollback only deletes this repo if \`ALLOW_DESTRUCTIVE_ROLLBACK=true\` was set —
this is real, irreversible data loss for anything committed since creation,
unlike an empty-bucket rollback. Currently: \`${p.ALLOW_DESTRUCTIVE_ROLLBACK}\`.

## Verification

Verified — re-read the repo and confirmed its visibility matches what was
requested.
`;
  },
});
