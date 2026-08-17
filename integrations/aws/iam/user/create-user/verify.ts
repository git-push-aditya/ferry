import { GetUserCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof, not just "the create call returned 200": re-reads the user and
 * confirms UserName still matches (guards against a race where a concurrent
 * process deleted it between apply and verify), and that any requested Path/
 * boundary actually reads back rather than trusting the request echoed it
 * correctly.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const userName = ctx.params.IAM_USER_NAME;

  const got = await iam.send(new GetUserCommand({ UserName: userName }));
  const user = got.User;
  if (!user || user.UserName !== userName) {
    throw new Error(`GetUser did not return a matching user for "${userName}"`);
  }
  ctx.log.success(`Confirmed IAM user "${userName}" exists`);

  if (ctx.params.IAM_USER_PATH && user.Path !== ctx.params.IAM_USER_PATH) {
    throw new Error(
      `Expected path "${ctx.params.IAM_USER_PATH}" but "${userName}" reads back as "${user.Path}"`,
    );
  }
  if (ctx.params.IAM_USER_PATH) {
    ctx.log.success(`Confirmed path matches "${ctx.params.IAM_USER_PATH}"`);
  }

  if (
    ctx.params.IAM_PERMISSIONS_BOUNDARY_ARN &&
    user.PermissionsBoundary?.PermissionsBoundaryArn !== ctx.params.IAM_PERMISSIONS_BOUNDARY_ARN
  ) {
    throw new Error(
      `Expected permissions boundary "${ctx.params.IAM_PERMISSIONS_BOUNDARY_ARN}" but "${userName}" ` +
        `reads back as "${user.PermissionsBoundary?.PermissionsBoundaryArn ?? "(none)"}"`,
    );
  }
  if (ctx.params.IAM_PERMISSIONS_BOUNDARY_ARN) {
    ctx.log.success(`Confirmed permissions boundary matches "${ctx.params.IAM_PERMISSIONS_BOUNDARY_ARN}"`);
  }
}
