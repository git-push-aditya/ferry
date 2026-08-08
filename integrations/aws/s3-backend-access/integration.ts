import { defineIntegration } from "../../../src/core/define";
import { mask } from "../../../src/core/report";
import { policyArn, s3BucketStep, userArn } from "../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { accessKeyStep } from "./steps/access-key";
import { attachPolicyStep } from "./steps/attach-policy";
import { iamPolicyStep } from "./steps/iam-policy";
import { iamUserStep } from "./steps/iam-user";
import { verify } from "./verify";

/**
 * A least-privilege IAM user + access key so a backend service can read/write
 * the export bucket.
 *
 * Touches no Snowflake object and shares no IAM object with
 * `snowflake/s3-storage-integration` — the only overlap is the bucket, which
 * neither integration owns.
 */
export default defineIntegration<Params>({
  id: "aws/s3-backend-access",
  schemaVersion: 1,
  summary:
    "A least-privilege IAM user, policy and access key scoped to the export bucket, proven with a real write/read/delete through the new identity.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    s3BucketStep<Params>({ bucket: (p) => p.EXPORT_S3_BUCKET }),
    iamPolicyStep,
    iamUserStep,
    attachPolicyStep,
    accessKeyStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.BACKEND_IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const accessKeyId = String(ctx.outputs.backendAccessKeyId ?? "");
    const secret = String(ctx.outputs.backendSecretAccessKey ?? "");

    // The single point where the secret is surfaced: stdout, once, after the
    // run is known good. It is masked in the file below and written nowhere.
    if (secret) {
      console.log(`
  ── Runtime credentials for ${p.BACKEND_IAM_USER_NAME} — shown once, not saved ──
  AWS_ACCESS_KEY_ID=${accessKeyId}
  AWS_SECRET_ACCESS_KEY=${secret}

  Copy them into your backend's secret store now. ferry keeps no copy; if you
  lose it, delete the key in IAM and re-run.
`);
    }

    return `# Backend S3 IAM User — \`${p.BACKEND_IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3-backend-access\`.
> The secret access key is **masked** here and is written to no file — it was
> printed to stdout once, at the end of the run that created it.

## AWS IAM

- User name: \`${p.BACKEND_IAM_USER_NAME}\`
- User ARN: \`${userArn(ctx.accountId, p.BACKEND_IAM_USER_NAME)}\`
- Policy name: \`${p.BACKEND_IAM_POLICY_NAME}\`
- Policy ARN: \`${policyArn(ctx.accountId, p.BACKEND_IAM_POLICY_NAME)}\`

## S3

- Bucket: \`${p.EXPORT_S3_BUCKET}\`
- Prefix used for verification: \`${p.EXPORT_S3_PREFIX}\`

## Access key

- AWS_ACCESS_KEY_ID: \`${accessKeyId || "(not created this run — the user already held a key)"}\`
- AWS_SECRET_ACCESS_KEY: \`${secret ? mask(secret) : "(not created this run)"}\`

## Verification

${
  secret
    ? `Verified — wrote, read, listed and deleted an object under \`s3://${p.EXPORT_S3_BUCKET}/${p.EXPORT_S3_PREFIX}\` **as this user**, and confirmed \`s3:ListAllMyBuckets\` is denied.`
    : `NOT fully verified — no key was minted this run, so only the attached policy document was checked against the canonical artifact.`
}
`;
  },
});
