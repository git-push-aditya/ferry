import { ListAccessKeysCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { StepContext } from "../../../../../src/core/define";
import { retryWithBackoff } from "../../../../../src/core/wait";
import { awsClients, isAssumeRoleDenied, isCredentialNotYetActive } from "../../../../../src/providers/aws";
import type { Params } from "./params";

const BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Phase A check: if a new key was minted this run, confirm it's actually
 * live with a real authenticated call — the same propagation-retry pattern
 * as create-backend-s3-user's verify.ts, since a freshly minted key reads as
 * denied for a few seconds after CreateAccessKey returns.
 *
 * Phase B check: if cutover ran (or had already converged), confirm the old
 * key now reads Inactive or is no longer listed at all (tolerant of it
 * having been deleted).
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const newAccessKeyId = ctx.outputs.newAccessKeyId as string | undefined;
  const newSecretAccessKey = ctx.outputs.newSecretAccessKey as string | undefined;
  const oldAccessKeyId = ctx.outputs.oldAccessKeyId as string | undefined;

  if (ctx.outputs.newKeyMintedThisRun && newAccessKeyId && newSecretAccessKey) {
    const scoped = new STSClient({
      region: awsClients(ctx).region,
      credentials: { accessKeyId: newAccessKeyId, secretAccessKey: newSecretAccessKey },
    });
    try {
      await retryWithBackoff(
        async () => {
          await scoped.send(new GetCallerIdentityCommand({}));
        },
        {
          backoffsMs: BACKOFFS_MS,
          label: "GetCallerIdentity with the new key denied — new IAM credentials may still be propagating",
          retryable: (err) => isCredentialNotYetActive(err) || isAssumeRoleDenied(err),
          log: ctx.log,
        },
      );
      ctx.log.success(`New key ${newAccessKeyId} authenticates successfully`);
    } finally {
      scoped.destroy();
    }
  } else {
    ctx.log.info("No key minted this run — Phase A propagation check skipped.");
  }

  if (oldAccessKeyId && (ctx.outputs.oldKeyDeactivatedThisRun || ctx.outputs.oldKeyDeletedThisRun)) {
    const { iam } = awsClients(ctx);
    const existing = await iam.send(
      new ListAccessKeysCommand({ UserName: ctx.params.IAM_USER_NAME }),
    );
    const oldKey = (existing.AccessKeyMetadata ?? []).find((k) => k.AccessKeyId === oldAccessKeyId);
    if (oldKey && oldKey.Status === "Active") {
      throw new Error(
        `Old key ${oldAccessKeyId} still reads Active after cutover — the deactivation did not take effect.`,
      );
    }
    ctx.log.success(
      oldKey
        ? `Old key ${oldAccessKeyId} confirmed Inactive`
        : `Old key ${oldAccessKeyId} confirmed no longer listed (deleted)`,
    );
  } else {
    ctx.log.info("No cutover performed this run — Phase B check skipped.");
  }
}
