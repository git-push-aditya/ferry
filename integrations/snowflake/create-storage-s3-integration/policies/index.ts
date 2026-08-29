// Builders that emit the CANONICAL TESTED ARTIFACTS verbatim.
// Do NOT add, remove, or broaden any action, resource, principal, or condition here.
// The only variation permitted is the parameter substitutions below.
//
// Provenance: these documents were transcribed from a Snowflake-to-S3 setup
// performed and confirmed working by hand in July 2026. That runbook lived in
// `docs/completeIntegration.md`, which was removed during the Phase 1
// refactor -- so the "tested" claim currently rests on the transcription and
// on the unit tests that pin these exact documents, NOT on a run anyone can
// point at today. Phase 2.5 re-establishes the referent: once this
// integration has been run against live infrastructure, `docs/live-runs.md`
// records it and becomes what this header cites. Until then, treat "tested"
// as "carefully transcribed and pinned by tests", which is weaker.
// See docs/ferry-phase-2.5.md section 1.

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
