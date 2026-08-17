import {
  CreateVirtualMFADeviceCommand,
  DeleteVirtualMFADeviceCommand,
  ListMFADevicesCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients } from "../../../../../../src/providers/aws";
import { isNoSuchEntity } from "../../../../../../src/providers/aws/iam";
import type { Params } from "../params";

/**
 * Provisions a virtual MFA device for the user. This is as far as Ferry can
 * go unattended: `EnableMFADevice` requires two live, sequential TOTP codes
 * that only a human's authenticator app can produce, so this step's "done"
 * state is capped at "created", never "enabled" — a genuinely different
 * completion shape than every create()-based step elsewhere in this repo.
 *
 * check():
 * - any MFA device already associated with the user → "exists" (per AWS's
 *   own behavior, an unenabled virtual device created via
 *   CreateVirtualMFADevice does NOT appear in ListMFADevices until
 *   EnableMFADevice succeeds — so a device showing up here means a human
 *   already finished enablement, out of band or in an earlier run).
 * - no device, and PROVISION_VIRTUAL_DEVICE is false → "exists" (this half is
 *   opted out; nothing for this step to do).
 * - no device, and PROVISION_VIRTUAL_DEVICE is true → "missing" (proceed).
 */
export const mfaDeviceProvisionStep: Step<Params> = {
  id: "mfa-device-provision",
  title: "Provision virtual MFA device",

  async check(ctx) {
    const { iam } = awsClients(ctx);
    const userName = ctx.params.IAM_USER_NAME;

    const existing = await iam.send(new ListMFADevicesCommand({ UserName: userName }));
    if ((existing.MFADevices ?? []).length > 0) return "exists";

    if (!ctx.params.PROVISION_VIRTUAL_DEVICE) {
      ctx.log.info(
        `No MFA device registered for ${userName}, and PROVISION_VIRTUAL_DEVICE is false — ` +
          `this half of enforce-mfa is opted out. Nothing to do.`,
      );
      return "exists";
    }

    return "missing";
  },

  async create(ctx) {
    const { iam } = awsClients(ctx);
    const userName = ctx.params.IAM_USER_NAME;

    const created = await iam.send(
      new CreateVirtualMFADeviceCommand({ VirtualMFADeviceName: userName }),
    );
    const device = created.VirtualMFADevice;
    const serialNumber = device?.SerialNumber;
    if (!serialNumber) {
      throw new Error("CreateVirtualMFADevice did not return a SerialNumber");
    }

    const base32Seed = device.Base32StringSeed
      ? Buffer.from(device.Base32StringSeed).toString("utf-8")
      : undefined;

    // The QR is binary (PNG) and not useful printed to a terminal — the
    // Base32 seed is the practical thing to surface, mirroring how the
    // access-key secret is printed once to stdout and masked in the
    // persisted markdown.
    if (base32Seed) {
      console.log(`
  ── Virtual MFA device provisioned for ${userName} — seed shown once ──
  Serial number: ${serialNumber}
  Base32 seed:   ${base32Seed}

  This device is NOT YET ENABLED. Scan/enter the seed into an authenticator
  app, get two SEQUENTIAL codes, and call EnableMFADevice yourself (console,
  CLI, or a follow-up tool) to finish. Ferry cannot complete this step for you.
`);
    }

    ctx.log.warn(
      `MFA device ${serialNumber} provisioned but NOT YET ENABLED — EnableMFADevice requires two ` +
        `live authenticator codes only a human can produce. Have the user scan/enter the seed into ` +
        `their authenticator app, get two sequential codes, and call EnableMFADevice manually (or via ` +
        `a follow-up tool) to complete enablement. This integration cannot finish this step for you.`,
    );

    return {
      mfaDeviceSerialNumber: serialNumber,
      mfaDeviceProvisionedThisRun: true,
      mfaAwaitingHumanEnablement: true,
    };
  },

  async rollback(ctx) {
    const serialNumber = ctx.outputs.mfaDeviceSerialNumber as string | undefined;
    if (!serialNumber) return; // nothing created this run

    const { iam } = awsClients(ctx);
    const userName = ctx.params.IAM_USER_NAME;

    // If a human raced in and enabled it since, the device will now show up
    // associated to the user — destroying working MFA would be far worse
    // than leaving a rollback incomplete, so warn and leave it alone.
    try {
      const current = await iam.send(new ListMFADevicesCommand({ UserName: userName }));
      const enabled = (current.MFADevices ?? []).some((d) => d.SerialNumber === serialNumber);
      if (enabled) {
        ctx.log.warn(
          `MFA device ${serialNumber} is now enabled (a human must have completed EnableMFADevice ` +
            `since this run) — leaving it in place rather than deleting working MFA.`,
        );
        return;
      }
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }

    try {
      await iam.send(new DeleteVirtualMFADeviceCommand({ SerialNumber: serialNumber }));
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_virtual_mfa_device",
      name: ctx.params.IAM_USER_NAME,
      attributes: {
        serialNumber: String(ctx.outputs.mfaDeviceSerialNumber ?? ""),
        status: ctx.outputs.mfaAwaitingHumanEnablement ? "awaiting-human-enablement" : "enabled",
      },
    };
  },
};
