import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  INSTANCE_ID: nonEmpty,

  // When true, check() reports "conflict" instead of "missing" if the
  // instance has an attached volume with DeleteOnTermination=false — a
  // straight terminate would detach and preserve it, but with no record of
  // the connection, so this errs toward "stop and ask" rather than
  // "warn and proceed".
  PRESERVE_VOLUME_CHECK: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
