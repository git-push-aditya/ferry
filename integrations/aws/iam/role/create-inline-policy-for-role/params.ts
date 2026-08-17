import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * POLICY_DOCUMENT is accepted as raw JSON text — the full desired inline
 * policy document under POLICY_NAME — same shape as update-trust-policy's
 * TRUST_POLICY. Parsing it into a real document happens once, at the
 * step-options call site in integration.ts.
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
  // The inline policy's own name — distinct from any managed policy name.
  POLICY_NAME: nonEmpty,
  POLICY_DOCUMENT: jsonDocument,
});

export type Params = z.infer<typeof paramsSchema>;

export function desiredPolicyDocument(params: Params): Record<string, unknown> {
  return JSON.parse(params.POLICY_DOCUMENT) as Record<string, unknown>;
}
