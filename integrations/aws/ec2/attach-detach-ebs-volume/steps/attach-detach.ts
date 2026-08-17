import {
  AttachVolumeCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  type Volume,
  type VolumeAttachment,
} from "@aws-sdk/client-ec2";
import type { Step, StepContext } from "../../../../../src/core/define";
import { awsClients, describeInstance } from "../../../../../src/providers/aws";
import { pollUntil } from "../../../../../src/core/wait";
import type { Params } from "../params";

async function describeVolume(ctx: StepContext<Params>): Promise<Volume | undefined> {
  const { ec2 } = awsClients(ctx);
  const described = await ec2.send(
    new DescribeVolumesCommand({ VolumeIds: [ctx.params.VOLUME_ID] }),
  );
  return described.Volumes?.[0];
}

/** The attachment entry, if any, whose InstanceId matches the given instance. */
function attachmentTo(volume: Volume | undefined, instanceId: string): VolumeAttachment | undefined {
  return volume?.Attachments?.find((a) => a.InstanceId === instanceId);
}

/** Is VOLUME_ID the given instance's root device volume? */
async function isRootVolume(ctx: StepContext<Params>): Promise<boolean> {
  const { ec2 } = awsClients(ctx);
  const instance = await describeInstance(ec2, ctx.params.INSTANCE_ID);
  const rootDeviceName = instance?.RootDeviceName;
  if (!rootDeviceName) return false;
  const rootMapping = instance?.BlockDeviceMappings?.find((m) => m.DeviceName === rootDeviceName);
  return rootMapping?.Ebs?.VolumeId === ctx.params.VOLUME_ID;
}

/**
 * Single toggle step, same shape as `stop-start-instance`: `ACTION` picks the
 * direction, both directions read/write the same volume/instance pair.
 * Attach/DetachVolume are not on EC2's idempotent-by-default list, so
 * idempotency is pushed entirely to check() — a re-run against a volume
 * already in the target attachment state is a clean skip.
 */
export const attachDetachStep: Step<Params> = {
  id: "attach-detach-ebs-volume",
  title: "Attach or detach the EBS volume",

  async check(ctx) {
    const volume = await describeVolume(ctx);
    if (!volume) return "conflict"; // volume doesn't exist at all

    const { INSTANCE_ID, DEVICE, ACTION } = ctx.params;
    const attachment = attachmentTo(volume, INSTANCE_ID);
    const attachedElsewhere = volume.Attachments?.find((a) => a.InstanceId !== INSTANCE_ID);

    if (ACTION === "attach") {
      if (attachment) {
        return attachment.Device === DEVICE ? "exists" : "conflict";
      }
      if (attachedElsewhere) return "conflict"; // attached to a different instance
      return "missing"; // available/unattached
    }

    // ACTION === "detach"
    if (!attachment) {
      if (attachedElsewhere) return "conflict"; // attached to a different instance than named
      return "exists"; // already detached/available
    }
    // Attached to the named instance. Detaching the root volume of a
    // running instance is a hard AWS constraint — flag it here, not just in
    // create(), so the plan phase surfaces it before any mutation.
    if (await isRootVolume(ctx)) {
      const { ec2 } = awsClients(ctx);
      const instance = await describeInstance(ec2, INSTANCE_ID);
      if (instance?.State?.Name === "running") return "conflict";
    }
    return "missing";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const { VOLUME_ID, INSTANCE_ID, DEVICE, ACTION, FORCE } = ctx.params;

    if (ACTION === "attach") {
      const volume = await describeVolume(ctx);
      const instance = await describeInstance(ec2, INSTANCE_ID);
      if (!instance) throw new Error(`Instance ${INSTANCE_ID} does not exist`);

      const volumeAz = volume?.AvailabilityZone;
      const instanceAz = instance.Placement?.AvailabilityZone;
      if (volumeAz && instanceAz && volumeAz !== instanceAz) {
        throw new Error(
          `Volume ${VOLUME_ID} is in ${volumeAz} but instance ${INSTANCE_ID} is in ${instanceAz} — ` +
            `AttachVolume requires the volume and instance to be in the same Availability Zone.`,
        );
      }

      const state = instance.State?.Name;
      if (state !== "running" && state !== "stopped") {
        throw new Error(
          `Instance ${INSTANCE_ID} is "${state}" — AttachVolume only accepts a "running" or "stopped" instance.`,
        );
      }

      await ec2.send(new AttachVolumeCommand({ VolumeId: VOLUME_ID, InstanceId: INSTANCE_ID, Device: DEVICE }));
      await pollUntil(
        async () => {
          const v = await describeVolume(ctx);
          return attachmentTo(v, INSTANCE_ID)?.State === "attached";
        },
        { intervalMs: 3_000, timeoutMs: 5 * 60_000, label: `${VOLUME_ID} attaching to ${INSTANCE_ID}` },
      );

      return { actionTakenThisRun: "attach", device: DEVICE };
    }

    // ACTION === "detach"
    const rootVolume = await isRootVolume(ctx);
    if (rootVolume) {
      const instance = await describeInstance(ec2, INSTANCE_ID);
      if (instance?.State?.Name !== "stopped") {
        throw new Error(
          `${VOLUME_ID} is the root volume of ${INSTANCE_ID} — it can't be detached while the ` +
            `instance is running. Stop the instance first (this should have been caught as a ` +
            `"conflict" during check()).`,
        );
      }
    }

    await ec2.send(
      new DetachVolumeCommand({ VolumeId: VOLUME_ID, InstanceId: INSTANCE_ID, Device: DEVICE, Force: FORCE }),
    );
    await pollUntil(
      async () => {
        const v = await describeVolume(ctx);
        const attachment = attachmentTo(v, INSTANCE_ID);
        return attachment === undefined && v?.State === "available";
      },
      { intervalMs: 3_000, timeoutMs: 5 * 60_000, label: `${VOLUME_ID} detaching from ${INSTANCE_ID}` },
    );

    return { actionTakenThisRun: "detach", device: DEVICE };
  },

  async rollback(ctx) {
    if (ctx.outputs.actionTakenThisRun === undefined) return; // untouched this run

    const { ec2 } = awsClients(ctx);
    const { VOLUME_ID, INSTANCE_ID } = ctx.params;
    const device = ctx.outputs.device as string;

    if (ctx.outputs.actionTakenThisRun === "attach") {
      await ec2.send(new DetachVolumeCommand({ VolumeId: VOLUME_ID, InstanceId: INSTANCE_ID, Device: device }));
    } else {
      await ec2.send(new AttachVolumeCommand({ VolumeId: VOLUME_ID, InstanceId: INSTANCE_ID, Device: device }));
    }
  },

  resource(ctx) {
    const { VOLUME_ID, INSTANCE_ID, DEVICE, ACTION } = ctx.params;
    return {
      type: "aws_ebs_volume_attachment",
      name: `${VOLUME_ID}:${INSTANCE_ID}`,
      attributes: { volumeId: VOLUME_ID, instanceId: INSTANCE_ID, device: DEVICE, action: ACTION },
    };
  },
};
