import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { resizeStep } from "./steps/resize";
import { verify } from "./verify";

/**
 * Grows an EBS volume's size. The AWS-side resize (ModifyVolume) and the
 * in-OS filesystem growth are two separate concerns per AWS's own docs — this
 * integration only does the former by default, and only touches the guest OS
 * via an explicitly-configured, opt-in SSM Run Command sub-step.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/resize-ebs-volume",
  schemaVersion: 1,
  summary:
    "Grows an EBS volume to a target size; optionally extends the in-OS filesystem via SSM Run Command if explicitly configured.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [resizeStep],

  verify,

  reportName: (ctx) => ctx.params.VOLUME_ID,

  report(ctx) {
    const p = ctx.params;
    const osResizePerformed = Boolean(ctx.outputs.osResizePerformed);
    return `# EBS Volume Resize — \`${p.VOLUME_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/resize-ebs-volume\`.

## Volume

- Id: \`${p.VOLUME_ID}\`
- Pre-resize size: \`${ctx.outputs.preResizeSize ?? "(unknown)"}\` GiB
- Target size: \`${p.TARGET_SIZE_GIB}\` GiB

## In-OS filesystem growth

${
  osResizePerformed
    ? `Performed via SSM document \`${p.SSM_DOCUMENT_NAME}\` against instance \`${p.SSM_INSTANCE_ID}\`, command \`${ctx.outputs.ssmCommandId ?? "(unknown)"}\`, confirmed Success.`
    : "**NOT performed.** AWS-side resize only. Extending the partition/filesystem inside the guest OS is a separate, subsequent action (growpart/resize2fs/xfs_growfs on Linux, Disk Management on Windows) that this run did not take — configure SSM_DOCUMENT_NAME + SSM_INSTANCE_ID to opt into it."
}

## Verification

Verified — confirmed the volume's reported \`Size\` equals the target. ${
      osResizePerformed
        ? "Also re-confirmed the SSM command's final status was Success."
        : "In-OS filesystem size was NOT checked (out of scope without the SSM sub-step)."
    }

## Rollback

**Permanent.** EBS has no shrink API — if this run grew the volume, that
growth cannot be undone by this tool.
`;
  },
});
