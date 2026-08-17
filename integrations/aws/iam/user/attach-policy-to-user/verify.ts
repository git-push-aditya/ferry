import { ListAttachedUserPoliciesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: AttachUserPolicy's own response carries nothing to confirm —
 * read the attachment list back instead, polled, since IAM attachment
 * visibility is eventually consistent across list APIs.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const { IAM_USER_NAME, IAM_POLICY_ARN } = ctx.params;

  const confirmed = await pollUntil(
    async () => {
      const attached = await iam.send(
        new ListAttachedUserPoliciesCommand({ UserName: IAM_USER_NAME }),
      );
      return (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === IAM_POLICY_ARN);
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${IAM_POLICY_ARN} attached to ${IAM_USER_NAME}` },
  );
  if (!confirmed) {
    throw new Error(
      `${IAM_POLICY_ARN} did not confirm as attached to user ${IAM_USER_NAME} after attaching it`,
    );
  }
  ctx.log.success(`Confirmed ${IAM_POLICY_ARN} is attached to ${IAM_USER_NAME}`);
}
