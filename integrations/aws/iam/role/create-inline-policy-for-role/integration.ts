import { defineIntegration } from "../../../../../src/core/define";
import { iamRoleExistsGuardStep, roleArn } from "../../../../../src/providers/aws";
import { inlinePolicyStep } from "./steps/inline-policy";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

/**
 * Reconciles a named inline policy on a role that already exists — does not
 * create the role. Run `aws/iam/role/create-role` first if it doesn't exist
 * yet. `PutRolePolicy` is documented "adds or updates", so re-running with
 * the same name and document is a true no-op (a read, a compare, zero
 * writes); re-running with a changed document correctly converges to it.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/create-inline-policy-for-role",
  schemaVersion: 1,
  summary:
    "Reconciles a named inline policy on an existing IAM role to an exact desired document, proven with a read-back comparison.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.ROLE_NAME }),
    inlinePolicyStep,
  ],

  verify,

  reportName: (ctx) => `${ctx.params.ROLE_NAME}-${ctx.params.POLICY_NAME}`,

  report(ctx) {
    const p = ctx.params;
    const policyDocument = JSON.parse(p.POLICY_DOCUMENT);

    return `# Inline Policy — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/create-inline-policy-for-role\`.

## Role

- Role name: \`${p.ROLE_NAME}\` (\`${roleArn(ctx.accountId, p.ROLE_NAME)}\`)
- Inline policy name: \`${p.POLICY_NAME}\`
- Changed this run: ${ctx.outputs.changed === true ? "yes" : "no (already matched)"}

## Desired policy document

\`\`\`json
${JSON.stringify(policyDocument, null, 2)}
\`\`\`

## Verification

Verified — re-read the inline policy document and confirmed it structurally
matches the document above.
`;
  },
});
