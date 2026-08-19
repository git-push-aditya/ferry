import {
  GetBucketNotificationConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  type QueueConfiguration,
} from "@aws-sdk/client-s3";
import { requireOutput, type Step, type StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import { notificationEntryId, type Params } from "../params";

function desiredEntry(ctx: StepContext<Params>): QueueConfiguration {
  return {
    Id: notificationEntryId(ctx.params.SF_PIPE_NAME),
    QueueArn: requireOutput<string>(ctx, "notificationChannel"),
    Events: ["s3:ObjectCreated:*"],
    Filter: {
      Key: { FilterRules: [{ Name: "prefix", Value: ctx.params.S3_INGEST_PREFIX }] },
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * PutBucketNotificationConfiguration is a full-document-replace API, and a
 * bucket may already have unrelated notification rules (other pipelines,
 * other tools). This step always re-reads the current configuration, adds
 * or updates only the ONE QueueConfiguration entry it owns (matched by a
 * stable Id, see params.ts), and writes the merged result back — never a
 * blind "desired state" overwrite. Always reconciles (no create()): the
 * desired entry depends on the pipe's notification_channel, only known at
 * apply time.
 */
export const bucketNotificationStep: Step<Params> = {
  id: "bucket-notification",
  title: "Merge the pipe's queue into the bucket's event notifications",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;
    const entryId = notificationEntryId(ctx.params.SF_PIPE_NAME);
    const desired = desiredEntry(ctx);

    const current = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }));
    const otherQueues = (current.QueueConfigurations ?? []).filter((q) => q.Id !== entryId);
    const existingOwn = (current.QueueConfigurations ?? []).find((q) => q.Id === entryId);

    if (existingOwn && stableStringify(existingOwn) === stableStringify(desired)) {
      ctx.log.info(`Bucket notification entry "${entryId}" already matches the desired configuration`);
      return {};
    }

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          TopicConfigurations: current.TopicConfigurations,
          LambdaFunctionConfigurations: current.LambdaFunctionConfigurations,
          EventBridgeConfiguration: current.EventBridgeConfiguration,
          QueueConfigurations: [...otherQueues, desired],
        },
      }),
    );
    ctx.log.success(`Set bucket notification entry "${entryId}" on s3://${bucket}`);

    return { notificationEntryAddedThisRun: true };
  },

  /**
   * Removes only the one entry this integration owns, re-reading current
   * state fresh rather than restoring a stale captured snapshot — other
   * tools may have added their own entries in the interim.
   */
  async rollback(ctx) {
    if (ctx.outputs.notificationEntryAddedThisRun !== true) return;
    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;
    const entryId = notificationEntryId(ctx.params.SF_PIPE_NAME);

    const current = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }));
    const remaining = (current.QueueConfigurations ?? []).filter((q) => q.Id !== entryId);

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          TopicConfigurations: current.TopicConfigurations,
          LambdaFunctionConfigurations: current.LambdaFunctionConfigurations,
          EventBridgeConfiguration: current.EventBridgeConfiguration,
          QueueConfigurations: remaining,
        },
      }),
    );
  },

  resource(ctx) {
    return {
      type: "aws_s3_bucket_notification_entry",
      name: `${ctx.params.S3_BUCKET_NAME}:${notificationEntryId(ctx.params.SF_PIPE_NAME)}`,
      attributes: { bucket: ctx.params.S3_BUCKET_NAME, entryId: notificationEntryId(ctx.params.SF_PIPE_NAME) },
    };
  },
};
