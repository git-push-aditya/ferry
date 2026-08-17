import { ListGroupsForUserCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: AddUserToGroup's own response carries nothing to confirm — read
 * the membership list back instead, polled, since IAM group-membership
 * visibility is eventually consistent across list APIs.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const { IAM_USER_NAME, IAM_GROUP_NAME } = ctx.params;

  const confirmed = await pollUntil(
    async () => {
      const groups = await iam.send(new ListGroupsForUserCommand({ UserName: IAM_USER_NAME }));
      return (groups.Groups ?? []).some((g) => g.GroupName === IAM_GROUP_NAME);
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${IAM_USER_NAME} member of ${IAM_GROUP_NAME}` },
  );
  if (!confirmed) {
    throw new Error(
      `${IAM_USER_NAME} did not confirm as a member of group ${IAM_GROUP_NAME} after adding it`,
    );
  }
  ctx.log.success(`Confirmed ${IAM_USER_NAME} is a member of ${IAM_GROUP_NAME}`);
}
