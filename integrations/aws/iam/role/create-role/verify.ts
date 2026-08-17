import { GetRoleCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

async function currentTrustPolicy(ctx: StepContext<Params>): Promise<unknown> {
  const { iam } = awsClients(ctx);
  const got = await iam.send(new GetRoleCommand({ RoleName: ctx.params.ROLE_NAME }));
  const document = got.Role?.AssumeRolePolicyDocument;
  if (!document) throw new Error(`Could not read the trust policy of ${ctx.params.ROLE_NAME}`);
  return JSON.parse(decodeURIComponent(document));
}

/**
 * IAM read-after-write on a trust policy is eventually consistent, so this
 * polls for a few seconds before trusting a mismatch. If the poll still gives
 * up, one final GetRole is fetched and a real mismatch throws — verify()
 * failing must still unwind the whole run, not just warn and move on.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const desired = JSON.parse(ctx.params.TRUST_POLICY);
  const desiredJson = JSON.stringify(desired);

  let lastSeen: unknown;
  const confirmed = await pollUntil(
    async () => {
      lastSeen = await currentTrustPolicy(ctx);
      return JSON.stringify(lastSeen) === desiredJson;
    },
    { intervalMs: 2_000, timeoutMs: 10_000, label: `Trust policy on ${ctx.params.ROLE_NAME}` },
  );

  if (!confirmed) {
    lastSeen = await currentTrustPolicy(ctx);
    if (JSON.stringify(lastSeen) !== desiredJson) {
      throw new Error(
        `Trust policy on ${ctx.params.ROLE_NAME} does not match what was requested. ` +
          `Expected ${desiredJson}, got ${JSON.stringify(lastSeen)}`,
      );
    }
  }

  ctx.log.success(`Trust policy on ${ctx.params.ROLE_NAME} matches what was requested`);
}
