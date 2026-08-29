import { GetRoleCommand, ListAttachedRolePoliciesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../src/core/define";
import { awsClients } from "../../../src/providers/aws";
import { spokeTrustPolicy, type Params } from "./params";

/** Confirms the spoke role's trust policy matches exactly and its attached policies match SPOKE_PERMISSION_POLICY_ARNS exactly. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);

  const role = await iam.send(new GetRoleCommand({ RoleName: ctx.params.SPOKE_ROLE_NAME }));
  const rawDoc = role.Role?.AssumeRolePolicyDocument;
  if (!rawDoc) throw new Error(`Could not read the trust policy of "${ctx.params.SPOKE_ROLE_NAME}"`);
  const live = JSON.parse(decodeURIComponent(rawDoc));
  const desired = spokeTrustPolicy(ctx.params.HUB_ROLE_ARN);
  if (JSON.stringify(live) !== JSON.stringify(desired)) {
    throw new Error(`Trust policy on "${ctx.params.SPOKE_ROLE_NAME}" does not trust "${ctx.params.HUB_ROLE_ARN}"`);
  }

  const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: ctx.params.SPOKE_ROLE_NAME }));
  const attachedArns = (attached.AttachedPolicies ?? []).map((p) => p.PolicyArn).sort();
  const desiredArns = [...ctx.params.SPOKE_PERMISSION_POLICY_ARNS].sort();
  if (JSON.stringify(attachedArns) !== JSON.stringify(desiredArns)) {
    throw new Error(`"${ctx.params.SPOKE_ROLE_NAME}" attached policies do not match SPOKE_PERMISSION_POLICY_ARNS exactly`);
  }

  ctx.log.success(
    `Confirmed "${ctx.params.SPOKE_ROLE_NAME}" trusts "${ctx.params.HUB_ROLE_ARN}" and has the desired policy set`,
  );
}
