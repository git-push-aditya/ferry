import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { iamUserTeardownStep, userArn, type UserTeardownSummary } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { confirmDestructiveStep } from "./steps/confirm-destructive";
import { verify } from "./verify";

/**
 * Deletes an IAM user, tearing down every attached artifact first
 * (access keys, login profile, MFA devices, group memberships, attached +
 * inline policies, signing certs, SSH keys, service-specific creds) —
 * DeleteUser's own documented precondition. Shares the identical teardown
 * sequence with aws/iam/user/offboard-user via iamUserTeardownStep; the two
 * integrations differ only in framing/params/report, per the plan's own
 * "no justification for two independently maintained copies of a
 * nine-API-call destructive sequence" reasoning.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/delete-user",
  schemaVersion: 1,
  summary:
    "Deletes an IAM user after tearing down every access key, login profile, MFA device, group membership, and policy attachment it holds.",

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

    return `# IAM User Deletion — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/delete-user\`.

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
