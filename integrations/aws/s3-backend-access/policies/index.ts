// Builders that emit the CANONICAL TESTED ARTIFACTS verbatim (see docs/completeIntegration.md).
// Do NOT add, remove, or broaden any action, resource, principal, or condition here.
// The only variation permitted is the parameter substitutions below.

/**
 * Artifact H — the backend service's least-privilege policy.
 *
 * Object access is bucket-wide (`/*`), not prefix-scoped: that is what the
 * tested artifact says, and narrowing it here would quietly diverge from the
 * setup this was copied from.
 */
export function backendUserPolicy(bucket: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BucketAccess",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "ObjectAccess",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  };
}
