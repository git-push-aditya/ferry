import { defineIntegration } from "../../../src/core/define";
import { iamInlinePolicyStep, iamRoleExistsGuardStep, s3BucketStep, s3VersioningStep } from "../../../src/providers/aws";
import { inlinePolicyName, paramsSchema, terraformBackendPolicyDocument, type Params } from "./params";
import { verify } from "./verify";

/**
 * S3-only, deliberately: Terraform 1.10 (Nov 2024) added native state
 * locking via conditional writes to a lock file inside the same bucket
 * (`use_lockfile = true`) and has since deprecated the dynamodb_table
 * backend option. Shipping this as "S3 + DynamoDB, always" in 2026 would
 * itself be the kind of outdated setup this project exists to replace —
 * see README.
 *
 * Almost entirely composition: every step here is an existing generic
 * factory (s3BucketStep, s3VersioningStep, iamInlinePolicyStep). The only
 * task-specific piece is the backend policy document in params.ts.
 */
export default defineIntegration<Params>({
  id: "github/terraform-state-backend-for-actions",
  schemaVersion: 1,
  summary:
    "Provisions a versioned S3 bucket for Terraform/OpenTofu state (native S3 locking, no DynamoDB) and grants an existing GitHub Actions OIDC role scoped access to it.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.AWS_ROLE_NAME }),
    s3BucketStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }),
    s3VersioningStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME, desired: () => "Enabled" }),
    iamInlinePolicyStep<Params>({
      roleName: (p) => p.AWS_ROLE_NAME,
      policyName: () => inlinePolicyName(),
      document: (ctx) => terraformBackendPolicyDocument(ctx.params.S3_BUCKET_NAME, ctx.params.STATE_KEY_PREFIX),
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Terraform State Backend for GitHub Actions — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/terraform-state-backend-for-actions\`.

## S3

- Bucket: \`${p.S3_BUCKET_NAME}\` (versioning: Enabled)
- State key prefix: \`${p.STATE_KEY_PREFIX}\`

## IAM

- Role: \`${p.AWS_ROLE_NAME}\` (pre-existing — this task does not create it)
- Inline policy: \`${inlinePolicyName()}\`

## Backend configuration

\`\`\`hcl
terraform {
  backend "s3" {
    bucket       = "${p.S3_BUCKET_NAME}"
    key          = "${p.STATE_KEY_PREFIX}/terraform.tfstate"
    region       = "<your-region>"
    use_lockfile = true
  }
}
\`\`\`

No DynamoDB lock table — Terraform 1.10+'s native S3 locking (conditional
writes) covers it; \`dynamodb_table\` is on a deprecation path.

## Verification

Verified — confirmed versioning reads back \`Enabled\` and the role's
inline policy matches the desired document exactly.
`;
  },
});
