import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { mask } from "../../../src/core/report";
import { paramsSchema, targetOf, type Params } from "./params";
import { secretStep } from "./steps/secret";
import { verify } from "./verify";

/**
 * Replaces the former create-or-update-repo-secret, create-or-update-org-
 * secret and add-environment-secret. GitHub's Actions-secrets API is one API
 * at three scopes -- same public-key fetch, same sealed-box encryption, same
 * write-blind read -- and `SecretScope` in the provider already modelled that.
 * Three folders meant three copies of the libsodium handling, which is the
 * one genuinely fiddly part and the one worth owning exactly once.
 */
export default defineIntegration<Params>({
  id: "github/set-actions-secret",
  schemaVersion: 1,
  summary:
    "Encrypts and writes a repo, org or environment Actions secret via libsodium sealed-box, proven by confirming presence.",

  // FORCE_ROTATE arrives as a "true"/"false" string, and the schema carries a
  // superRefine — both make Input differ from Output, which z.ZodType<P>'s
  // same-Input-as-Output generic cannot model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["github"],

  steps: [secretStep],

  verify,

  reportName: (ctx) => `${targetOf(ctx.params).replace(/[/:]/g, "-")}-${ctx.params.SECRET_NAME}`,

  report(ctx) {
    const p = ctx.params;
    const orgBlock =
      p.SCOPE === "org"
        ? `- Visibility: \`${p.VISIBILITY}\`${
            p.VISIBILITY === "selected"
              ? `\n- Selected repository ids: \`${JSON.stringify(p.SELECTED_REPOSITORY_IDS)}\``
              : ""
          }\n`
        : "";

    return `# GitHub Actions Secret — \`${targetOf(p)}:${p.SECRET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/set-actions-secret\`.
> The secret value is never included in this report or in ferry's logs.

## GitHub

- Scope: \`${p.SCOPE}\`
- Target: \`${targetOf(p)}\`
- Secret name: \`${p.SECRET_NAME}\`
- Value (masked): \`${mask(p.SECRET_VALUE)}\`
${orgBlock}- Force-rotated this run: ${p.FORCE_ROTATE ? "yes" : "no"}

## Write-blind limitation

GitHub never returns a secret's value once written — this integration can
confirm the secret is present, but not that it holds the value you supplied.
Only a workflow run that reads it can prove that.${
      p.SCOPE === "org" ? " Org visibility, unlike the value, IS readable and was verified." : ""
    }
`;
  },
});
