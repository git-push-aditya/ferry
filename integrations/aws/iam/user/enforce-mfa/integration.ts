import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { iamUserExistsGuardStep } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { mfaDeviceProvisionStep } from "./steps/mfa-device-provision";
import { mfaPolicyConditionStep } from "./steps/mfa-policy-condition";
import { verify } from "./verify";

/**
 * There is no "require MFA" attribute on an IAM user — enforcement is a
 * policy Condition mechanism. This integration is honestly two independent
 * halves:
 *
 * 1. mfa-device-provision — creates a virtual MFA device, but can only reach
 *    "awaiting human enablement", never a clean "enabled" state, since
 *    EnableMFADevice needs two live TOTP codes only a human can produce.
 * 2. mfa-policy-condition — adds aws:MultiFactorAuthPresent (and optionally
 *    aws:MultiFactorAuthAge) to every statement of a customer-managed
 *    policy's default version. This half alone is a clean, fully automatable
 *    convergence.
 *
 * See README.md for the load-bearing caveat: long-term IAM user access keys
 * never carry MFA session context, so this policy condition only constrains
 * callers using STS temporary credentials (GetSessionToken/AssumeRole).
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/enforce-mfa",
  schemaVersion: 1,
  summary:
    "Adds an MFA policy Condition to a customer-managed policy and provisions (but cannot enable) a virtual MFA device for an existing IAM user.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    iamUserExistsGuardStep<Params>({ userName: (p) => p.IAM_USER_NAME }),
    mfaDeviceProvisionStep,
    mfaPolicyConditionStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const serialNumber = String(ctx.outputs.mfaDeviceSerialNumber ?? "");
    const awaitingEnablement = Boolean(ctx.outputs.mfaAwaitingHumanEnablement);

    return `# Enforce MFA — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/enforce-mfa\`.
> There is no "require MFA" attribute on an IAM user. This integration
> enforces MFA via a policy Condition, which only constrains callers using STS
> temporary credentials (GetSessionToken/AssumeRole) — long-term access keys
> never carry MFA session context and are unaffected by this condition.

## Policy condition

- Policy ARN: \`${p.IAM_POLICY_ARN}\`
- Condition added: \`aws:MultiFactorAuthPresent\` = true${
      p.MFA_CONDITION_MAX_AGE_SECONDS !== undefined
        ? ` and \`aws:MultiFactorAuthAge\` < ${p.MFA_CONDITION_MAX_AGE_SECONDS}s`
        : ""
    } on every statement.

## Device provisioning

${
  !p.PROVISION_VIRTUAL_DEVICE
    ? "Skipped — `PROVISION_VIRTUAL_DEVICE` was false."
    : serialNumber
      ? `- Serial number: \`${serialNumber}\`
- Status: **${awaitingEnablement ? "AWAITING HUMAN ENABLEMENT" : "enabled"}**
${
  awaitingEnablement
    ? "\nThe Base32 seed was printed to stdout once, when this device was created. " +
      "It is NOT persisted here. A human must scan/enter it into an authenticator app, obtain " +
      "two sequential codes, and call `EnableMFADevice` to finish. Until then, MFA is not actually " +
      "enforceable for this user via a device-backed session."
    : ""
}`
      : "A device was already associated with this user before this run — nothing provisioned."
}

## Verification

Policy condition: verified structurally against the policy's live default
version. Device: reported, not gated — a device pending human enablement is
expected and does not fail this run.
`;
  },
});
