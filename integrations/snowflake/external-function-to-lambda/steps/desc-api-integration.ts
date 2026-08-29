import type { Step } from "../../../../src/core/define";
import { descProperties, snowflakeClients } from "../../../../src/providers/snowflake";
import type { Params } from "../params";

/**
 * Read back the AWS identity Snowflake minted for this API integration —
 * a pure read, but it cannot live in check() since the integration may not
 * exist yet during the plan phase. Runs in apply, after api-integration,
 * feeding its two values to the shared iamTrustPolicyStep that follows.
 */
export const descApiIntegrationStep: Step<Params> = {
  id: "desc-api-integration",
  title: "DESC INTEGRATION → Snowflake AWS identity",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const properties = descProperties(
      await conn.runQuery(`DESC INTEGRATION ${ctx.params.SF_API_INTEGRATION_NAME};`),
    );

    const apiAwsIamUserArn = properties.get("API_AWS_IAM_USER_ARN");
    const apiAwsExternalId = properties.get("API_AWS_EXTERNAL_ID");
    if (!apiAwsIamUserArn || !apiAwsExternalId) {
      throw new Error("DESC INTEGRATION did not return API_AWS_IAM_USER_ARN / API_AWS_EXTERNAL_ID");
    }

    ctx.log.info(`Snowflake IAM user: ${apiAwsIamUserArn}`);
    return { apiAwsIamUserArn, apiAwsExternalId };
  },

  async rollback() {},
};
