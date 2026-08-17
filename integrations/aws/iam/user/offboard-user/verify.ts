import { GetUserCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients, isNoSuchEntity } from "../../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const userName = ctx.params.IAM_USER_NAME;

  let stillExists = true;
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
  } catch (err) {
    if (!isNoSuchEntity(err)) throw err;
    stillExists = false;
  }

  if (stillExists) throw new Error(`IAM user "${userName}" still exists after the offboarding teardown step`);
  ctx.log.success(`Confirmed IAM user "${userName}" no longer exists`);
}
