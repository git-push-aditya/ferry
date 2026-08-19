import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";

export const paramsSchema = z.object({
  // This integration never creates or modifies the CI/OIDC role itself —
  // run github/setup-github-actions-oidc-role first. See README.
  AWS_ROLE_NAME: nonEmpty,

  S3_BUCKET_NAME: nonEmpty,
  // No trailing slash required — the policy document appends it.
  STATE_KEY_PREFIX: nonEmpty,

  // Deliberately no USE_DYNAMODB_LOCKING param: Terraform 1.10 (Nov 2024)
  // added native S3 state locking (conditional writes to a lock file
  // inside the same bucket) and has since deprecated dynamodb_table.
  // Shipping this integration with a DynamoDB path by default would be the
  // outdated setup this project exists to replace. See README.
});

export type Params = z.infer<typeof paramsSchema>;

export function inlinePolicyName(): string {
  return "ferry-terraform-state-backend";
}

/**
 * s3:ListBucket + GetBucketLocation are bucket-level; the object actions
 * (including DeleteObject, required by Terraform's native S3 locking —
 * which writes and removes a lock-file object via conditional writes) are
 * scoped to the state-key prefix specifically.
 */
export function terraformBackendPolicyDocument(bucket: string, prefix: string): object {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "TerraformStateBucket",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "TerraformStateObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: `arn:aws:s3:::${bucket}/${normalizedPrefix}*`,
      },
    ],
  };
}
