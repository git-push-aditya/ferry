import { GetBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import type { StepContext } from "../../../../src/core/define";
import { awsClients, isNotFound } from "../../../../src/providers/aws";
import { parsedRules, type Params } from "./params";

/**
 * Confirms the stored configuration round-trips correctly — that is the
 * limit of what can be proven same-run. Lifecycle actions (transitions,
 * expirations) are evaluated by AWS on its own schedule, not synchronously,
 * so this cannot prove a rule actually fires; that limitation is stated here
 * rather than papered over.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const desired = parsedRules(ctx.params);
  if (desired === undefined) {
    ctx.log.warn("LIFECYCLE_RULES_JSON not set this run — nothing to verify");
    return;
  }

  const { s3 } = awsClients(ctx);
  const bucket = ctx.params.S3_BUCKET_NAME;

  let actual: unknown[] = [];
  try {
    const got = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    actual = got.Rules ?? [];
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (JSON.stringify(actual) !== JSON.stringify(desired)) {
    throw new Error(
      `s3://${bucket} lifecycle configuration does not match the desired rule set`,
    );
  }
  ctx.log.success(
    `Confirmed ${desired.length} lifecycle rule(s) match the desired configuration ` +
      `(config round-trip only — actual expiration/transition behavior is not verified same-run)`,
  );
}
