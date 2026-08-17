import {
  DescribeVolumesCommand,
  DescribeVolumesModificationsCommand,
  ModifyVolumeCommand,
  type VolumeModification,
  type VolumeType,
} from "@aws-sdk/client-ec2";
import { GetCommandInvocationCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { FerryError } from "../../../../../src/core/errors";
import type { Step } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "../params";

const TERMINAL_SSM_FAILURE_STATUSES = new Set(["Failed", "Cancelled", "TimedOut"]);

async function describeVolume(
  ec2: ReturnType<typeof awsClients>["ec2"],
  volumeId: string,
) {
  const described = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
  const volume = described.Volumes?.[0];
  if (!volume) throw new Error(`Volume ${volumeId} not found`);
  return volume;
}

/** The in-flight modification for this volume, if any (undefined once none is reported). */
async function currentModification(
  ec2: ReturnType<typeof awsClients>["ec2"],
  volumeId: string,
): Promise<VolumeModification | undefined> {
  const described = await ec2.send(
    new DescribeVolumesModificationsCommand({ VolumeIds: [volumeId] }),
  );
  return described.VolumesModifications?.[0];
}

/**
 * Grows an EBS volume's size. Explicitly does NOT extend the in-OS
 * filesystem — that is a fundamentally separate, guest-OS-level action per
 * `ModifyVolume`'s own docs, which is why the optional SSM sub-step below is
 * opt-in, not automatic.
 */
export const resizeStep: Step<Params> = {
  id: "resize-ebs-volume",
  title: "Grow the EBS volume to the target size",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const { VOLUME_ID, TARGET_SIZE_GIB } = ctx.params;

    const volume = await describeVolume(ec2, VOLUME_ID);
    const currentSize = volume.Size ?? 0;

    if (TARGET_SIZE_GIB < currentSize) {
      // Not a runtime conflict — shrinking a volume isn't a valid EBS
      // operation at all, so this is a params-validation failure surfaced
      // up front, before any AWS call that would attempt it.
      throw new FerryError(
        `TARGET_SIZE_GIB (${TARGET_SIZE_GIB}) is smaller than the current volume size (${currentSize} GiB)`,
        [
          `Volume ${VOLUME_ID} is already ${currentSize} GiB.`,
          "EBS volumes can only grow via ModifyVolume — shrinking is not an operation the API supports.",
        ],
      );
    }

    if (currentSize >= TARGET_SIZE_GIB) return "exists";

    const modification = await currentModification(ec2, VOLUME_ID);
    if (
      modification &&
      (modification.ModificationState === "modifying" ||
        modification.ModificationState === "optimizing")
    ) {
      if (modification.TargetSize === TARGET_SIZE_GIB) {
        // Already converging on the size we want — treat as "missing" so
        // create() skips straight to polling it instead of erroring here.
        return "missing";
      }
      // A different resize is already in flight — ModifyVolume itself would
      // reject a second concurrent call, so abort in the plan phase instead.
      return "conflict";
    }

    return "missing";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const { VOLUME_ID, TARGET_SIZE_GIB, VOLUME_TYPE, IOPS, THROUGHPUT } = ctx.params;

    const before = await describeVolume(ec2, VOLUME_ID);
    const preResizeSize = before.Size ?? 0;

    const existingModification = await currentModification(ec2, VOLUME_ID);
    const alreadyTargeting =
      existingModification &&
      (existingModification.ModificationState === "modifying" ||
        existingModification.ModificationState === "optimizing") &&
      existingModification.TargetSize === TARGET_SIZE_GIB;

    if (!alreadyTargeting) {
      ctx.log.info(`Growing volume ${VOLUME_ID} from ${preResizeSize} GiB to ${TARGET_SIZE_GIB} GiB...`);
      await ec2.send(
        new ModifyVolumeCommand({
          VolumeId: VOLUME_ID,
          Size: TARGET_SIZE_GIB,
          VolumeType: VOLUME_TYPE as VolumeType | undefined,
          Iops: IOPS,
          Throughput: THROUGHPUT,
        }),
      );
    } else {
      ctx.log.info(
        `Volume ${VOLUME_ID} already has an in-flight modification targeting ${TARGET_SIZE_GIB} GiB — skipping ModifyVolume, polling the existing modification instead.`,
      );
    }

    // Judgment call (documented in the README too): "optimizing" is treated
    // as done-enough, matching the docs' own example of a fully usable
    // mid-flight state — Elastic Volumes changes apply without unmounting.
    // Waiting for "completed" instead is a legitimate, more conservative
    // alternative that would just add wait time for large volumes.
    let failure: string | undefined;
    await pollUntil(
      async () => {
        const modification = await currentModification(ec2, VOLUME_ID);
        if (modification?.ModificationState === "failed") {
          failure = modification.StatusMessage ?? "volume modification reported failed";
          return true; // stop polling; the throw below fires immediately after
        }
        return (
          modification?.ModificationState === "optimizing" ||
          modification?.ModificationState === "completed"
        );
      },
      { intervalMs: 5_000, timeoutMs: 10 * 60_000, label: `volume ${VOLUME_ID} resize to ${TARGET_SIZE_GIB} GiB` },
    );
    if (failure) throw new Error(`Resize of volume ${VOLUME_ID} failed: ${failure}`);

    ctx.log.success(`Volume ${VOLUME_ID} AWS-side resize to ${TARGET_SIZE_GIB} GiB confirmed`);

    const outputs: Record<string, unknown> = {
      volumeId: VOLUME_ID,
      preResizeSize,
      osResizePerformed: false,
    };

    // Stop here unless the optional SSM sub-step is fully configured. The
    // AWS-side resize is the honest end of what this integration does on its
    // own — filesystem growth is a separate, guest-OS-level action.
    const { SSM_DOCUMENT_NAME, SSM_INSTANCE_ID } = ctx.params;
    if (!SSM_DOCUMENT_NAME || !SSM_INSTANCE_ID) {
      ctx.log.info(
        "SSM_DOCUMENT_NAME/SSM_INSTANCE_ID not configured — filesystem growth inside the guest OS was NOT performed by this run.",
      );
      return outputs;
    }

    const { ssm } = awsClients(ctx);
    ctx.log.info(`Running SSM document ${SSM_DOCUMENT_NAME} on ${SSM_INSTANCE_ID} to grow the in-OS filesystem...`);
    const sent = await ssm.send(
      new SendCommandCommand({ InstanceIds: [SSM_INSTANCE_ID], DocumentName: SSM_DOCUMENT_NAME }),
    );
    const commandId = sent.Command?.CommandId;
    if (!commandId) throw new Error("SendCommand did not return a CommandId");

    let ssmFailure: string | undefined;
    await pollUntil(
      async () => {
        const invocation = await ssm.send(
          new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: SSM_INSTANCE_ID }),
        );
        const status = invocation.Status;
        if (status && TERMINAL_SSM_FAILURE_STATUSES.has(status)) {
          ssmFailure = `SSM command ${commandId} ended with status "${status}": ${invocation.StatusDetails ?? ""}`;
          return true;
        }
        return status === "Success";
      },
      { intervalMs: 5_000, timeoutMs: 10 * 60_000, label: `SSM command ${commandId} on ${SSM_INSTANCE_ID}` },
    );
    if (ssmFailure) throw new Error(ssmFailure);

    ctx.log.success(`SSM in-OS grow via ${SSM_DOCUMENT_NAME} on ${SSM_INSTANCE_ID} confirmed Success`);
    outputs.osResizePerformed = true;
    outputs.ssmCommandId = commandId;
    return outputs;
  },

  /**
   * There is no `ModifyVolume` "shrink back" — EBS volumes only grow via this
   * API, so once the resize reaches "optimizing"/"completed" there is no way
   * to undo the size increase. If the optional SSM in-OS-grow sub-step ran,
   * shrinking a live filesystem back down is its own hazardous operation this
   * project does not attempt either. No API calls here — just a loud warning,
   * same honest limitation as `delete-empty-bucket`'s rollback.
   */
  async rollback(ctx) {
    const volumeId = ctx.outputs.volumeId as string | undefined;
    ctx.log.warn(
      `Volume ${volumeId ?? ctx.params.VOLUME_ID} was grown to ${ctx.params.TARGET_SIZE_GIB} GiB — ` +
        `this size increase is PERMANENT and cannot be rolled back by this tool (EBS has no shrink API). ` +
        `${ctx.outputs.osResizePerformed ? "The in-OS filesystem grow performed via SSM is likewise not reversible." : ""}`,
    );
  },

  resource(ctx) {
    return {
      type: "aws_ebs_volume",
      name: ctx.params.VOLUME_ID,
      attributes: {
        volumeId: ctx.params.VOLUME_ID,
        size: String(ctx.params.TARGET_SIZE_GIB),
        osResizePerformed: String(ctx.outputs.osResizePerformed ?? false),
      },
    };
  },
};
