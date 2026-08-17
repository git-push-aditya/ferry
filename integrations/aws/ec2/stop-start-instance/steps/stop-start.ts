import type { Step } from "../../../../../src/core/define";
import { awsClients, instanceStateName, startInstance, stopInstance } from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * A single two-way toggle step: `ACTION` picks the direction, and both
 * directions call the same shared stop/start helpers from
 * `src/providers/aws/ec2.ts` — the plan's "intentional shared-helper reuse"
 * with `update-instance-type` (task 12), not duplication.
 */
export const stopStartStep: Step<Params> = {
  id: "stop-start-instance",
  title: "Stop or start the instance",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;
    const state = await instanceStateName(ec2, instanceId);

    if (state === undefined || state === "terminated") return "conflict";
    if (state === "pending" || state === "stopping" || state === "shutting-down") return "conflict";

    if (ctx.params.ACTION === "stop") {
      return state === "running" ? "missing" : "exists"; // state === "stopped"
    }
    return state === "stopped" ? "missing" : "exists"; // state === "running"
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;

    // Captured before the transition so rollback knows which direction to reverse.
    const priorState = await instanceStateName(ec2, instanceId);

    if (ctx.params.ACTION === "stop") {
      await stopInstance(ec2, instanceId, ctx.log);
    } else {
      await startInstance(ec2, instanceId, ctx.log);
    }

    return { priorState, actionTakenThisRun: ctx.params.ACTION };
  },

  async rollback(ctx) {
    if (ctx.outputs.actionTakenThisRun === undefined) return; // untouched this run

    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;

    // Reverse whatever this run actually did, using the same shared helpers.
    if (ctx.outputs.actionTakenThisRun === "stop") {
      await startInstance(ec2, instanceId, ctx.log);
    } else {
      await stopInstance(ec2, instanceId, ctx.log);
    }
  },

  resource(ctx) {
    return {
      type: "aws_ec2_instance",
      name: ctx.params.INSTANCE_ID,
      attributes: { instanceId: ctx.params.INSTANCE_ID, action: ctx.params.ACTION },
    };
  },
};
