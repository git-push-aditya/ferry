import { CreatePolicyCommand, DeletePolicyCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../../src/core/define";
import { awsClients, policyArn, policyState } from "../../../../../src/providers/aws";
import { backendUserPolicy } from "../policies";
import type { Params } from "../params";

const arnOf = (ctx: { accountId: string; params: Params }) =>
  policyArn(ctx.accountId, ctx.params.BACKEND_IAM_POLICY_NAME);

/** Artifact H: the backend's least-privilege policy, scoped to this bucket's ARN. */
export const iamPolicyStep: Step<Params> = {
  id: "iam-policy",
  title: "Ensure least-privilege IAM policy (artifact H)",

  async check(ctx) {
    return policyState(awsClients(ctx).iam, arnOf(ctx));
  },

  async create(ctx) {
    await awsClients(ctx).iam.send(
      new CreatePolicyCommand({
        PolicyName: ctx.params.BACKEND_IAM_POLICY_NAME,
        PolicyDocument: JSON.stringify(backendUserPolicy(ctx.params.EXPORT_S3_BUCKET)),
      }),
    );
    return { backendPolicyArn: arnOf(ctx), backendPolicyCreatedThisRun: true };
  },

  async rollback(ctx) {
    await awsClients(ctx).iam.send(new DeletePolicyCommand({ PolicyArn: arnOf(ctx) }));
  },

  resource(ctx) {
    return {
      type: "aws_iam_policy",
      name: ctx.params.BACKEND_IAM_POLICY_NAME,
      attributes: { arn: arnOf(ctx) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_policy",
      address: "aws_iam_policy.backend_s3",
      importId: (ctx) => arnOf(ctx),
    },
  },
};
