import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Folder .env values are always strings. Same "true"/"false" transform as
 * delete-role's boolFlag — not zod's own boolean coercion (which accepts
 * things like "1" that would be confusing in a hand-edited .env).
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,
  // Hard human-confirmation gate, not a convenience flag: this permanently
  // destroys access keys, the login profile password, MFA devices and every
  // policy/group attachment with no recovery path. Defaults to false so a
  // .env copied without reading it cannot silently destroy credentials.
  ALLOW_DESTRUCTIVE_TEARDOWN: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
