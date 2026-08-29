import { GetRolePolicyCommand } from "@aws-sdk/client-iam";
import { DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import type { StepContext } from "../../../src/core/define";
import { awsClients } from "../../../src/providers/aws";
import { ecrPushPolicyDocument, inlinePolicyName, type Params } from "./params";

/** Confirms the repo exists and the role's inline policy matches exactly. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ecr, iam } = awsClients(ctx);

  const repos = await ecr.send(
    new DescribeRepositoriesCommand({ repositoryNames: [ctx.params.ECR_REPOSITORY_NAME] }),
  );
  if (!repos.repositories?.length) {
    throw new Error(`ECR repository "${ctx.params.ECR_REPOSITORY_NAME}" was not found after apply`);
  }

  const policy = await iam.send(
    new GetRolePolicyCommand({
      RoleName: ctx.params.AWS_ROLE_NAME,
      PolicyName: inlinePolicyName(ctx.params.ECR_REPOSITORY_NAME),
    }),
  );
  const live = policy.PolicyDocument ? JSON.parse(decodeURIComponent(policy.PolicyDocument)) : null;
  const desired = ecrPushPolicyDocument(
    ctx.accountId,
    awsClients(ctx).region,
    ctx.params.ECR_REPOSITORY_NAME,
  );
  if (JSON.stringify(live) !== JSON.stringify(desired)) {
    throw new Error(
      `Inline policy on "${ctx.params.AWS_ROLE_NAME}" does not match the desired ECR push document`,
    );
  }

  ctx.log.success(
    `Confirmed ECR repository "${ctx.params.ECR_REPOSITORY_NAME}" and the push policy on "${ctx.params.AWS_ROLE_NAME}"`,
  );
}
