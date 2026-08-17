import { ListAttachedRolePoliciesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: AttachRolePolicy's own response carries nothing to confirm —
 * read the attachment list back instead, polled, since IAM attachment
 * visibility is eventually consistent across list APIs.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const { ROLE_NAME, POLICY_ARN } = ctx.params;

  const confirmed = await pollUntil(
    async () => {
      const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: ROLE_NAME }));
      return (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === POLICY_ARN);
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${POLICY_ARN} attached to ${ROLE_NAME}` },
  );
  if (!confirmed) {
    throw new Error(
      `${POLICY_ARN} did not confirm as attached to role ${ROLE_NAME} after attaching it`,
    );
  }
  ctx.log.success(`Confirmed ${POLICY_ARN} is attached to ${ROLE_NAME}`);
}
