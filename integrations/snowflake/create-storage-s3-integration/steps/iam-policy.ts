import { CreatePolicyCommand, DeletePolicyCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, policyArn, policyState } from "../../../../src/providers/aws";
import { integrationRolePolicy } from "../policies";
import type { Params } from "../params";

const arnOf = (ctx: { accountId: string; params: Params }) =>
  policyArn(ctx.accountId, ctx.params.AWS_STORAGE_POLICY_NAME);

/** Artifact A: what the Snowflake role may do to the bucket/prefix. */
export const iamPolicyStep: Step<Params> = {
  id: "iam-policy",
  title: "Ensure IAM policy (artifact A)",

  async check(ctx) {
    return policyState(awsClients(ctx).iam, arnOf(ctx));
  },

  async create(ctx) {
    await awsClients(ctx).iam.send(
      new CreatePolicyCommand({
        PolicyName: ctx.params.AWS_STORAGE_POLICY_NAME,
        PolicyDocument: JSON.stringify(
          integrationRolePolicy(
            ctx.params.EXPORT_S3_BUCKET,
            ctx.params.EXPORT_S3_PREFIX,
            ctx.params.ACCESS_MODE,
          ),
        ),
      }),
    );
    return { storagePolicyArn: arnOf(ctx), storagePolicyCreatedThisRun: true };
  },

  async rollback(ctx) {
    await awsClients(ctx).iam.send(new DeletePolicyCommand({ PolicyArn: arnOf(ctx) }));
  },

  resource(ctx) {
    return {
      type: "aws_iam_policy",
      name: ctx.params.AWS_STORAGE_POLICY_NAME,
      attributes: { arn: arnOf(ctx) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_policy",
      address: "aws_iam_policy.snowflake_storage",
      importId: (ctx) => arnOf(ctx),
    },
  },
};
