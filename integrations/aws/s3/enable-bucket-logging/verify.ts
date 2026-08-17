import { GetBucketLoggingCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Config-round-trip proof only: log delivery is best-effort and asynchronous
 * (first logs can take hours per AWS's own guidance), so this cannot prove
 * logs are actually flowing — only that the configuration itself is set.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;

  const got = await s3.send(new GetBucketLoggingCommand({ Bucket: bucket }));
  const enabled = got.LoggingEnabled;

  if (
    enabled?.TargetBucket !== ctx.params.LOGGING_TARGET_BUCKET ||
    enabled?.TargetPrefix !== ctx.params.LOGGING_TARGET_PREFIX
  ) {
    throw new Error(`s3://${bucket} logging configuration does not match the desired target`);
  }
  ctx.log.success(
    `Confirmed logging config targets s3://${ctx.params.LOGGING_TARGET_BUCKET}/${ctx.params.LOGGING_TARGET_PREFIX} ` +
      `(config round-trip only — actual log delivery is best-effort and not verified same-run)`,
  );
}
