import { GetRoleCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/** Confirms the role exists and lives under the service-linked-role path. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const roleName = ctx.params.EXPECTED_ROLE_NAME;

  const got = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  const path = got.Role?.Path;
  if (!path || !path.startsWith("/aws-service-role/")) {
    throw new Error(
      `${roleName} exists but its Path ("${path ?? "unknown"}") does not start with "/aws-service-role/" — this may not be a service-linked role.`,
    );
  }

  ctx.log.success(`Confirmed ${roleName} exists under ${path}`);
}
