import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { dispatchStep } from "./steps/dispatch";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/trigger-workflow-dispatch",
  schemaVersion: 1,
  summary: "Fires a workflow_dispatch event and best-effort correlates the resulting run, optionally waiting for its conclusion.",

  // WAIT_FOR_COMPLETION/INPUTS_JSON arrive as strings needing transforms —
  // same ZodEffects cast delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [dispatchStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-${ctx.params.WORKFLOW_ID}-dispatch`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Workflow Dispatch — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/trigger-workflow-dispatch\`.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Workflow: \`${p.WORKFLOW_ID}\`
- Ref: \`${p.REF}\`
- Inputs: \`${JSON.stringify(p.INPUTS_JSON)}\`
- Correlated run id: ${ctx.outputs.correlatedRunId ?? "(not correlated)"}
- Waited for completion: ${p.WAIT_FOR_COMPLETION}
${p.WAIT_FOR_COMPLETION ? `- Conclusion: \`${ctx.outputs.runConclusion ?? "(unknown)"}\`` : ""}

## Limitations

GitHub's dispatch API returns no run id — correlation is by timestamp,
best-effort, and can be ambiguous if a second unrelated dispatch raced this
one within the same poll window.

## Verification

${p.WAIT_FOR_COMPLETION ? `Verified — re-read the correlated run and confirmed it concluded "${p.EXPECTED_CONCLUSION}".` : "Verified only that the dispatch call itself was accepted — WAIT_FOR_COMPLETION=false, so run outcome is unverified."}
`;
  },
});
