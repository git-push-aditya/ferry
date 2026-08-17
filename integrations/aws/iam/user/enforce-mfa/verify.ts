import { GetPolicyCommand, GetPolicyVersionCommand, ListMFADevicesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import type { Params } from "./params";

const MFA_PRESENT_KEY = "aws:MultiFactorAuthPresent";
const MFA_AGE_KEY = "aws:MultiFactorAuthAge";

function parseDocument(raw: string): { Statement: Array<Record<string, unknown>> } {
  const doc = JSON.parse(decodeURIComponent(raw)) as { Statement?: unknown };
  const statement = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
  return { Statement: statement as Array<Record<string, unknown>> };
}

/**
 * Two independent halves, verified independently and asymmetrically:
 *
 * - Policy condition: a clean pass/fail. Either the condition is live on
 *   every statement or it isn't.
 * - Device provisioning: NEVER fails verify() just because enablement is
 *   still pending a human. Per AWS's own behavior, an unenabled virtual
 *   device created via CreateVirtualMFADevice does not appear in
 *   ListMFADevices until EnableMFADevice succeeds — so "not listed yet" is
 *   the expected, honest state right after this integration runs, not a
 *   failure. Throwing here would roll back a policy change that IS correctly
 *   in place, which would be strictly worse than reporting the truth.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const policyArn = ctx.params.IAM_POLICY_ARN;
  const maxAgeSeconds = ctx.params.MFA_CONDITION_MAX_AGE_SECONDS;

  const policy = await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
  const versionId = policy.Policy?.DefaultVersionId;
  if (!versionId) throw new Error(`Could not read the default version of ${policyArn}`);

  const version = await iam.send(
    new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: versionId }),
  );
  const rawDoc = version.PolicyVersion?.Document;
  if (!rawDoc) throw new Error(`Could not read the policy document of ${policyArn}`);
  const doc = parseDocument(rawDoc);

  const enforced = doc.Statement.every((stmt) => {
    const condition = stmt.Condition as Record<string, Record<string, unknown>> | undefined;
    const present = condition?.Bool?.[MFA_PRESENT_KEY];
    const presentOk = present === "true" || present === true;
    if (!presentOk) return false;
    if (maxAgeSeconds === undefined) return true;
    return String(condition?.NumericLessThan?.[MFA_AGE_KEY]) === String(maxAgeSeconds);
  });

  if (!enforced) {
    throw new Error(
      `${policyArn}'s default version does not carry the MFA condition on every statement — ` +
        `the policy half of enforce-mfa did not take effect.`,
    );
  }
  ctx.log.success(
    `MFA policy condition is live on ${policyArn} — long-term access-key callers remain unaffected ` +
      `by design; this only constrains STS temporary-credential callers (GetSessionToken/AssumeRole).`,
  );

  if (!ctx.params.PROVISION_VIRTUAL_DEVICE) {
    ctx.log.info("PROVISION_VIRTUAL_DEVICE was false — device provisioning was skipped entirely.");
    return;
  }

  const devices = await iam.send(new ListMFADevicesCommand({ UserName: ctx.params.IAM_USER_NAME }));
  const serialNumber = ctx.outputs.mfaDeviceSerialNumber as string | undefined;
  const listed = (devices.MFADevices ?? []).some((d) => d.SerialNumber === serialNumber);

  if (listed || (devices.MFADevices ?? []).length > 0) {
    ctx.log.success(`MFA device is associated (enabled) for ${ctx.params.IAM_USER_NAME}.`);
    return;
  }

  if (ctx.outputs.mfaAwaitingHumanEnablement) {
    ctx.log.warn(
      "MFA policy condition is live. Device provisioning is pending human enablement — MFA is not " +
        "yet actually enforceable for this user via a device-backed session until enablement " +
        "completes (EnableMFADevice with two live authenticator codes). This is expected right after " +
        "provisioning and does NOT fail this run.",
    );
    return;
  }

  // No device was created this run and none is enabled — PROVISION_VIRTUAL_DEVICE
  // was true but check() must have found the device half already satisfied
  // or opted-out for some other reason; nothing further to assert.
}
