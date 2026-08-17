import {
  DeleteBucketLifecycleCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import type { Step } from "../../../../../src/core/define";
import { awsClients, isNotFound } from "../../../../../src/providers/aws";
import { parsedRules, type Params } from "../params";

/**
 * PutBucketLifecycleConfiguration is a whole-document replace — AWS's own
 * docs: "this will overwrite an existing lifecycle configuration... they must
 * be included in the new lifecycle configuration" — so the full prior rule
 * set is captured for rollback, same shape as `s3EncryptionStep`.
 *
 * N rules live inside one atomic document/API call, not N independent
 * resources — a step-factory expanding into N steps would model something
 * that doesn't share one atomic replace/rollback unit the way these rules
 * actually do, so this is deliberately one step, not N.
 */
export const lifecycleStep: Step<Params> = {
  id: "bucket-lifecycle",
  title: "Reconcile bucket lifecycle rules",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const bucket = ctx.params.S3_BUCKET_NAME;
    const desired = parsedRules(ctx.params);

    if (desired === undefined) {
      ctx.log.info("LIFECYCLE_RULES_JSON not set — leaving lifecycle configuration untouched");
      return {};
    }

    const { s3 } = awsClients(ctx);
    let priorRules: unknown;
    try {
      const before = await s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
      );
      priorRules = before.Rules;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    if (desired.length === 0) {
      await s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
      ctx.log.success(`Cleared lifecycle configuration on s3://${bucket}`);
    } else {
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: desired },
        }),
      );
      ctx.log.success(`Set ${desired.length} lifecycle rule(s) on s3://${bucket}`);
    }

    return {
      hadPriorLifecycleConfig: priorRules !== undefined,
      priorLifecycleRulesJson: priorRules ? JSON.stringify(priorRules) : "",
    };
  },

  async rollback(ctx) {
    if (ctx.outputs.hadPriorLifecycleConfig === undefined) return; // untouched this run

    const { s3 } = awsClients(ctx);
    const bucket = ctx.params.S3_BUCKET_NAME;

    if (ctx.outputs.hadPriorLifecycleConfig === false) {
      await s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
      return;
    }

    await s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: JSON.parse(ctx.outputs.priorLifecycleRulesJson as string),
        },
      }),
    );
  },

  resource(ctx) {
    const desired = parsedRules(ctx.params);
    return {
      type: "aws_s3_bucket_lifecycle_configuration",
      name: ctx.params.S3_BUCKET_NAME,
      attributes: { ruleCount: String(desired?.length ?? 0) },
    };
  },
};
