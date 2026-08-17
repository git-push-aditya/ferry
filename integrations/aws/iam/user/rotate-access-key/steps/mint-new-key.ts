import { CreateAccessKeyCommand, DeleteAccessKeyCommand, ListAccessKeysCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients, isNoSuchEntity } from "../../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Phase A of rotation: mint a second access key, automatically, with no
 * confirmation gate — this half is purely additive and reversible (a freshly
 * minted key can always just be deleted again). It never touches the old key.
 *
 * check() semantics are custom, not the shared `iamAccessKeyStep`'s, because
 * rotation carries a real precondition `create-access-key` doesn't: this is
 * not create-access-key, so a user with zero keys is a conflict, not a
 * "missing, go create one" case.
 *
 * - 0 keys -> "conflict": rotation presumes an existing key to rotate away from.
 * - 1 key  -> "missing": mint the second.
 * - 2 keys -> "exists": already minted (mid-rotation, or blocked awaiting
 *   cutover) — reconcile() still runs (declared below) purely to
 *   (re-)determine which key is old/new and hand that forward via outputs,
 *   since a later run's outputs start empty and cutover-old-key depends on
 *   `oldAccessKeyId`/`newAccessKeyId` being present every run, not only the
 *   run that minted.
 */
export const mintNewKeyStep: Step<Params> = {
  id: "mint-new-key",
  title: "Mint new access key (Phase A)",

  async check(ctx) {
    const { iam } = awsClients(ctx);
    try {
      const existing = await iam.send(
        new ListAccessKeysCommand({ UserName: ctx.params.IAM_USER_NAME }),
      );
      const keys = existing.AccessKeyMetadata ?? [];
      if (keys.length === 0) {
        ctx.log.warn(
          `${ctx.params.IAM_USER_NAME} holds no access keys — rotate-access-key presumes an existing ` +
            `key to rotate away from. Use aws/iam/user/create-access-key if you need the first one.`,
        );
        return "conflict";
      }
      if (keys.length === 1) return "missing";
      return "exists";
    } catch (err) {
      if (isNoSuchEntity(err)) {
        ctx.log.warn(`IAM user "${ctx.params.IAM_USER_NAME}" does not exist.`);
        return "conflict";
      }
      throw err;
    }
  },

  async create(ctx) {
    const { iam } = awsClients(ctx);
    const userName = ctx.params.IAM_USER_NAME;

    const existing = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
    const keys = existing.AccessKeyMetadata ?? [];
    const oldKey = keys[0];
    if (!oldKey?.AccessKeyId) {
      throw new Error(`Expected exactly one existing access key on ${userName}, found none`);
    }

    const created = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
    const accessKey = created.AccessKey;
    if (!accessKey?.AccessKeyId || !accessKey?.SecretAccessKey) {
      throw new Error("CreateAccessKey did not return an access key pair");
    }

    ctx.log.success(
      `New key ${accessKey.AccessKeyId} created. Update all configured credentials to use it, ` +
        `confirm the application works, then re-run with CONFIRM_CUTOVER=true to deactivate and ` +
        `delete the old key ${oldKey.AccessKeyId}.`,
    );

    return {
      oldAccessKeyId: oldKey.AccessKeyId,
      newAccessKeyId: accessKey.AccessKeyId,
      // Held in memory only, printed once at report time, never persisted.
      newSecretAccessKey: accessKey.SecretAccessKey,
      newKeyMintedThisRun: true,
    };
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const userName = ctx.params.IAM_USER_NAME;

    const existing = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
    const keys = [...(existing.AccessKeyMetadata ?? [])];
    if (keys.length !== 2) {
      throw new Error(
        `Expected exactly two access keys on ${userName} while reconciling rotation state, found ${keys.length}`,
      );
    }

    // Prefer an already-Inactive key as "old" (cutover may have partially run
    // in a prior invocation); otherwise fall back to CreateDate ordering.
    const inactive = keys.find((k) => k.Status === "Inactive");
    let oldKey = inactive;
    let newKey = inactive ? keys.find((k) => k !== inactive) : undefined;
    if (!oldKey) {
      const sorted = [...keys].sort(
        (a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0),
      );
      oldKey = sorted[0];
      newKey = sorted[1];
    }
    if (!oldKey?.AccessKeyId || !newKey?.AccessKeyId) {
      throw new Error(`Could not determine old/new key ordering for ${userName}`);
    }

    ctx.log.info(
      `Two keys already present on ${userName}: old=${oldKey.AccessKeyId}, new=${newKey.AccessKeyId}. ` +
        `No key minted this run.`,
    );

    return {
      oldAccessKeyId: oldKey.AccessKeyId,
      newAccessKeyId: newKey.AccessKeyId,
      newKeyMintedThisRun: false,
    };
  },

  async rollback(ctx) {
    // Only ever undo a key this run actually minted — a pre-existing second
    // key discovered by reconcile() was never this run's doing.
    if (!ctx.outputs.newKeyMintedThisRun) return;
    const newAccessKeyId = ctx.outputs.newAccessKeyId as string | undefined;
    if (!newAccessKeyId) return;
    try {
      await awsClients(ctx).iam.send(
        new DeleteAccessKeyCommand({ UserName: ctx.params.IAM_USER_NAME, AccessKeyId: newAccessKeyId }),
      );
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_access_key",
      name: ctx.params.IAM_USER_NAME,
      attributes: {
        newAccessKeyId: String(ctx.outputs.newAccessKeyId ?? ""),
        oldAccessKeyId: String(ctx.outputs.oldAccessKeyId ?? ""),
        mintedThisRun: String(Boolean(ctx.outputs.newKeyMintedThisRun)),
      },
    };
  },
};
