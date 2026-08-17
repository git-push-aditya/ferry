import { ListAccessKeysCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Confirms the target key's Status now reads Inactive.
 *
 * IAM writes are eventually consistent (see the plan's shared-groundwork
 * note), so this rides out a short poll rather than trusting a single read.
 *
 * NOTE: this integration is only ever handed the access key's id, never its
 * secret (deactivate-access-key has no reason to hold a secret — it targets a
 * key by id alone). A negative-control check — attempting a live call with the
 * key's own credentials and confirming it's now denied, the way
 * create-backend-s3-user checks the *positive* case — would need that secret,
 * which is never available here. So verification is limited to the control
 * plane (ListAccessKeys), not the data plane. If you need the stronger proof,
 * you already have the secret elsewhere (wherever it was originally minted);
 * this integration cannot fetch it — AWS never returns a secret after creation.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const userName = ctx.params.IAM_USER_NAME;
  const accessKeyId = ctx.params.ACCESS_KEY_ID;

  const confirmed = await pollUntil(
    async () => {
      const existing = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
      const key = (existing.AccessKeyMetadata ?? []).find((k) => k.AccessKeyId === accessKeyId);
      // Absent entirely also satisfies "not Active" — nothing left to deny.
      return !key || key.Status === "Inactive";
    },
    { intervalMs: 2_000, timeoutMs: 20_000, label: `Access key ${accessKeyId} status` },
  );

  if (!confirmed) {
    throw new Error(
      `Access key ${accessKeyId} on ${userName} did not read back as Inactive within the poll window.`,
    );
  }

  ctx.log.success(`Access key ${accessKeyId} confirmed Inactive`);
}
