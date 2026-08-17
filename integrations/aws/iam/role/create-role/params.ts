import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * TRUST_POLICY is accepted as raw JSON text — one param holding the full
 * AssumeRolePolicyDocument — rather than a typed union of trust-policy
 * shapes. Parsing it into a real document happens once, at the step-options
 * call site in integration.ts.
 */
const jsonDocument = nonEmpty.refine((v) => {
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}, "must be valid JSON");

export const paramsSchema = z.object({
  ROLE_NAME: nonEmpty,
  TRUST_POLICY: jsonDocument,
  PATH: z.string().optional(),
  DESCRIPTION: z.string().optional(),
  MAX_SESSION_DURATION_SECONDS: z.coerce
    .number()
    .int()
    .min(3600, "must be at least 3600")
    .max(43200, "must be at most 43200")
    .optional(),
  PERMISSIONS_BOUNDARY_ARN: z.string().optional(),
});

export type Params = z.infer<typeof paramsSchema>;
