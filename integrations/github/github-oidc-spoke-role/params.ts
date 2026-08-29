import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";

/** Comma-separated, like rotate-role-permissions' DESIRED_POLICY_ARNS — the complete target set, not a delta. */
const arnList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

export const paramsSchema = z.object({
  // The hub account's OIDC-trusted role ARN — from a single
  // github/setup-github-actions-oidc-role run against the hub account.
  // This integration never creates the hub role or the OIDC provider: an
  // IAM OIDC provider is account-scoped (confirmed against the
  // CreateOpenIDConnectProvider API reference), so a true multi-account
  // rollout can't share one provider object across accounts. See README.
  HUB_ROLE_ARN: nonEmpty,

  SPOKE_ROLE_NAME: nonEmpty,
  SPOKE_PERMISSION_POLICY_ARNS: arnList,
  ROLE_DESCRIPTION: z.string().optional(),
});

export type Params = z.infer<typeof paramsSchema>;

/**
 * Role-to-role trust, not OIDC-token trust — no Condition block, unlike
 * github/setup-github-actions-oidc-role's trust policy. The hub role is
 * the only OIDC-trusting principal in this chain; the hub assumes into
 * this spoke role via an ordinary sts:AssumeRole, a second hop the
 * workflow YAML performs explicitly (see README).
 */
export function spokeTrustPolicy(hubRoleArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: hubRoleArn },
        Action: "sts:AssumeRole",
      },
    ],
  };
}
