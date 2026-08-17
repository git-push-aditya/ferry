import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * TRUST_POLICY is accepted as raw JSON text — the full desired
 * AssumeRolePolicyDocument — same shape as create-role's TRUST_POLICY.
 * Parsing it into a real document happens once, at the step-options call
 * site in integration.ts.
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
});

export type Params = z.infer<typeof paramsSchema>;

export function desiredTrustPolicy(params: Params): Record<string, unknown> {
  return JSON.parse(params.TRUST_POLICY) as Record<string, unknown>;
}
