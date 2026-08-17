import { ListGroupsForUserCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients, isNoSuchEntity } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: read the membership list back, polled — a user that has since
 * been deleted entirely also satisfies "not a member of the group".
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const { IAM_USER_NAME, IAM_GROUP_NAME } = ctx.params;

  const confirmed = await pollUntil(
    async () => {
      try {
        const groups = await iam.send(new ListGroupsForUserCommand({ UserName: IAM_USER_NAME }));
        return !(groups.Groups ?? []).some((g) => g.GroupName === IAM_GROUP_NAME);
      } catch (err) {
        if (isNoSuchEntity(err)) return true;
        throw err;
      }
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${IAM_USER_NAME} removed from ${IAM_GROUP_NAME}` },
  );
  if (!confirmed) {
    throw new Error(
      `${IAM_USER_NAME} did not confirm as removed from group ${IAM_GROUP_NAME} after removing it`,
    );
  }
  ctx.log.success(`Confirmed ${IAM_USER_NAME} is no longer a member of ${IAM_GROUP_NAME}`);
}
