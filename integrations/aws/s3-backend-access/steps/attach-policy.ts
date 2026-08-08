import {
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  ListAttachedUserPoliciesCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, isNoSuchEntity, policyArn } from "../../../../src/providers/aws";
import type { Params } from "../params";

const arnOf = (ctx: { accountId: string; params: Params }) =>
  policyArn(ctx.accountId, ctx.params.BACKEND_IAM_POLICY_NAME);

/**
 * AttachUserPolicy is idempotent, so the call itself can't tell us whether the
 * attachment is ours. Check first — detaching a pre-existing attachment on
 * rollback would damage state this run did not create.
 */
export const attachPolicyStep: Step<Params> = {
  id: "attach-policy",
  title: "Attach policy to user",

  async check(ctx) {
    try {
      const attached = await awsClients(ctx).iam.send(
        new ListAttachedUserPoliciesCommand({ UserName: ctx.params.BACKEND_IAM_USER_NAME }),
      );
      return (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === arnOf(ctx))
        ? "exists"
        : "missing";
    } catch (err) {
      // The user itself doesn't exist yet — an earlier step will create it.
      if (isNoSuchEntity(err)) return "missing";
      throw err;
    }
  },

  async create(ctx) {
    await awsClients(ctx).iam.send(
      new AttachUserPolicyCommand({
        UserName: ctx.params.BACKEND_IAM_USER_NAME,
        PolicyArn: arnOf(ctx),
      }),
    );
    return { backendPolicyAttachedThisRun: true };
  },

  async rollback(ctx) {
    try {
      await awsClients(ctx).iam.send(
        new DetachUserPolicyCommand({
          UserName: ctx.params.BACKEND_IAM_USER_NAME,
          PolicyArn: arnOf(ctx),
        }),
      );
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_user_policy_attachment",
      name: `${ctx.params.BACKEND_IAM_USER_NAME}:${ctx.params.BACKEND_IAM_POLICY_NAME}`,
      attributes: { user: ctx.params.BACKEND_IAM_USER_NAME, policyArn: arnOf(ctx) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_user_policy_attachment",
      address: "aws_iam_user_policy_attachment.backend_s3",
      importId: (ctx) => `${ctx.params.BACKEND_IAM_USER_NAME}/${arnOf(ctx)}`,
    },
  },
};
