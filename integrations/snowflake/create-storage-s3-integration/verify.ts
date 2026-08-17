import type { StepContext } from "../../../src/core/define";
import { pollUntil } from "../../../src/core/wait";
import { awsClients, deleteKeys, isAssumeRoleDenied, listKeys } from "../../../src/providers/aws";
import { snowflakeClients } from "../../../src/providers/snowflake";
import type { Params } from "./params";
import { COPY_RETRY_BACKOFFS_MS, sleep } from "./waits";

const LANDING_POLL_INTERVAL_MS = 2_000;
const LANDING_POLL_TIMEOUT_MS = 30_000;

/**
 * Artifact G — the point of the whole tool.
 *
 * "Provisioned" means a CSV actually travelled Snowflake → assume-role → S3,
 * not that a handful of API calls returned 200. A failure here rolls the entire
 * run back, because half-working cross-cloud plumbing is worse than none.
 *
 * `ACCESS_MODE=read-only` gets a different proof: a read-only IAM policy
 * would correctly *deny* the write-side COPY INTO below, so treating that
 * denial as a verify failure would be wrong — the denial is the point being
 * verified. See `verifyReadOnly` for that variant.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  if (ctx.params.ACCESS_MODE === "read-only") {
    return verifyReadOnly(ctx);
  }

  const { s3 } = awsClients(ctx);
  const conn = await snowflakeClients(ctx).connection();
  const bucket = ctx.params.EXPORT_S3_BUCKET;
  const testPrefix = `${ctx.params.EXPORT_S3_PREFIX}setup_test`;

  // The trust policy may still be propagating even after the read-back
  // confirmed it — STS evaluates assume-role separately from GetRole. Retry
  // only on assume-role denials; anything else is a real error, not a wait.
  let lastErr: unknown;
  let copySucceeded = false;
  for (let attempt = 0; attempt <= COPY_RETRY_BACKOFFS_MS.length; attempt += 1) {
    try {
      await conn.runQuery(
        `COPY INTO @${ctx.params.SF_STAGE_NAME}/setup_test
            FROM (SELECT CURRENT_TIMESTAMP)
            FILE_FORMAT = (TYPE = CSV) HEADER = TRUE OVERWRITE = TRUE;`,
      );
      copySucceeded = true;
      break;
    } catch (err) {
      lastErr = err;
      if (!isAssumeRoleDenied(err) || attempt === COPY_RETRY_BACKOFFS_MS.length) throw err;
      ctx.log.warn(
        `COPY denied (attempt ${attempt + 1}), retrying in ${COPY_RETRY_BACKOFFS_MS[attempt]}ms — trust policy may still be propagating`,
      );
      await sleep(COPY_RETRY_BACKOFFS_MS[attempt]!);
    }
  }
  if (!copySucceeded) throw lastErr;
  ctx.log.success("Verification COPY succeeded");

  try {
    // Confirm from the AWS side that the object really exists — S3 list is
    // read-after-write consistent but the COPY returning is not proof on its own.
    let landed: string[] = [];
    const confirmed = await pollUntil(
      async () => {
        landed = await listKeys(s3, bucket, testPrefix);
        return landed.length > 0;
      },
      {
        intervalMs: LANDING_POLL_INTERVAL_MS,
        timeoutMs: LANDING_POLL_TIMEOUT_MS,
        label: "Verification object visible in S3",
      },
    );
    if (!confirmed) {
      throw new Error("Verification object did not land in S3 under the expected prefix");
    }
    ctx.log.info(`Found ${landed.length} verification object(s) in S3`);
  } finally {
    // Always sweep up, including when the confirmation failed — the COPY may
    // still have written something, and the bucket is not ours to litter in.
    const stray = await listKeys(s3, bucket, testPrefix);
    if (stray.length) {
      await deleteKeys(s3, bucket, stray);
      ctx.log.success("Verification object(s) removed");
    }
  }
}

/**
 * Read-only proof: confirm the role can read through the stage (a `LIST`
 * only needs `s3:ListBucket`/`s3:GetBucketLocation`, granted in both access
 * modes) and confirm a write attempt is actually rejected by AWS — proving
 * the restriction is enforced, not merely requested.
 *
 * No retry loop here: unlike the read-write path, a denial is the expected
 * outcome, not a transient propagation symptom to wait out.
 */
async function verifyReadOnly(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();

  await conn.runQuery(`LIST @${ctx.params.SF_STAGE_NAME};`);
  ctx.log.success("Verification LIST succeeded — read access confirmed");

  let writeWasDenied = false;
  try {
    await conn.runQuery(
      `COPY INTO @${ctx.params.SF_STAGE_NAME}/setup_test
          FROM (SELECT CURRENT_TIMESTAMP)
          FILE_FORMAT = (TYPE = CSV) HEADER = TRUE OVERWRITE = TRUE;`,
    );
  } catch (err) {
    if (!isAssumeRoleDenied(err)) throw err;
    writeWasDenied = true;
  }

  if (!writeWasDenied) {
    throw new Error(
      `ACCESS_MODE=read-only but the verification write succeeded — the IAM policy is not actually read-only`,
    );
  }
  ctx.log.success("Verification write was denied as expected — read-only scoping confirmed");
}
