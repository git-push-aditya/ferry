import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { webhookStep } from "./steps/webhook";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "github/create-webhook",
  schemaVersion: 1,
  summary:
    "Creates a repo webhook and smoke-tests it with a ping, proven by re-reading the hook and confirming it's active.",

  // ACTIVE arrives as a "true"/"false" string — same ZodEffects cast
  // delete-user's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [webhookStep],

  verify,

  reportName: (ctx) => `${ctx.params.OWNER}-${ctx.params.REPO}-webhook`,

  report(ctx) {
    const p = ctx.params;
    return `# GitHub Webhook — \`${p.OWNER}/${p.REPO}\`

> Generated ${new Date().toISOString()} by \`ferry github/create-webhook\`.

## GitHub

- Repo: \`${p.OWNER}/${p.REPO}\`
- Hook id: \`${ctx.outputs.webhookId ?? ""}\`
- URL: ${p.URL}
- Events: ${p.EVENTS.join(", ")}
- Active: ${p.ACTIVE}

## Identity limitation

GitHub webhooks are not uniquely keyed by URL — "multiple webhooks can
share the same config" per GitHub's own docs. \`check()\` matches on exact
URL + event-set equality as a best-effort proxy, which could false-positive
against an unrelated hook with an identical URL and event list. This is the
one place in this provider where ownership cannot be guaranteed by any
API-level mechanism GitHub exposes.

## Verification

Verified — re-read the webhook and confirmed its URL and active state match
what was requested.
`;
  },
});
