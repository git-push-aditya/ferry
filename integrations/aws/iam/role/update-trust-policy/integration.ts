import { defineIntegration } from "../../../../../src/core/define";
import { iamRoleExistsGuardStep, roleArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { trustPolicyStep } from "./steps/trust-policy";
import { verify } from "./verify";

/**
 * Reconciles the trust policy on a role that already exists — does not
 * create the role. Run `aws/iam/role/create-role` first if it doesn't exist
 * yet. `UpdateAssumeRolePolicy` is a whole-document replace, so re-running
 * with the same document is a true no-op (a read, a compare, zero writes).
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/update-trust-policy",
  schemaVersion: 1,
  summary:
    "Reconciles an existing IAM role's trust policy to an exact desired document, proven with a read-back comparison.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.ROLE_NAME }),
    trustPolicyStep,
  ],

  verify,

  reportName: (ctx) => `${ctx.params.ROLE_NAME}-trust-policy`,

  report(ctx) {
    const p = ctx.params;
    const trustPolicy = JSON.parse(p.TRUST_POLICY);

    return `# Trust Policy — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/update-trust-policy\`.

## Role

- Role name: \`${p.ROLE_NAME}\` (\`${roleArn(ctx.accountId, p.ROLE_NAME)}\`)
- Changed this run: ${ctx.outputs.changed === true ? "yes" : "no (already matched)"}

## Desired trust policy

\`\`\`json
${JSON.stringify(trustPolicy, null, 2)}
\`\`\`

## Verification

Verified — re-read the role's trust policy and confirmed it structurally
matches the document above.
`;
  },
});
