// Builders that emit the CANONICAL TESTED ARTIFACTS verbatim.
// Do NOT add, remove, or broaden any action, resource, principal, or condition here.
// The only variation permitted is the parameter substitutions below.

/**
 * Artifact A — what the role is allowed to do to the bucket/prefix.
 *
 * `accessMode` defaults to "read-write" to match the original, unconditional
 * behavior of this policy exactly — existing callers that don't pass it see
 * no change. "read-only" removes the write actions (`s3:PutObject`,
 * `s3:DeleteObject`) from the object statement; the read-write action list is
 * otherwise untouched.
 */
export function integrationRolePolicy(
  bucket: string,
  prefix: string,
  accessMode: "read-only" | "read-write" = "read-write",
) {
  const objectActions =
    accessMode === "read-only"
      ? ["s3:GetObject", "s3:ListBucket"]
      : ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"];

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BucketPermissions",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "ObjectPermissions",
        Effect: "Allow",
        Action: objectActions,
        Resource: `arn:aws:s3:::${bucket}/${prefix}*`,
      },
    ],
  };
}

/**
 * Artifact B — the placeholder trust policy.
 *
 * The role has to exist before Snowflake will mint the external id that the
 * real trust policy needs, so it is created trusting our own account root and
 * nothing else, then patched (artifact C) the moment the real principal is known.
 */
export function initialRoleTrustPolicy(accountId: string) {
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

/** Artifact C — the real trust policy: Snowflake's IAM user, gated on the external id. */
export function finalRoleTrustPolicy(storageAwsIamUserArn: string, storageAwsExternalId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: storageAwsIamUserArn },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "sts:ExternalId": storageAwsExternalId },
        },
      },
    ],
  };
}
