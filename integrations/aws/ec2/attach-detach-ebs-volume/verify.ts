import { DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

/** Live proof: read the volume's own attachments back and confirm the requested destination. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const { VOLUME_ID, INSTANCE_ID, DEVICE, ACTION } = ctx.params;

  const described = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [VOLUME_ID] }));
  const volume = described.Volumes?.[0];
  const attachment = volume?.Attachments?.find((a) => a.InstanceId === INSTANCE_ID);

  if (ACTION === "attach") {
    if (attachment?.State !== "attached" || attachment.Device !== DEVICE) {
      throw new Error(
        `Volume ${VOLUME_ID} is not attached to ${INSTANCE_ID} at ${DEVICE} ` +
          `(state: ${attachment?.State ?? "none"})`,
      );
    }
    ctx.log.success(`Confirmed ${VOLUME_ID} is attached to ${INSTANCE_ID} at ${DEVICE}`);
    return;
  }

  if (attachment !== undefined || volume?.State !== "available") {
    throw new Error(`Volume ${VOLUME_ID} is not detached from ${INSTANCE_ID} (state: ${volume?.State})`);
  }
  ctx.log.success(`Confirmed ${VOLUME_ID} is detached from ${INSTANCE_ID}`);
}
