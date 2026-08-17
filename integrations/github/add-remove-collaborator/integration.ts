import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { collaboratorStep } from "./steps/collaborator";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/add-remove-collaborator",
  schemaVersion: 1,
  summary: "Adds or removes a repo collaborator at a given permission level, proven by re-reading collaborator status.",

  // PERMISSION's presence is conditional on ACTION (a .refine, not modeled by
  // z.ZodType<P>'s plain-object generic) — same cast shape update-security-
  // group-rules's integration.ts already uses for its own refined schema.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [collaboratorStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.USERNAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Collaborator — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/add-remove-collaborator\`.

## Change

- Repo: \`${p.OWNER}/${p.REPO}\`
- User: \`${p.USERNAME}\`
- Action: \`${p.ACTION}\`
${p.ACTION === "add" ? `- Permission: \`${p.PERMISSION}\`` : ""}

## Gotchas

GitHub gives no signal distinguishing "no change" from "an implicit
org/team-inherited permission was silently raised to the explicit level
requested" on a 204 response — this report cannot claim more precision than
the API itself provides.

## Verification

Verified — re-read collaborator status and confirmed it matches \`ACTION=${p.ACTION}\`.
`;
  },
});
