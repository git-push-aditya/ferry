import { GetBucketVersioningCommand } from "@aws-sdk/client-s3";
import { GetRolePolicyCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../src/core/define";
import { pollUntil } from "../../../src/core/wait";
import { awsClients } from "../../../src/providers/aws";
import { inlinePolicyName, terraformBackendPolicyDocument, type Params } from "./params";

/** Confirms versioning reads back Enabled (polled) and the CI role's inline policy matches exactly. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3, iam } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;

  const confirmed = await pollUntil(
    async () => {
      const status = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      return status.Status === "Enabled";
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: "Bucket versioning reads back Enabled" },
  );
  if (!confirmed) {
    throw new Error(`s3://${bucket} versioning did not confirm as Enabled — required for Terraform's native S3 locking`);
  }

  const policy = await iam.send(
    new GetRolePolicyCommand({ RoleName: ctx.params.AWS_ROLE_NAME, PolicyName: inlinePolicyName() }),
  );
  const live = policy.PolicyDocument ? JSON.parse(decodeURIComponent(policy.PolicyDocument)) : null;
  const desired = terraformBackendPolicyDocument(bucket, ctx.params.STATE_KEY_PREFIX);
  if (JSON.stringify(live) !== JSON.stringify(desired)) {
    throw new Error(`Inline policy on "${ctx.params.AWS_ROLE_NAME}" does not match the desired backend document`);
  }

  ctx.log.success(`Confirmed s3://${bucket} versioning and the backend policy on "${ctx.params.AWS_ROLE_NAME}"`);
}
