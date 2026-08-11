import {
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  GetPolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { pollUntil } from "../../../../src/core/wait";
import { awsClients, isNoSuchEntity, policyArn } from "../../../../src/providers/aws";
import type { Params } from "../params";
import {
  IAM_CREATE_BUFFER_WAIT_MS,
  IAM_CREATE_POLL_INTERVAL_MS,
  IAM_CREATE_POLL_TIMEOUT_MS,
  sleep,
} from "../waits";

const arnOf = (ctx: { accountId: string; params: Params }) =>
  policyArn(ctx.accountId, ctx.params.AWS_STORAGE_POLICY_NAME);

/**
 * AttachRolePolicy is idempotent, so the call itself can't tell us whether the
 * attachment is ours. Check first — detaching a pre-existing attachment on
 * rollback would damage state this run did not create.
 */
export const attachPolicyStep: Step<Params> = {
  id: "attach-policy",
  title: "Attach IAM policy to role",

  async check(ctx) {
    try {
      const attached = await awsClients(ctx).iam.send(
        new ListAttachedRolePoliciesCommand({ RoleName: ctx.params.AWS_STORAGE_ROLE_NAME }),
      );
      return (attached.AttachedPolicies ?? []).some((p) => p.PolicyArn === arnOf(ctx))
        ? "exists"
        : "missing";
    } catch (err) {
      // The role itself doesn't exist yet — an earlier step will create it.
      if (isNoSuchEntity(err)) return "missing";
      throw err;
    }
  },

  async create(ctx) {
    const { iam } = awsClients(ctx);
    await iam.send(
      new AttachRolePolicyCommand({
        RoleName: ctx.params.AWS_STORAGE_ROLE_NAME,
        PolicyArn: arnOf(ctx),
      }),
    );

    const policyIsNew = ctx.outputs.storagePolicyCreatedThisRun === true;
    const roleIsNew = ctx.outputs.storageRoleCreatedThisRun === true;
    if (policyIsNew || roleIsNew) {
      // Confirm the read-your-write rather than sleeping blind, then add a
      // short buffer for the services that lag behind a confirmed IAM read.
      // Skipped entirely when nothing was newly created, so a re-run stays fast.
      await pollUntil(
        async () => {
          try {
            if (policyIsNew) await iam.send(new GetPolicyCommand({ PolicyArn: arnOf(ctx) }));
            if (roleIsNew) {
              await iam.send(new GetRoleCommand({ RoleName: ctx.params.AWS_STORAGE_ROLE_NAME }));
            }
            return true;
          } catch (err) {
            if (isNoSuchEntity(err)) return false;
            throw err;
          }
        },
        {
          intervalMs: IAM_CREATE_POLL_INTERVAL_MS,
          timeoutMs: IAM_CREATE_POLL_TIMEOUT_MS,
          label: "New IAM policy/role readable",
        },
      );
      ctx.log.info(
        `Waiting an additional ${IAM_CREATE_BUFFER_WAIT_MS / 1000}s for IAM propagation to other AWS services`,
      );
      await sleep(IAM_CREATE_BUFFER_WAIT_MS);
    }

    return { policyAttachedThisRun: true };
  },

  async rollback(ctx) {
    try {
      await awsClients(ctx).iam.send(
        new DetachRolePolicyCommand({
          RoleName: ctx.params.AWS_STORAGE_ROLE_NAME,
          PolicyArn: arnOf(ctx),
        }),
      );
    } catch (err) {
      // The role may already have been removed by a later (LIFO-earlier) undo.
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_role_policy_attachment",
      name: `${ctx.params.AWS_STORAGE_ROLE_NAME}:${ctx.params.AWS_STORAGE_POLICY_NAME}`,
      attributes: { role: ctx.params.AWS_STORAGE_ROLE_NAME, policyArn: arnOf(ctx) },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_role_policy_attachment",
      address: "aws_iam_role_policy_attachment.snowflake_storage",
      importId: (ctx) => `${ctx.params.AWS_STORAGE_ROLE_NAME}/${arnOf(ctx)}`,
    },
  },
};
