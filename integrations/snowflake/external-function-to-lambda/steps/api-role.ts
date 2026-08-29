import { CreateRoleCommand, DeleteRoleCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, roleArn, roleState } from "../../../../src/providers/aws";
import { placeholderTrustPolicy, type Params } from "../params";

const arnOf = (ctx: { accountId: string; params: Params }) => roleArn(ctx.accountId, ctx.params.AWS_API_ROLE_NAME);

/**
 * Phase A of the two-phase dance: the role, created with a placeholder
 * trust policy. Do not simplify this into one step with the real trust
 * policy — the real principal and external id only exist once Snowflake
 * has an API integration, and Snowflake will not create one without a
 * role ARN. The role has to exist first, trusting only our own account
 * root, and is patched by the shared iamTrustPolicyStep further down.
 *
 * Not the generic iamRoleStep factory: that factory's trustPolicy()
 * callback only receives params, not ctx.accountId, which the placeholder
 * document needs.
 */
export const apiRoleStep: Step<Params> = {
  id: "api-role",
  title: "Ensure IAM role with placeholder trust policy",

  async check(ctx) {
    return roleState(awsClients(ctx).iam, ctx.params.AWS_API_ROLE_NAME);
  },

  async create(ctx) {
    await awsClients(ctx).iam.send(
      new CreateRoleCommand({
        RoleName: ctx.params.AWS_API_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(placeholderTrustPolicy(ctx.accountId)),
      }),
    );
    return { apiRoleArn: arnOf(ctx), apiRoleCreatedThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.apiRoleCreatedThisRun !== true) return;
    await awsClients(ctx).iam.send(new DeleteRoleCommand({ RoleName: ctx.params.AWS_API_ROLE_NAME }));
  },

  resource(ctx) {
    return {
      type: "aws_iam_role",
      name: ctx.params.AWS_API_ROLE_NAME,
      attributes: { arn: arnOf(ctx) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_role",
      address: "aws_iam_role.snowflake_api",
      importId: (ctx) => ctx.params.AWS_API_ROLE_NAME,
    },
  },
};
