import { GetRoleCommand, GetRolePolicyCommand, ListAttachedRolePoliciesCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../src/core/define";
import { awsClients } from "../../../src/providers/aws";
import { ciRoleCfnPolicyDocument, ciRolePolicyName, cfnExecutionTrustPolicy, type Params } from "./params";

/** Confirms both roles exist, the execution role's trust and attachments match, and the CI role's PassRole condition is present. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam, region } = awsClients(ctx);

  const execRole = await iam.send(new GetRoleCommand({ RoleName: ctx.params.CFN_EXECUTION_ROLE_NAME }));
  const execDoc = execRole.Role?.AssumeRolePolicyDocument;
  if (!execDoc) throw new Error(`Could not read the trust policy of "${ctx.params.CFN_EXECUTION_ROLE_NAME}"`);
  const liveExecTrust = JSON.parse(decodeURIComponent(execDoc));
  if (JSON.stringify(liveExecTrust) !== JSON.stringify(cfnExecutionTrustPolicy())) {
    throw new Error(`"${ctx.params.CFN_EXECUTION_ROLE_NAME}" does not trust cloudformation.amazonaws.com`);
  }

  const attached = await iam.send(
    new ListAttachedRolePoliciesCommand({ RoleName: ctx.params.CFN_EXECUTION_ROLE_NAME }),
  );
  const attachedArns = (attached.AttachedPolicies ?? []).map((p) => p.PolicyArn).sort();
  const desiredArns = [...ctx.params.EXECUTION_POLICY_ARNS].sort();
  if (JSON.stringify(attachedArns) !== JSON.stringify(desiredArns)) {
    throw new Error(
      `"${ctx.params.CFN_EXECUTION_ROLE_NAME}" attached policies do not match EXECUTION_POLICY_ARNS exactly`,
    );
  }

  const ciPolicy = await iam.send(
    new GetRolePolicyCommand({ RoleName: ctx.params.AWS_ROLE_NAME, PolicyName: ciRolePolicyName() }),
  );
  const liveCiDoc = ciPolicy.PolicyDocument ? JSON.parse(decodeURIComponent(ciPolicy.PolicyDocument)) : null;
  const desiredCiDoc = ciRoleCfnPolicyDocument(ctx.accountId, region, ctx.params);
  if (JSON.stringify(liveCiDoc) !== JSON.stringify(desiredCiDoc)) {
    throw new Error(
      `Inline policy on "${ctx.params.AWS_ROLE_NAME}" does not match the desired CFN+PassRole document`,
    );
  }

  ctx.log.success(
    `Confirmed "${ctx.params.CFN_EXECUTION_ROLE_NAME}" trust/attachments and "${ctx.params.AWS_ROLE_NAME}"'s PassRole-gated deploy policy`,
  );
}
