import type { StepContext } from "../../../../src/core/define";
import { awsClients, instanceStateName } from "../../../../src/providers/aws";
import type { Params } from "./params";

/** Live proof: read the instance's own state back and confirm it reached the requested destination. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const instanceId = ctx.params.INSTANCE_ID;
  const destination = ctx.params.ACTION === "stop" ? "stopped" : "running";

  const state = await instanceStateName(ec2, instanceId);
  if (state !== destination) {
    throw new Error(`Instance ${instanceId} is "${state}", expected "${destination}"`);
  }
  ctx.log.success(`Confirmed instance ${instanceId} is ${destination}`);
}
