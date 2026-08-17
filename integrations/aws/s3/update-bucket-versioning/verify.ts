import { GetBucketVersioningCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { pollUntil } from "../../../../src/core/wait";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

/** Live proof: read the bucket's own versioning state back, polled — not the PutBucketVersioning response, which is an empty 200 either way. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;
  const desired = ctx.params.DESIRED_VERSIONING_STATUS;

  const confirmed = await pollUntil(
    async () => {
      const status = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      return status.Status === desired;
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `Bucket versioning reads back ${desired}` },
  );
  if (!confirmed) {
    throw new Error(`s3://${bucket} versioning did not confirm as ${desired} after setting it`);
  }
  ctx.log.success(`Confirmed bucket versioning is ${desired}`);
}
