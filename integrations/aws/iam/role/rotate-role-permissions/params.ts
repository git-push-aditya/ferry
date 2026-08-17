import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * DESIRED_POLICY_ARNS arrives as a comma-separated string, like every other
 * flat-string folder .env value, and is transformed into the array the step
 * actually works with. As with create-bucket's boolFlag, this .transform()
 * breaks z.ZodType<Params>'s default same-Input-as-Output assumption, so the
 * defineIntegration() call site casts it — see integration.ts for the note.
 */
export const paramsSchema = z.object({
  ROLE_NAME: nonEmpty,
  // The complete target set of managed-policy ARNs — not a delta. Comma-
  // separated, e.g. "arn:aws:iam::123:policy/A,arn:aws:iam::123:policy/B".
  DESIRED_POLICY_ARNS: nonEmpty.transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),
});

export type Params = z.infer<typeof paramsSchema>;
