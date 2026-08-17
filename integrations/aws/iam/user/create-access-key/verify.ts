import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { StepContext } from "../../../../../src/core/define";
import { retryWithBackoff } from "../../../../../src/core/wait";
import { awsClients, isCredentialNotYetActive } from "../../../../../src/providers/aws";
import type { Params } from "./params";

const BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * A newly minted access key is not usable the instant IAM returns it — STS
 * (like S3) can reject it as unknown or mis-signed for a few seconds. Retry
 * only on that propagation window; a genuine credential problem still fails
 * fast. Simpler than create-backend-s3-user's verify.ts since there is no S3
 * bucket to touch here — the live proof is just sts:GetCallerIdentity.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const accessKeyId = ctx.outputs.accessKeyId as string | undefined;
  const secretAccessKey = ctx.outputs.secretAccessKey as string | undefined;

  if (!accessKeyId || !secretAccessKey) {
    // No key was minted this run — the user already held one and
    // ALLOW_SECOND_KEY is false, so there is no new identity to exercise.
    ctx.log.warn(
      "No access key was created this run, so the live sts:GetCallerIdentity check was skipped. " +
        "Set ALLOW_SECOND_KEY=true to mint a second key, or delete the existing key in IAM and re-run.",
    );
    return;
  }

  const scoped = new STSClient({
    region: awsClients(ctx).region,
    credentials: { accessKeyId, secretAccessKey },
  });

  try {
    const identity = await retryWithBackoff(
      () => scoped.send(new GetCallerIdentityCommand({})),
      {
        backoffsMs: BACKOFFS_MS,
        label: "sts:GetCallerIdentity denied — new IAM credentials may still be propagating",
        retryable: (err) => isCredentialNotYetActive(err),
        log: ctx.log,
      },
    );

    if (!identity.Arn?.endsWith(`user/${ctx.params.IAM_USER_NAME}`)) {
      throw new Error(
        `sts:GetCallerIdentity returned "${identity.Arn}" — expected it to identify user ` +
          `"${ctx.params.IAM_USER_NAME}"`,
      );
    }
    ctx.log.success(`Confirmed the new key authenticates as ${identity.Arn}`);
  } finally {
    scoped.destroy();
  }
}
