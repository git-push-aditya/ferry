import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Folder .env values are always strings. Same "true"/"false" transform as
 * create-bucket's boolFlag, not zod's own boolean coercion (which accepts
 * things like "1" that would be confusing in a hand-edited .env).
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  ROLE_NAME: nonEmpty,
  // Only deletes an instance profile if, after removing this role, no other
  // roles remain attached to it — never deletes a profile shared with others.
  DELETE_INSTANCE_PROFILES_TOO: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
