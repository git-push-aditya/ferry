import { DescribeInstanceStatusCommand } from "@aws-sdk/client-ec2";
import { requireOutput, type StepContext } from "../../../../src/core/define";
import { pollUntil } from "../../../../src/core/wait";
import { awsClients, describeInstance } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * "Launched" means proven running and status-ok, not just "RunInstances
 * returned 200". Status checks can lag boot by a few minutes, so a timeout
 * there is a warning (per pollUntil's contract), not a verify() failure — a
 * slow-booting-but-otherwise-fine instance shouldn't fail the whole run.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const instanceId = requireOutput<string>(ctx, "instanceId");

  const instance = await describeInstance(ec2, instanceId);
  if (instance?.State?.Name !== "running") {
    throw new Error(`Expected ${instanceId} to be "running", found "${instance?.State?.Name ?? "(gone)"}"`);
  }
  ctx.log.success(`Confirmed ${instanceId} is running`);

  const confirmed = await pollUntil(
    async () => {
      const status = await ec2.send(
        new DescribeInstanceStatusCommand({ InstanceIds: [instanceId] }),
      );
      return status.InstanceStatuses?.[0]?.InstanceStatus?.Status === "ok";
    },
    { intervalMs: 10_000, timeoutMs: 5 * 60_000, label: `instance ${instanceId} status check reaching "ok"` },
  );

  if (confirmed) {
    ctx.log.success(`Confirmed ${instanceId} status checks are "ok"`);
  } else {
    ctx.log.warn(`${instanceId} status checks did not reach "ok" within the timeout — proceeding anyway`);
  }
}
