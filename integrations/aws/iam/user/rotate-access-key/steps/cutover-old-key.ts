import { DeleteAccessKeyCommand, ListAccessKeysCommand, UpdateAccessKeyCommand } from "@aws-sdk/client-iam";
import { requireOutput, type Step } from "../../../../../../src/core/define";
import { awsClients, isNoSuchEntity } from "../../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Phase B of rotation: deactivate then delete the old key. Only proceeds once
 * a human has set CONFIRM_CUTOVER=true, after migrating every configured
 * credential to the new key minted by mint-new-key. Deliberately kept as a
 * distinct step from mint-new-key — the two phases have genuinely different
 * risk profiles (additive/reversible vs. destructive), and the plan output
 * should show the operator distinctly whether a run is about to *mint* or
 * about to *delete*.
 *
 * No create() — this is the "inverted create-or-skip" shape (same idiom as
 * detach-policy/remove-from-group): the actionable state is "missing" (a
 * cutover still needs to happen), and "exists" means either it already
 * happened or the human gate isn't open yet.
 */
export const cutoverOldKeyStep: Step<Params> = {
  id: "cutover-old-key",
  title: "Deactivate + delete old access key (Phase B)",

  async check(ctx) {
    if (!ctx.params.CONFIRM_CUTOVER) {
      ctx.log.info(
        "CONFIRM_CUTOVER is false — waiting for a human to migrate configured credentials to the " +
          "new key before retiring the old one. Re-run with CONFIRM_CUTOVER=true when ready.",
      );
      return "exists";
    }

    const oldAccessKeyId = requireOutput<string>(ctx, "oldAccessKeyId");
    const { iam } = awsClients(ctx);
    const existing = await iam.send(
      new ListAccessKeysCommand({ UserName: ctx.params.IAM_USER_NAME }),
    );
    const oldKey = (existing.AccessKeyMetadata ?? []).find((k) => k.AccessKeyId === oldAccessKeyId);
    if (!oldKey || oldKey.Status !== "Active") return "exists"; // already deactivated/deleted
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const userName = ctx.params.IAM_USER_NAME;
    const oldAccessKeyId = requireOutput<string>(ctx, "oldAccessKeyId");

    await iam.send(
      new UpdateAccessKeyCommand({ UserName: userName, AccessKeyId: oldAccessKeyId, Status: "Inactive" }),
    );
    ctx.log.info(`Deactivated old key ${oldAccessKeyId}`);

    const soakMinutes = ctx.params.ROTATION_SOAK_MINUTES;
    if (soakMinutes > 0) {
      ctx.log.info(`Soaking ${soakMinutes} minute(s) before deleting ${oldAccessKeyId}...`);
      await new Promise((resolve) => setTimeout(resolve, soakMinutes * 60_000));
    }

    await iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: oldAccessKeyId }));
    ctx.log.success(`Deleted old key ${oldAccessKeyId}`);

    return { oldKeyDeactivatedThisRun: true, oldKeyDeletedThisRun: true };
  },

  async rollback(ctx) {
    const userName = ctx.params.IAM_USER_NAME;
    const oldAccessKeyId = ctx.outputs.oldAccessKeyId as string | undefined;
    if (!oldAccessKeyId) return;

    if (ctx.outputs.oldKeyDeletedThisRun) {
      ctx.log.warn(
        `Old key ${oldAccessKeyId} was already DELETED this run — this cannot be undone. AWS never ` +
          `returns a deleted key's secret again. If this was premature, mint a fresh key manually.`,
      );
      return;
    }

    if (ctx.outputs.oldKeyDeactivatedThisRun) {
      try {
        await awsClients(ctx).iam.send(
          new UpdateAccessKeyCommand({ UserName: userName, AccessKeyId: oldAccessKeyId, Status: "Active" }),
        );
        ctx.log.info(`Reactivated old key ${oldAccessKeyId}`);
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_access_key_status",
      name: `${ctx.params.IAM_USER_NAME}:${String(ctx.outputs.oldAccessKeyId ?? "")}`,
      attributes: {
        user: ctx.params.IAM_USER_NAME,
        accessKeyId: String(ctx.outputs.oldAccessKeyId ?? ""),
        action: ctx.outputs.oldKeyDeletedThisRun ? "deleted" : "deactivated",
      },
    };
  },
};
