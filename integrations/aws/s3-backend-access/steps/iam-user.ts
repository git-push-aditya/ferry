import { CreateUserCommand, DeleteUserCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, userArn, userState } from "../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Programmatic access only: no console login profile is ever created, so this
 * identity exists purely as an API credential holder.
 */
export const iamUserStep: Step<Params> = {
  id: "iam-user",
  title: "Ensure IAM user (programmatic access only)",

  async check(ctx) {
    return userState(awsClients(ctx).iam, ctx.params.BACKEND_IAM_USER_NAME);
  },

  async create(ctx) {
    await awsClients(ctx).iam.send(
      new CreateUserCommand({ UserName: ctx.params.BACKEND_IAM_USER_NAME }),
    );
    return {
      backendUserArn: userArn(ctx.accountId, ctx.params.BACKEND_IAM_USER_NAME),
      backendUserCreatedThisRun: true,
    };
  },

  async rollback(ctx) {
    await awsClients(ctx).iam.send(
      new DeleteUserCommand({ UserName: ctx.params.BACKEND_IAM_USER_NAME }),
    );
  },

  resource(ctx) {
    return {
      type: "aws_iam_user",
      name: ctx.params.BACKEND_IAM_USER_NAME,
      attributes: { arn: userArn(ctx.accountId, ctx.params.BACKEND_IAM_USER_NAME) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_user",
      address: "aws_iam_user.backend_s3",
      importId: (ctx) => ctx.params.BACKEND_IAM_USER_NAME,
    },
  },
};
