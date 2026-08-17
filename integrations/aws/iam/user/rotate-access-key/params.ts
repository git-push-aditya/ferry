import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Folder .env values are always strings, so booleans/numbers are transformed
 * here rather than relying on zod's own coercion (see create-bucket/params.ts
 * for the same pattern with boolFlag).
 */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,

  /**
   * The required manual gate. Phase A (mint) always runs automatically —
   * it is purely additive and reversible. Phase B (deactivate + delete the
   * old key) only runs once a human has migrated every configured credential
   * to the new key and sets this to true.
   */
  CONFIRM_CUTOVER: boolFlag("false"),

  /**
   * Optional soak window between deactivating and deleting the old key, in
   * minutes. No real health-check callback exists to wire in, so this is a
   * plain sleep an operator can opt into — not a pollUntil.
   */
  ROTATION_SOAK_MINUTES: z
    .string()
    .optional()
    .default("0")
    .transform((v) => Number(v))
    .refine((v) => Number.isFinite(v) && v >= 0, "must be a non-negative number"),
});

export type Params = z.infer<typeof paramsSchema>;
