import { GetBucketLoggingCommand, PutBucketLoggingCommand } from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Real precondition this cannot enforce: the target bucket must already grant
 * the S3 log-delivery principal write permission via its own bucket policy
 * (e.g. via `aws/s3/update-bucket-permissions`) — AWS accepts this call
 * regardless and silently delivers nothing if that grant is missing. Stated
 * in the README rather than checked here, since checking it correctly would
 * mean re-deriving AWS's own log-delivery policy rules.
 *
 * Always reconciles (no create()): the desired target depends on params.
 */
export const loggingStep: Step<Params> = {
  id: "bucket-logging",
  title: "Reconcile bucket logging",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;

    const before = await s3.send(new GetBucketLoggingCommand({ Bucket: bucket }));
    const prior = before.LoggingEnabled;

    await s3.send(
      new PutBucketLoggingCommand({
        Bucket: bucket,
        BucketLoggingStatus: {
          LoggingEnabled: {
            TargetBucket: ctx.params.LOGGING_TARGET_BUCKET,
            TargetPrefix: ctx.params.LOGGING_TARGET_PREFIX,
          },
        },
      }),
    );
    ctx.log.success(
      `Enabled logging on s3://${bucket} to s3://${ctx.params.LOGGING_TARGET_BUCKET}/${ctx.params.LOGGING_TARGET_PREFIX}`,
    );

    return {
      hadPriorLogging: prior !== undefined,
      priorLoggingJson: prior ? JSON.stringify(prior) : "",
    };
  },

  async rollback(ctx) {
    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;

    if (ctx.outputs.hadPriorLogging === false) {
      await s3.send(new PutBucketLoggingCommand({ Bucket: bucket, BucketLoggingStatus: {} }));
      return;
    }

    await s3.send(
      new PutBucketLoggingCommand({
        Bucket: bucket,
        BucketLoggingStatus: {
          LoggingEnabled: JSON.parse(ctx.outputs.priorLoggingJson as string),
        },
      }),
    );
  },

  resource(ctx) {
    return {
      type: "aws_s3_bucket_logging",
      name: ctx.params.S3_BUCKET_NAME,
      attributes: {
        targetBucket: ctx.params.LOGGING_TARGET_BUCKET,
        targetPrefix: ctx.params.LOGGING_TARGET_PREFIX,
      },
    };
  },
};
