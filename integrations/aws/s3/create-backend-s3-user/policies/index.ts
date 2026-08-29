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
