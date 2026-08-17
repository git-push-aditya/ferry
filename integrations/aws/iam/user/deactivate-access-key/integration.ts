import { defineIntegration } from "../../../../../src/core/define";
import { iamAccessKeyStatusStep, userArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Deactivates a single named access key on an existing IAM user.
 *
 * Fully reversible: unlike delete, `UpdateAccessKey` can flip the key back to
 * `Active` at any time, which is exactly why AWS's own rotation guidance
 * recommends deactivate-then-soak before ever deleting a key. This integration
 * only ever deactivates — it never deletes anything.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/deactivate-access-key",
  schemaVersion: 1,
  summary:
    "Deactivates a specific IAM access key (Status -> Inactive), fully reversible via re-run or manual UpdateAccessKey.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamAccessKeyStatusStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      accessKeyId: (p) => p.ACCESS_KEY_ID,
      desired: () => "Inactive",
    }),
  ],

  verify,

  reportName: (ctx) => `${ctx.params.IAM_USER_NAME}-${ctx.params.ACCESS_KEY_ID}`,

  report(ctx) {
    const p = ctx.params;
    return `# Deactivate Access Key — \`${p.ACCESS_KEY_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/deactivate-access-key\`.

## Target

- User: \`${p.IAM_USER_NAME}\` (${userArn(ctx.accountId, p.IAM_USER_NAME)})
- Access key: \`${p.ACCESS_KEY_ID}\`
- Desired status: \`Inactive\`

## Reversibility

This is **fully reversible**. Unlike deleting a key, deactivating one can be
undone at any time — either re-run this integration after manually flipping
the key back to \`Active\` in IAM, or call \`UpdateAccessKey\` directly. Ferry's
own rollback (if this run fails partway through a larger chain) restores the
key's prior status automatically.

## Verification

Confirmed via \`ListAccessKeys\` that the key's status now reads \`Inactive\`
(with a short propagation-tolerant retry, since IAM writes are eventually
consistent). This integration never held the key's secret — only its id —
so the negative-control check (attempting a call with the key's own
credentials and confirming it's denied) is skipped; see \`verify.ts\` for
details.
`;
  },
});
