import { ModifyInstanceAttributeCommand } from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import {
  awsClients,
  describeInstance,
  startInstance,
  stopInstance,
  type Ec2InstanceStateName,
} from "../../../../../src/providers/aws";
import { retryWithBackoff } from "../../../../../src/core/wait";
import type { Params } from "../params";

/** AWS's capacity/availability error names — the only ones worth retrying a stuck restart against. */
function isCapacityError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return (
    name === "InsufficientInstanceCapacity" ||
    name === "InsufficientCapacityOnDemand" ||
    name === "Unsupported" ||
    /InsufficientInstanceCapacity|InsufficientCapacity/i.test(name)
  );
}

/**
 * The stop -> modify -> start orchestration. Both the stop and start legs go
 * through the shared helpers in `src/providers/aws/ec2.ts` — the same
 * functions `stop-start-instance` (task 3) uses — per the plan's
 * "intentional shared-helper reuse" resolution, not duplication.
 */
export const updateInstanceTypeStep: Step<Params> = {
  id: "update-instance-type",
  title: "Change the instance's type (stop, modify, start)",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const instance = await describeInstance(ec2, ctx.params.INSTANCE_ID);
    if (!instance) return "conflict"; // nothing to resize

    const state = instance.State?.Name as Ec2InstanceStateName | undefined;
    if (state === "terminated" || state === undefined) return "conflict";
    if (state === "pending" || state === "stopping" || state === "shutting-down") return "conflict";

    return instance.InstanceType === ctx.params.TARGET_INSTANCE_TYPE ? "exists" : "missing";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;

    // Captured before any mutation — needed for rollback in every case.
    const before = await describeInstance(ec2, instanceId);
    const originalInstanceType = before?.InstanceType;
    const originalState = before?.State?.Name as Ec2InstanceStateName | undefined;
    const wasOriginallyRunning = originalState === "running";

    if (originalState !== "stopped") {
      await stopInstance(ec2, instanceId, ctx.log);
    }

    await ec2.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: instanceId,
        InstanceType: { Value: ctx.params.TARGET_INSTANCE_TYPE },
      }),
    );
    const modifyAppliedThisRun = true;

    // Deliberate refinement over the plan's literal step 4 ("call the shared
    // start helper" unconditionally): only restart the instance if it was
    // originally running. Restarting an instance that was deliberately left
    // stopped before this run would be a surprising, unrequested side effect.
    if (wasOriginallyRunning) {
      await startInstance(ec2, instanceId, ctx.log);
    }

    const after = await describeInstance(ec2, instanceId);

    return {
      originalInstanceType,
      wasOriginallyRunning,
      modifyAppliedThisRun,
      newInstanceType: after?.InstanceType,
    };
  },

  /**
   * Three cases, per the plan:
   * 1. Rollback before ModifyInstanceAttribute ran — just restore the
   *    pre-run power state (start it back up if it was originally running;
   *    leave it stopped otherwise).
   * 2. Rollback after the modify succeeded — revert the type (the instance
   *    is still stopped, satisfying the precondition), then, only if it was
   *    originally running, attempt a bounded, capacity-error-aware retry of
   *    the restart.
   * 3. That bounded retry exhausted — the genuine, unresolvable risk: type
   *    is reverted but the instance could not be restarted. Log loudly and
   *    rethrow so the run still reports failure.
   */
  async rollback(ctx) {
    if (ctx.outputs.originalInstanceType === undefined) return; // untouched this run

    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;
    const originalInstanceType = ctx.outputs.originalInstanceType as string;
    const wasOriginallyRunning = ctx.outputs.wasOriginallyRunning === true;
    const modifyAppliedThisRun = ctx.outputs.modifyAppliedThisRun === true;

    if (!modifyAppliedThisRun) {
      // Case 1: stop may have run, but the type was never actually changed.
      if (wasOriginallyRunning) {
        await startInstance(ec2, instanceId, ctx.log);
      }
      return;
    }

    // Case 2: revert the type first — the instance is stopped at this point
    // whether or not the start leg ran, satisfying ModifyInstanceAttribute's
    // "must be stopped" precondition.
    await ec2.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: instanceId,
        InstanceType: { Value: originalInstanceType },
      }),
    );
    ctx.log.warn(`Reverted instance type on ${instanceId} back to ${originalInstanceType}`);

    if (!wasOriginallyRunning) return; // it was stopped before this run — leave it stopped

    try {
      await retryWithBackoff(() => startInstance(ec2, instanceId, ctx.log), {
        backoffsMs: [5_000, 15_000, 30_000],
        label: `restart ${instanceId} after rollback`,
        retryable: isCapacityError,
        log: ctx.log,
      });
    } catch (err) {
      // Case 3: the genuine, unresolvable risk — original type is no longer
      // available in this AZ (or some other persistent capacity issue).
      ctx.log.error(
        `Instance type on ${instanceId} was reverted to ${originalInstanceType}, but the ` +
          `instance could not be restarted — manual intervention required.`,
      );
      throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_ec2_instance",
      name: ctx.params.INSTANCE_ID,
      attributes: { instanceId: ctx.params.INSTANCE_ID, instanceType: ctx.params.TARGET_INSTANCE_TYPE },
    };
  },
};
