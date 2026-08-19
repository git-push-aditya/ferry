import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";

export const paramsSchema = z.object({
  SF_API_INTEGRATION_NAME: nonEmpty,
  AWS_API_ROLE_NAME: nonEmpty,

  // Pre-existing — this integration never provisions the Lambda or API
  // Gateway resource itself. Must already be deployed (a real, live invoke
  // URL) before this runs, since API_ALLOWED_PREFIXES and the external
  // function's AS clause both need a real URL to point at. See README.
  API_GATEWAY_INVOKE_URL: nonEmpty,

  SF_EXTERNAL_FUNCTION_NAME: nonEmpty,
  // Comma-separated Snowflake SQL types, e.g. "VARCHAR, NUMBER" — used both
  // in the function's own signature and in DROP FUNCTION's required
  // signature (Snowflake functions can be overloaded by argument types).
  SF_FUNCTION_ARG_TYPES: nonEmpty,
  SF_FUNCTION_RETURNS: nonEmpty,

  // Comma-separated literal SQL values plugged into verify()'s smoke-test
  // SELECT, in the same order as SF_FUNCTION_ARG_TYPES.
  SMOKE_TEST_ARGS: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;

export function argTypesList(p: Params): string[] {
  return p.SF_FUNCTION_ARG_TYPES.split(",").map((s) => s.trim());
}

export function functionSignature(p: Params): string {
  return `${p.SF_EXTERNAL_FUNCTION_NAME}(${argTypesList(p).join(", ")})`;
}

/**
 * Phase B of the two-phase dance: the role has to exist before Snowflake
 * will mint the API integration's real identity, so it is created trusting
 * our own account root and nothing else, then patched (via the shared
 * iamTrustPolicyStep) the moment the real principal is known. Same
 * mechanic as create-storage-s3-integration's placeholder trust policy —
 * this is that pattern's second bespoke occurrence, not its third (see
 * docs/plan/aws-snowflake.md), so it is not promoted to a shared factory.
 */
export function placeholderTrustPolicy(accountId: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

export function finalTrustPolicy(apiAwsIamUserArn: string, apiAwsExternalId: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: apiAwsIamUserArn },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": apiAwsExternalId } },
      },
    ],
  };
}
