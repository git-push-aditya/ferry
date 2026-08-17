import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { mask } from "../../../src/core/report";
import { policyArn, roleArn, s3BucketStep, s3PrefixMarkerStep } from "../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { attachPolicyStep } from "./steps/attach-policy";
import { connectStep } from "./steps/connect";
import { descIntegrationStep } from "./steps/desc-integration";
import { iamPolicyStep } from "./steps/iam-policy";
import { iamRoleStep } from "./steps/iam-role";
import { stageStep } from "./steps/stage";
import { storageIntegrationStep } from "./steps/storage-integration";
import { trustPolicyStep } from "./steps/trust-policy";
import { verify } from "./verify";

/**
 * Snowflake ⇄ S3 storage integration.
 *
 * The step order encodes a circular dependency and is not rearrangeable:
 * the IAM role must exist before Snowflake will mint an external id, and the
 * role's real trust policy cannot be written until that external id exists.
 * See steps/trust-policy.ts.
 */
export default defineIntegration<Params>({
  id: "snowflake/create-storage-s3-integration",
  schemaVersion: 1,
  summary:
    "S3 bucket + prefix, IAM policy/role with Snowflake's trust policy, a Snowflake storage integration and external stage, proven with a live COPY INTO.",

  // ACCESS_MODE carries a zod default, so the .env-facing input (optional)
  // differs from the parsed output (required) — the same ZodEffects shape
  // aws/s3/create-bucket's params cast for, which z.ZodType<P>'s default
  // same-Input-as-Output generic doesn't model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws", "snowflake"],

  steps: [
    s3BucketStep<Params>({ bucket: (p) => p.EXPORT_S3_BUCKET }),
    s3PrefixMarkerStep<Params>({
      bucket: (p) => p.EXPORT_S3_BUCKET,
      prefix: (p) => p.EXPORT_S3_PREFIX,
    }),
    iamPolicyStep,
    iamRoleStep,
    attachPolicyStep,
    connectStep,
    storageIntegrationStep,
    descIntegrationStep,
    trustPolicyStep,
    stageStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.SF_STORAGE_INTEGRATION_NAME,

  report(ctx) {
    const p = ctx.params;
    const externalId = String(ctx.outputs.storageAwsExternalId ?? "");
    const iamUserArn = String(ctx.outputs.storageAwsIamUserArn ?? "");

    return `# Snowflake ⇄ S3 Integration — \`${p.SF_STORAGE_INTEGRATION_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/create-storage-s3-integration\`.
> The trust-policy external id is masked below — read the full value from
> \`DESC INTEGRATION ${p.SF_STORAGE_INTEGRATION_NAME}\` in Snowflake if you need it.

## S3

- Bucket: \`${p.EXPORT_S3_BUCKET}\`
- Prefix: \`${p.EXPORT_S3_PREFIX}\`

## AWS IAM

- Policy name: \`${p.AWS_STORAGE_POLICY_NAME}\`
- Policy ARN: \`${policyArn(ctx.accountId, p.AWS_STORAGE_POLICY_NAME)}\`
- Role name: \`${p.AWS_STORAGE_ROLE_NAME}\`
- Role ARN: \`${roleArn(ctx.accountId, p.AWS_STORAGE_ROLE_NAME)}\`
- Trust policy principal (Snowflake IAM user): \`${iamUserArn}\`
- Trust policy external id: \`${mask(externalId)}\`

## Snowflake

- Storage integration: \`${p.SF_STORAGE_INTEGRATION_NAME}\`
- Stage: \`${p.SF_STAGE_NAME}\`

## Verification

Verified — a test COPY landed a CSV under \`s3://${p.EXPORT_S3_BUCKET}/${p.EXPORT_S3_PREFIX}\` and was cleaned up.
`;
  },
});
