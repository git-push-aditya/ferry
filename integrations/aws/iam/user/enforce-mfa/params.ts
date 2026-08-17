import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * IAM_POLICY_ARN must be a customer-managed policy: AWS-managed policies
 * (arn:aws:iam::aws:policy/...) cannot have new versions created on them, and
 * the policy-condition half of this integration works by CreatePolicyVersion.
 * Ferry does not validate the ARN's managed-vs-customer origin at param time
 * (that requires an API call) — a bad ARN here surfaces as a clean AccessDenied/
 * NoSuchEntity at reconcile time instead.
 */
export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,
  IAM_POLICY_ARN: nonEmpty,
  MFA_CONDITION_MAX_AGE_SECONDS: z
    .string()
    .default("")
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), {
      message: "must be a positive number of seconds, or left empty",
    }),
  PROVISION_VIRTUAL_DEVICE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Params = z.infer<typeof paramsSchema>;
