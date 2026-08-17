import { ListAttachedRolePoliciesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients, isNoSuchEntity } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: read the attachment list back, polled — a role that has since
 * been deleted entirely also satisfies "the attachment is gone".
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const { ROLE_NAME, POLICY_ARN } = ctx.params;

  const confirmed = await pollUntil(
    async () => {
      try {
        const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: ROLE_NAME }));
        return !(attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === POLICY_ARN);
      } catch (err) {
        if (isNoSuchEntity(err)) return true;
        throw err;
      }
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${POLICY_ARN} detached from ${ROLE_NAME}` },
  );
  if (!confirmed) {
    throw new Error(
      `${POLICY_ARN} did not confirm as detached from role ${ROLE_NAME} after detaching it`,
    );
  }
  ctx.log.success(`Confirmed ${POLICY_ARN} is detached from ${ROLE_NAME}`);
}
