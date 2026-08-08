import {
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
  ListAccessKeysCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import { awsClients, isNoSuchEntity } from "../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * The one step that mints a secret.
 *
 * IDEMPOTENCY: a user that already holds a key is left alone. Creating another
 * one on every re-run would burn through the two-key AWS limit and scatter live
 * credentials nobody asked for. Rotation is a deliberate act — delete the old
 * key in IAM, then re-run.
 */
export const accessKeyStep: Step<Params> = {
  id: "access-key",
  title: "Create access key",

  async check(ctx) {
    try {
      const existing = await awsClients(ctx).iam.send(
        new ListAccessKeysCommand({ UserName: ctx.params.BACKEND_IAM_USER_NAME }),
      );
      const keys = existing.AccessKeyMetadata ?? [];
      if (!keys.length) return "missing";
      for (const key of keys) ctx.log.info(`existing key: ${key.AccessKeyId}`);
      return "exists";
    } catch (err) {
      if (isNoSuchEntity(err)) return "missing";
      throw err;
    }
  },

  async create(ctx) {
    const created = await awsClients(ctx).iam.send(
      new CreateAccessKeyCommand({ UserName: ctx.params.BACKEND_IAM_USER_NAME }),
    );
    const accessKey = created.AccessKey;
    if (!accessKey?.AccessKeyId || !accessKey?.SecretAccessKey) {
      throw new Error("CreateAccessKey did not return an access key pair");
    }

    return {
      backendAccessKeyId: accessKey.AccessKeyId,
      // Held in memory for verify() and the single stdout print. It is masked
      // in the report and never written to any file.
      backendSecretAccessKey: accessKey.SecretAccessKey,
      backendAccessKeyCreatedThisRun: true,
    };
  },

  async rollback(ctx) {
    const accessKeyId = ctx.outputs.backendAccessKeyId as string | undefined;
    if (!accessKeyId) return;
    try {
      await awsClients(ctx).iam.send(
        new DeleteAccessKeyCommand({
          UserName: ctx.params.BACKEND_IAM_USER_NAME,
          AccessKeyId: accessKeyId,
        }),
      );
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_access_key",
      name: ctx.params.BACKEND_IAM_USER_NAME,
      // The id only — the secret never leaves memory.
      attributes: { accessKeyId: String(ctx.outputs.backendAccessKeyId ?? "") },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_access_key",
      address: "aws_iam_access_key.backend_s3",
      importId: (ctx) => String(ctx.outputs.backendAccessKeyId ?? ""),
    },
    ansibleVar: "backend_s3_access_key_id",
  },
};
