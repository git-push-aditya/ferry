import { GetInstanceProfileCommand, GetRoleCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients, isNoSuchEntity } from "../../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const roleName = ctx.params.ROLE_NAME;

  let stillExists = true;
  try {
    await iam.send(new GetRoleCommand({ RoleName: roleName }));
  } catch (err) {
    if (!isNoSuchEntity(err)) throw err;
    stillExists = false;
  }
  if (stillExists) throw new Error(`IAM role ${roleName} still exists after the delete step`);
  ctx.log.success(`Confirmed ${roleName} no longer exists`);

  // Removing the role from an instance profile must never cascade-delete the
  // profile itself unless DELETE_INSTANCE_PROFILES_TOO explicitly asked for
  // that — confirm the untouched profiles are still there.
  if (!ctx.params.DELETE_INSTANCE_PROFILES_TOO) {
    const removedInstanceProfileNames =
      (ctx.outputs.removedInstanceProfileNames as string[] | undefined) ?? [];
    for (const profileName of removedInstanceProfileNames) {
      await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: profileName }));
      ctx.log.success(`Confirmed instance profile ${profileName} still exists independently`);
    }
  }
}
