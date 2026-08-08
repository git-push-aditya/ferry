import { GetRoleCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import { requireOutput, type Step } from "../../../../src/core/define";
import { pollUntil } from "../../../../src/core/wait";
import { awsClients, isNoSuchEntity } from "../../../../src/providers/aws";
import { finalRoleTrustPolicy } from "../policies";
import type { Params } from "../params";
import {
  sleep,
  TRUST_POLICY_BUFFER_WAIT_MS,
  TRUST_POLICY_POLL_INTERVAL_MS,
  TRUST_POLICY_POLL_TIMEOUT_MS,
} from "../waits";

/**
 * Artifact C — the step the whole tool exists for.
 *
 * ORDERING: the role's trust policy needs Snowflake's IAM user ARN and external
 * id, but those don't exist until *after* the storage integration is created,
 * and the storage integration can't be created without the role ARN. So:
 *
 *   iam-role (placeholder trust)  →  storage-integration  →  desc-integration
 *   →  THIS STEP patches the trust policy to its real value
 *
 * Do not move this earlier and do not merge it into `iam-role`. Getting this
 * order wrong is exactly what made the manual runbook error-prone.
 *
 * This is a reconcile, not a create: the role already exists and is being
 * mutated. The prior trust-policy document is captured first so rollback can
 * put a pre-existing role back the way it was.
 */
export const trustPolicyStep: Step<Params> = {
  id: "trust-policy",
  title: "Patch role trust policy with Snowflake identity (artifact C)",

  // The desired document isn't knowable at plan time — it depends on values
  // `desc-integration` reads during apply — so the patch always runs.
  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const storageAwsIamUserArn = requireOutput<string>(ctx, "storageAwsIamUserArn");
    const storageAwsExternalId = requireOutput<string>(ctx, "storageAwsExternalId");

    const before = await iam.send(
      new GetRoleCommand({ RoleName: ctx.params.AWS_STORAGE_ROLE_NAME }),
    );
    const priorTrustPolicy = before.Role?.AssumeRolePolicyDocument
      ? decodeURIComponent(before.Role.AssumeRolePolicyDocument)
      : "";

    await iam.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: ctx.params.AWS_STORAGE_ROLE_NAME,
        PolicyDocument: JSON.stringify(
          finalRoleTrustPolicy(storageAwsIamUserArn, storageAwsExternalId),
        ),
      }),
    );
    ctx.log.success("Trust policy patched with Snowflake principal + external id");

    await pollUntil(
      async () => {
        const role = await iam.send(
          new GetRoleCommand({ RoleName: ctx.params.AWS_STORAGE_ROLE_NAME }),
        );
        const doc = role.Role?.AssumeRolePolicyDocument;
        if (!doc) return false;
        const decoded = decodeURIComponent(doc);
        return decoded.includes(storageAwsExternalId) && decoded.includes(storageAwsIamUserArn);
      },
      {
        intervalMs: TRUST_POLICY_POLL_INTERVAL_MS,
        timeoutMs: TRUST_POLICY_POLL_TIMEOUT_MS,
        label: "Trust policy read-back matches the patch",
      },
    );
    ctx.log.info(
      `Waiting an additional ${TRUST_POLICY_BUFFER_WAIT_MS / 1000}s before the verification COPY — ` +
        "STS AssumeRole evaluation can lag behind a confirmed GetRole read",
    );
    await sleep(TRUST_POLICY_BUFFER_WAIT_MS);

    return { priorTrustPolicyDocument: priorTrustPolicy };
  },

  async rollback(ctx) {
    // If the role itself was created this run its own undo will delete it
    // (LIFO puts that after this one), so a failed restore here is not fatal.
    const prior = String(ctx.outputs.priorTrustPolicyDocument ?? "");
    if (!prior) return;
    try {
      await awsClients(ctx).iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: ctx.params.AWS_STORAGE_ROLE_NAME,
          PolicyDocument: prior,
        }),
      );
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_role_trust_policy",
      name: ctx.params.AWS_STORAGE_ROLE_NAME,
      attributes: {
        principal: String(ctx.outputs.storageAwsIamUserArn ?? ""),
        // The external id is a secret-ish value; the report masks it and the
        // registry keeps only the fact that a condition is present.
        externalIdCondition: "sts:ExternalId",
      },
    };
  },

  handoff: {
    terraform: {
      type: "aws_iam_role",
      address: "aws_iam_role.snowflake_storage",
      importId: (ctx) => ctx.params.AWS_STORAGE_ROLE_NAME,
    },
  },
};
