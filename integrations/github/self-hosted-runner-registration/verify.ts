import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import type { StepContext } from "../../../src/core/define";
import { pollUntil } from "../../../src/core/wait";
import { awsClients } from "../../../src/providers/aws";
import { getRunner, githubClients, runnerScopeLabel } from "../../../src/providers/github";
import { runnerScope, type Params } from "./params";

/**
 * Two live proofs, in increasing order of strength:
 *
 *   1. the instance is running (AWS-side, fast)
 *   2. the runner has checked in and reports "online" (GitHub-side, slow)
 *
 * (2) is the one that actually matters. It is the only thing that proves the
 * whole chain worked -- instance profile attached, cloud-init ran, the JIT
 * config had not expired, and the agent reached GitHub. Nothing weaker
 * distinguishes "we launched a box" from "we have a working runner."
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const { rest } = githubClients(ctx);
  const scope = runnerScope(ctx.params);

  const instanceId = ctx.outputs.instanceId as string | undefined;
  if (instanceId) {
    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const state = described.Reservations?.[0]?.Instances?.[0]?.State?.Name;
    if (state !== "running") {
      throw new Error(`Expected ${instanceId} to be running after apply, found "${state}"`);
    }
    ctx.log.success(`Confirmed ${instanceId} is running`);
  }

  const runnerId = ctx.outputs.runnerId as number | undefined;
  if (runnerId === undefined) {
    // The registration step was skipped because the runner already existed;
    // there is no id from this run to poll. Say so rather than passing quietly.
    ctx.log.warn(
      `Runner "${ctx.params.RUNNER_NAME}" was already registered before this run — ` +
        `skipping the online check, since this run did not register it.`,
    );
    return;
  }

  // Bounded poll: boot + cloud-init + agent check-in. Ten minutes is generous
  // for a pre-baked AMI and still bounded, matching pollInstanceState's shape.
  const online = await pollUntil(
    async () => {
      const runner = await getRunner(rest, scope, runnerId);
      return runner?.status === "online";
    },
    { intervalMs: 10_000, timeoutMs: 10 * 60_000, label: `runner ${runnerId} coming online` },
  );

  if (!online) {
    const runner = await getRunner(rest, scope, runnerId);
    throw new Error(
      `Runner "${ctx.params.RUNNER_NAME}" (id ${runnerId}) on ${runnerScopeLabel(scope)} did not ` +
        `report "online" within 10 minutes — last seen "${runner?.status ?? "deregistered"}". ` +
        `The most common cause is the JIT config expiring before run.sh started: use an AMI with ` +
        `the runner binary pre-installed rather than installing it in UserData.`,
    );
  }
  ctx.log.success(`Confirmed runner ${runnerId} is online on ${runnerScopeLabel(scope)}`);
}
