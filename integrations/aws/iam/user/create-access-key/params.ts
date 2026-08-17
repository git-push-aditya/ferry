import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Folder .env values are always strings, so the boolean escape hatch is
 * spelled "true"/"false" and transformed here rather than relying on zod's
 * own boolean coercion — same shape as create-bucket's boolFlag.
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,

  // Left false: a user already holding one key is left alone on re-run.
  // Flip to true to mint a second key for a rotation window — never a third;
  // AWS hard-caps at 2 regardless.
  ALLOW_SECOND_KEY: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
