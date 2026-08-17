import { GetBucketPolicyCommand, GetPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import { parsedPolicy, type Params } from "./params";

/**
 * Config-round-trip proof, not a live access check: confirming the exact
 * policy document is genuinely what a real principal can/can't do would need
 * an actual assume-role probe with a target identity this integration is not
 * given. That gap is stated plainly rather than papered over.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;
  const desired = parsedPolicy(ctx.params);

  if (desired !== undefined) {
    const policy = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    const actual = policy.Policy ? JSON.parse(policy.Policy) : undefined;
    if (JSON.stringify(actual) !== JSON.stringify(desired)) {
      throw new Error(`s3://${bucket} policy does not match the desired document`);
    }
    ctx.log.success("Confirmed bucket policy matches the desired document");
  }

  const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
  const wantBlocked = ctx.params.BLOCK_PUBLIC_ACCESS;
  const actual = pab.PublicAccessBlockConfiguration;
  const matches =
    actual?.BlockPublicAcls === wantBlocked &&
    actual?.IgnorePublicAcls === wantBlocked &&
    actual?.BlockPublicPolicy === wantBlocked &&
    actual?.RestrictPublicBuckets === wantBlocked;
  if (!matches) {
    throw new Error(
      `s3://${bucket} public access block does not match BLOCK_PUBLIC_ACCESS=${wantBlocked}`,
    );
  }
  ctx.log.success(`Confirmed public access block matches BLOCK_PUBLIC_ACCESS=${wantBlocked}`);
}
