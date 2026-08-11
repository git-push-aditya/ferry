import { CreateRoleCommand, DeleteRoleCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, roleArn, roleState } from "../../../../src/providers/aws";
import { initialRoleTrustPolicy } from "../policies";
import type { Params } from "../params";

const arnOf = (ctx: { accountId: string; params: Params }) =>
  roleArn(ctx.accountId, ctx.params.AWS_STORAGE_ROLE_NAME);

/**
 * Artifact B: the role, created with a placeholder trust policy.
 *
 * ORDERING — do not "simplify" this into one step with the real trust policy.
 * The real principal and external id only exist once Snowflake has a storage
 * integration, and Snowflake will not create one without a role ARN. The role
 * therefore has to exist first, trusting only our own account root, and is
 * patched by the `trust-policy` step further down.
 */
export const iamRoleStep: Step<Params> = {
  id: "iam-role",
  title: "Ensure IAM role with placeholder trust policy (artifact B)",

  async check(ctx) {
    return roleState(awsClients(ctx).iam, ctx.params.AWS_STORAGE_ROLE_NAME);
  },

  async create(ctx) {
    await awsClients(ctx).iam.send(
      new CreateRoleCommand({
        RoleName: ctx.params.AWS_STORAGE_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(initialRoleTrustPolicy(ctx.accountId)),
      }),
    );
    return { storageRoleArn: arnOf(ctx), storageRoleCreatedThisRun: true };
  },

  async rollback(ctx) {
    await awsClients(ctx).iam.send(
      new DeleteRoleCommand({ RoleName: ctx.params.AWS_STORAGE_ROLE_NAME }),
    );
  },

  resource(ctx) {
    return {
      type: "aws_iam_role",
      name: ctx.params.AWS_STORAGE_ROLE_NAME,
      attributes: { arn: arnOf(ctx) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_role",
      address: "aws_iam_role.snowflake_storage",
      importId: (ctx) => ctx.params.AWS_STORAGE_ROLE_NAME,
    },
    ansibleVar: "snowflake_storage_role_arn",
  },
};
