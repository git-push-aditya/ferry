import { CreateRoleCommand, DeleteRoleCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, isNoSuchEntity, roleArn, roleState } from "../../../../src/providers/aws";
import { cfnExecutionTrustPolicy, type Params } from "../params";

/**
 * Same shape as the generic iamRoleStep, with one addition: rollback is
 * gated behind ALLOW_DESTRUCTIVE_ROLLBACK even for a role this run created —
 * a CloudFormation execution role may already have been used by a real
 * deploy between creation and rollback, so deleting it on an unrelated
 * failure later in the same run is a stronger claim than "undo what we
 * just did." Not reusing iamRoleStep directly because it has no such gate.
 */
export const executionRoleStep: Step<Params> = {
  id: "execution-role",
  title: "Create the CloudFormation execution role",

  async check(ctx) {
    return roleState(awsClients(ctx).iam, ctx.params.CFN_EXECUTION_ROLE_NAME);
  },

  async create(ctx) {
    const created = await awsClients(ctx).iam.send(
      new CreateRoleCommand({
        RoleName: ctx.params.CFN_EXECUTION_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(cfnExecutionTrustPolicy()),
        Description: "CloudFormation execution role — managed by ferry",
      }),
    );
    return {
      executionRoleArn: created.Role?.Arn ?? roleArn(ctx.accountId, ctx.params.CFN_EXECUTION_ROLE_NAME),
      executionRoleCreatedThisRun: true,
    };
  },

  async rollback(ctx) {
    if (ctx.outputs.executionRoleCreatedThisRun !== true) return;
    if (!ctx.params.ALLOW_DESTRUCTIVE_ROLLBACK) {
      ctx.log.warn(
        `Not deleting execution role "${ctx.params.CFN_EXECUTION_ROLE_NAME}" on rollback — ` +
          `set ALLOW_DESTRUCTIVE_ROLLBACK=true to allow this. A real deploy may already ` +
          `reference this role.`,
      );
      return;
    }
    try {
      await awsClients(ctx).iam.send(new DeleteRoleCommand({ RoleName: ctx.params.CFN_EXECUTION_ROLE_NAME }));
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_role",
      name: ctx.params.CFN_EXECUTION_ROLE_NAME,
      attributes: { arn: roleArn(ctx.accountId, ctx.params.CFN_EXECUTION_ROLE_NAME) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_role",
      address: "aws_iam_role.cfn_execution",
      importId: (ctx) => ctx.params.CFN_EXECUTION_ROLE_NAME,
    },
  },
};
