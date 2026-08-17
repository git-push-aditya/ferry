import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { workflowStateStep } from "./steps/workflow-state";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/enable-disable-workflow",
  schemaVersion: 1,
  summary: "Toggles a GitHub Actions workflow's enabled state, proven by re-reading it back.",

  params: paramsSchema,
  credentials: ["github"],

  steps: [workflowStateStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.WORKFLOW_ID}`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Workflow Toggle — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/enable-disable-workflow\`.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Workflow: \`${p.WORKFLOW_ID}\`
- Action: \`${p.ACTION}\`

## Verification

Verified — re-read the workflow and confirmed its state matches
\`ACTION=${p.ACTION}\`.
`;
  },
});
