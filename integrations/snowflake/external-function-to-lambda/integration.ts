import { defineIntegration, requireOutput } from "../../../src/core/define";
import { iamTrustPolicyStep } from "../../../src/providers/aws";
import { finalTrustPolicy, paramsSchema, type Params } from "./params";
import { apiIntegrationStep } from "./steps/api-integration";
import { apiRoleStep } from "./steps/api-role";
import { connectStep } from "./steps/connect";
import { descApiIntegrationStep } from "./steps/desc-api-integration";
import { externalFunctionStep } from "./steps/external-function";
import { verify } from "./verify";

/**
 * Wires a Snowflake EXTERNAL FUNCTION to invoke an AWS Lambda through API
 * Gateway. The step order encodes a real dependency and is not
 * rearrangeable: the IAM role must exist before Snowflake will mint a real
 * external id (api-role → api-integration → desc-api-integration → THIS
 * patches the trust policy), and the Lambda/API Gateway resource must
 * already be live before api-integration can be created at all (its
 * invoke URL is required immediately, unlike the AWS-side identity which
 * only exists after Snowflake mints it) — same two-phase shape as
 * snowflake/create-storage-s3-integration, this pattern's second bespoke
 * occurrence (see docs/plan/aws-snowflake.md's correction on this point).
 *
 * Never provisions the Lambda or API Gateway resource itself — those are
 * pre-existing inputs. See README.
 */
export default defineIntegration<Params>({
  id: "snowflake/external-function-to-lambda",
  schemaVersion: 1,
  summary:
    "Wires a Snowflake external function to an existing Lambda/API Gateway resource via a Snowflake-trusted IAM role, proven with a live invocation.",

  params: paramsSchema,
  credentials: ["aws", "snowflake"],

  steps: [
    connectStep,
    apiRoleStep,
    apiIntegrationStep,
    descApiIntegrationStep,
    iamTrustPolicyStep<Params>({
      roleName: (p) => p.AWS_API_ROLE_NAME,
      document: (ctx) =>
        finalTrustPolicy(
          requireOutput<string>(ctx, "apiAwsIamUserArn"),
          requireOutput<string>(ctx, "apiAwsExternalId"),
        ),
    }),
    externalFunctionStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.SF_EXTERNAL_FUNCTION_NAME,

  report(ctx) {
    const p = ctx.params;
    const iamUserArn = String(ctx.outputs.apiAwsIamUserArn ?? "");

    return `# Snowflake External Function → Lambda — \`${p.SF_EXTERNAL_FUNCTION_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/external-function-to-lambda\`.

## Snowflake

- API integration: \`${p.SF_API_INTEGRATION_NAME}\`
- External function: \`${p.SF_EXTERNAL_FUNCTION_NAME}(${p.SF_FUNCTION_ARG_TYPES}) RETURNS ${p.SF_FUNCTION_RETURNS}\`

## AWS

- Role: \`${p.AWS_API_ROLE_NAME}\`
- Trust policy principal (Snowflake IAM user): \`${iamUserArn}\`
- Invoke URL: \`${p.API_GATEWAY_INVOKE_URL}\`

## Verification

Verified — called the function live with the configured smoke-test
arguments and confirmed a non-null result came back through the real
Lambda round trip.
`;
  },
});
