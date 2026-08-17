import type { StepContext } from "../../../../src/core/define";
import { awsClients, describeInstance } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * `DescribeInstances` keeps a terminated instance visible in the console (and
 * describable) for a short while before the record is dropped entirely — so
 * verify accepts either `State.Name == "terminated"` while still describable,
 * or the instance being gone outright, as equally valid confirmation.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const instanceId = ctx.params.INSTANCE_ID;

  const instance = await describeInstance(ec2, instanceId);
  if (instance !== undefined && instance.State?.Name !== "terminated") {
    throw new Error(`Expected ${instanceId} to be terminated, found "${instance.State?.Name ?? "(unknown)"}"`);
  }

  ctx.log.success(
    instance === undefined
      ? `Confirmed ${instanceId} is fully purged`
      : `Confirmed ${instanceId} is terminated`,
  );
}
