import type { Step } from "../../../../src/core/define";
import { descProperties, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Artifact E: read back the AWS identity Snowflake minted for this integration.
 *
 * This is a pure read, but it cannot live in check(): during the plan phase the
 * integration may not exist yet. It therefore runs in the apply phase, after
 * `storage-integration`, and hands its two values to `trust-policy`.
 */
export const descIntegrationStep: Step<Params> = {
  id: "desc-integration",
  title: "DESC INTEGRATION → Snowflake AWS identity (artifact E)",

  // Always runs: the values are needed fresh on every apply.
  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const properties = descProperties(
      await conn.runQuery(`DESC INTEGRATION ${ctx.params.SF_STORAGE_INTEGRATION_NAME};`),
    );

    const storageAwsIamUserArn = properties.get("STORAGE_AWS_IAM_USER_ARN");
    const storageAwsExternalId = properties.get("STORAGE_AWS_EXTERNAL_ID");
    if (!storageAwsIamUserArn || !storageAwsExternalId) {
      throw new Error(
        "DESC INTEGRATION did not return STORAGE_AWS_IAM_USER_ARN / STORAGE_AWS_EXTERNAL_ID",
      );
    }

    ctx.log.info(`Snowflake IAM user: ${storageAwsIamUserArn}`);
    return { storageAwsIamUserArn, storageAwsExternalId };
  },

  // Reading changes nothing, so there is nothing to undo.
  async rollback() {},
};
