import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { iamUserTeardownStep, userArn, type UserTeardownSummary } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { confirmDestructiveStep } from "./steps/confirm-destructive";
import { verify } from "./verify";

/**
 * Access-lifecycle entry point: fully offboards a departed person's IAM
 * identity, tearing down every attached artifact (access keys, login
 * profile, MFA devices, group memberships, attached + inline policies,
 * signing certs, SSH keys, service-specific creds) before deleting the user.
 *
 * The underlying AWS API sequence is identical to aws/iam/user/delete-user —
 * both call the same iamUserTeardownStep factory. This integration exists as
 * a separate folder only because "offboard a person" (HR-driven) and
 * "delete an IAM entity" (infra-cleanup-driven) are invoked by different
 * teams at different trigger points; the only real differences are framing,
 * the optional OFFBOARD_REASON audit-trail param, and report language.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/offboard-user",
  schemaVersion: 1,
  summary:
    "Offboards a departed person's IAM user: tears down every access key, login profile, MFA device, group membership, and policy attachment, then deletes the user, with an audit-trail reason in the report.",

  // The .env-facing input differs from the parsed output
  // (ALLOW_DESTRUCTIVE_TEARDOWN arrives as a "true"/"false" string), a real
  // ZodEffects shape that z.ZodType<P>'s same-Input-as-Output generic doesn't
  // model. Same cast delete-role's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [confirmDestructiveStep, iamUserTeardownStep<Params>({ userName: (p) => p.IAM_USER_NAME })],

  verify,

  reportName: (ctx) => ctx.params.IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const arn = String(ctx.outputs.userArn ?? userArn(ctx.accountId, p.IAM_USER_NAME));
    const summaryRaw = ctx.outputs.userTeardownSummary as string | undefined;
    const summary: UserTeardownSummary | undefined = summaryRaw ? JSON.parse(summaryRaw) : undefined;
    const reason = p.OFFBOARD_REASON?.trim();

    return `# IAM User Offboarding — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/offboard-user\`.

Offboarded \`${p.IAM_USER_NAME}\` — reason: ${reason ? reason : "not provided"}.

## AWS IAM

- User name: \`${p.IAM_USER_NAME}\`
- User ARN: \`${arn}\`

## What was torn down

${
  summary
    ? `- Access keys deleted: ${summary.deletedKeyCount}
- Login profile (password) present: ${summary.hadLoginProfile ? "yes — deleted" : "no"}
- MFA devices deactivated/deleted: ${summary.mfaDeviceCount}
- Group memberships removed: ${summary.groupCount}
- Managed policies detached: ${summary.attachedPolicyCount}
- Inline policies deleted: ${summary.inlinePolicyCount}
- Signing certificates deleted: ${summary.signingCertCount}
- SSH public keys deleted: ${summary.sshKeyCount}
- Service-specific credentials deleted: ${summary.serviceSpecificCredCount}`
    : "(no teardown summary captured — the user was likely already gone before this run)"
}

## Irreversibility

Every credential listed above is gone for good: AWS never returns an access
key's secret or a login profile's password again once deleted. Rollback of
this run (if triggered) only recreates a **bare** user shell with the same
name — it does not and cannot restore any of the above.

## Verification

Verified — confirmed \`GetUser\` throws \`NoSuchEntityException\` for
\`${p.IAM_USER_NAME}\`.
`;
  },
});
