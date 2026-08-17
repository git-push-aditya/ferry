import { ListAttachedUserPoliciesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients, isNoSuchEntity } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: read the attachment list back, polled — a user that has since
 * been deleted entirely also satisfies "the attachment is gone".
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const { IAM_USER_NAME, IAM_POLICY_ARN } = ctx.params;

  const confirmed = await pollUntil(
    async () => {
      try {
        const attached = await iam.send(
          new ListAttachedUserPoliciesCommand({ UserName: IAM_USER_NAME }),
        );
        return !(attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === IAM_POLICY_ARN);
      } catch (err) {
        if (isNoSuchEntity(err)) return true;
        throw err;
      }
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${IAM_POLICY_ARN} detached from ${IAM_USER_NAME}` },
  );
  if (!confirmed) {
    throw new Error(
      `${IAM_POLICY_ARN} did not confirm as detached from user ${IAM_USER_NAME} after detaching it`,
    );
  }
  ctx.log.success(`Confirmed ${IAM_POLICY_ARN} is detached from ${IAM_USER_NAME}`);
}
