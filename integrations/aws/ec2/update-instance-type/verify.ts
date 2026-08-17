import type { StepContext } from "../../../../src/core/define";
import { awsClients, describeInstance } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Live proof: re-reads the instance and confirms `InstanceType` matches the
 * target. The expected power state depends on what `create()` actually did —
 * `running` if the instance was originally running (and so was restarted),
 * `stopped` if it was originally stopped (and so was deliberately left
 * stopped) — read back from `wasOriginallyRunning` in outputs.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const instanceId = ctx.params.INSTANCE_ID;
  const instance = await describeInstance(ec2, instanceId);

  if (!instance) {
    throw new Error(`Instance ${instanceId} could not be read back after update`);
  }
  if (instance.InstanceType !== ctx.params.TARGET_INSTANCE_TYPE) {
    throw new Error(
      `Instance ${instanceId} has type "${instance.InstanceType}", expected "${ctx.params.TARGET_INSTANCE_TYPE}"`,
    );
  }

  const wasOriginallyRunning = ctx.outputs.wasOriginallyRunning === true;
  const expectedState = wasOriginallyRunning ? "running" : "stopped";
  if (instance.State?.Name !== expectedState) {
    throw new Error(
      `Instance ${instanceId} is "${instance.State?.Name}", expected "${expectedState}"`,
    );
  }

  ctx.log.success(
    `Confirmed instance ${instanceId} is type ${ctx.params.TARGET_INSTANCE_TYPE} and ${expectedState}`,
  );
}
