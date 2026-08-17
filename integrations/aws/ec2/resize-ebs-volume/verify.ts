import { DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import { GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Confirms the AWS-side resize live against the volume itself. If the
 * optional SSM in-OS-grow sub-step ran, also re-confirms that command's
 * final status — but if it was never configured, verify does NOT attempt to
 * check in-OS filesystem size at all (would require guest-OS introspection
 * this integration doesn't otherwise have), and says so plainly.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const { VOLUME_ID, TARGET_SIZE_GIB } = ctx.params;

  const described = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [VOLUME_ID] }));
  const volume = described.Volumes?.[0];
  if (!volume) throw new Error(`Volume ${VOLUME_ID} not found during verification`);
  if (volume.Size !== TARGET_SIZE_GIB) {
    throw new Error(
      `Expected volume ${VOLUME_ID} to report Size=${TARGET_SIZE_GIB}, found ${volume.Size ?? "(unknown)"}`,
    );
  }
  ctx.log.success(`Confirmed volume ${VOLUME_ID} reports Size=${TARGET_SIZE_GIB} GiB`);

  if (ctx.outputs.osResizePerformed) {
    const { ssm } = awsClients(ctx);
    const commandId = ctx.outputs.ssmCommandId as string | undefined;
    const instanceId = ctx.params.SSM_INSTANCE_ID;
    if (commandId && instanceId) {
      const invocation = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
      if (invocation.Status !== "Success") {
        throw new Error(
          `Expected SSM command ${commandId} to have status Success, found ${invocation.Status ?? "(unknown)"}`,
        );
      }
      ctx.log.success(`Re-confirmed SSM command ${commandId} status is Success`);
    }
  } else {
    ctx.log.info(
      "SSM sub-step was not configured — in-OS filesystem size was NOT checked or performed by this run.",
    );
  }
}
