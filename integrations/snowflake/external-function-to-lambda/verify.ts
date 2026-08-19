import type { StepContext } from "../../../src/core/define";
import { isAssumeRoleDenied } from "../../../src/providers/aws";
import { snowflakeClients } from "../../../src/providers/snowflake";
import { functionSignature, type Params } from "./params";

const RETRY_BACKOFFS_MS = [2_000, 5_000, 10_000];

/**
 * A real SELECT calling the function, confirming the round trip actually
 * reaches the Lambda and returns a value — same "prove data actually
 * moved" standard as create-storage-s3-integration's own verify(), not
 * merely confirming the DDL objects exist. Retries on an assume-role
 * denial specifically: the trust-policy patch may still be propagating
 * even after GetRole confirmed it, since STS evaluates AssumeRole
 * separately — the same propagation-lag reasoning that integration's
 * verify() already documents.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const args = ctx.params.SMOKE_TEST_ARGS.split(",")
    .map((s) => s.trim())
    .join(", ");

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt += 1) {
    try {
      const rows = await conn.runQuery(`SELECT ${ctx.params.SF_EXTERNAL_FUNCTION_NAME}(${args}) AS result;`);
      const result = rows[0]?.result ?? rows[0]?.RESULT;
      if (result === undefined || result === null) {
        throw new Error(`${functionSignature(ctx.params)} returned no result for the smoke-test call`);
      }
      ctx.log.success(`Verification call to "${functionSignature(ctx.params)}" returned: ${JSON.stringify(result)}`);
      return;
    } catch (err) {
      lastErr = err;
      if (!isAssumeRoleDenied(err) || attempt === RETRY_BACKOFFS_MS.length) throw err;
      ctx.log.warn(
        `Call denied (attempt ${attempt + 1}), retrying in ${RETRY_BACKOFFS_MS[attempt]}ms — trust policy may still be propagating`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFFS_MS[attempt]));
    }
  }
  throw lastErr;
}
