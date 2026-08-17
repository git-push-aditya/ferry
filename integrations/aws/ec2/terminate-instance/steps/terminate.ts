import { TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import { awsClients, describeInstance, pollInstanceState } from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Inverted create-or-skip, mirroring delete-empty-bucket: the target state is
 * *the instance being gone*, so "missing" means the terminate still needs to
 * happen, and "exists" means it's already achieved (terminated, or purged
 * entirely — a re-run after a successful terminate is a clean no-op).
 */
export const terminateStep: Step<Params> = {
  id: "terminate-instance",
  title: "Terminate the EC2 instance",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;

    const instance = await describeInstance(ec2, instanceId);
    if (!instance || instance.State?.Name === "terminated") return "exists";

    if (ctx.params.PRESERVE_VOLUME_CHECK) {
      const strandedVolume = (instance.BlockDeviceMappings ?? []).some(
        (mapping) => mapping.Ebs?.DeleteOnTermination === false,
      );
      if (strandedVolume) return "conflict";
    }

    return "missing";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;

    // Pre-terminate snapshot for the report only — never used for rollback,
    // since termination cannot be undone (see rollback() below).
    const before = await describeInstance(ec2, instanceId);
    const snapshot = {
      amiId: before?.ImageId ?? "",
      instanceType: before?.InstanceType ?? "",
      subnetId: before?.SubnetId ?? "",
      securityGroupIds: (before?.SecurityGroups ?? []).map((sg) => sg.GroupId ?? "").join(","),
      tags: JSON.stringify(
        Object.fromEntries((before?.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
      ),
    };

    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    ctx.log.info(`Terminating ${instanceId}, waiting for it to reach "terminated"...`);
    await pollInstanceState(ec2, instanceId, "terminated", { timeoutMs: 5 * 60_000 });
    ctx.log.success(`Instance ${instanceId} is terminated`);

    return {
      instanceId,
      terminatedThisRun: true,
      ...snapshot,
    };
  },

  /**
   * `terminated` is genuinely terminal — no API restores it, and a new
   * instance would get a new instanceId, so there is no meaningful undo.
   * This path is only reached when create() ran in this run and something
   * LATER in the same run failed, triggering an unwind; a run that only
   * found an already-terminated instance never reaches this.
   */
  async rollback(ctx) {
    if (ctx.outputs.terminatedThisRun !== true) return;
    const instanceId = ctx.outputs.instanceId as string;
    ctx.log.warn(
      `Termination is irreversible — instance ${instanceId} cannot be recovered. ` +
        `No rollback action was taken.`,
    );
  },

  resource(ctx) {
    return {
      type: "aws_ec2_instance",
      name: ctx.params.INSTANCE_ID,
      attributes: { instanceId: ctx.params.INSTANCE_ID, action: "terminated" },
    };
  },
};
