import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  VOLUME_ID: nonEmpty,
  INSTANCE_ID: nonEmpty,
  // e.g. "/dev/sdf". Not validated further — device naming conventions vary
  // by instance type/virtualization (Xen vs Nitro renames devices on boot).
  DEVICE: nonEmpty,
  ACTION: z.enum(["attach", "detach"]),
  // Maps directly to DetachVolume's own `Force` param. AWS's own docs call
  // this a "last resort" — see README — so it defaults off.
  FORCE: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
