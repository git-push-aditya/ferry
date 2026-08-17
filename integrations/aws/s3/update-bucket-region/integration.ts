import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep, s3BucketStep } from "../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { deleteOldBucketStep } from "./steps/delete-old-bucket";
import { migrateObjectsStep } from "./steps/migrate-objects";
import { verify } from "./verify";

/**
 * S3 has no in-place region migration — this composes create-new + copy +
 * verify + delete-old as a flat, ordered step list: exactly the pattern the
 * project's own discipline favors over inventing a dependency graph.
 *
 * Bucket-level settings (versioning, encryption, public-access-block, policy,
 * tags) are NOT carried over automatically — CreateBucket/CopyObject don't
 * copy them, and reading them live off the old bucket to mirror onto the new
 * one doesn't fit this project's step contract (a step's desired-state
 * accessors are functions of params, not of another step's live-read
 * outputs). Run `aws/s3/update-bucket-versioning`, `update-bucket-encryption`,
 * `update-bucket-permissions`, and `tag-bucket` against the new bucket
 * afterward if you need those carried over — see README.
 */
export default defineIntegration<Params>({
  id: "aws/s3/update-bucket-region",
  schemaVersion: 1,
  summary:
    "Migrates a bucket to a new region via create-new + copy + verify + delete-old, proven with object parity.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({
      bucket: (p) => p.OLD_S3_BUCKET_NAME,
      id: "old-bucket-exists",
      title: "Confirm the old bucket already exists",
    }),
    s3BucketStep<Params>({ bucket: (p) => p.NEW_S3_BUCKET_NAME }),
    migrateObjectsStep,
    deleteOldBucketStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.OLD_S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Region Migration — \`${p.OLD_S3_BUCKET_NAME}\` → \`${p.NEW_S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/update-bucket-region\`.

## Setting

- Old bucket: \`${p.OLD_S3_BUCKET_NAME}\` (deleted after migration)
- New bucket: \`${p.NEW_S3_BUCKET_NAME}\` (created in whatever region your
  root \`AWS_REGION\` credential specifies for this run)

## Verification

Verified — every migrated object is present in the new bucket, and the old
bucket no longer exists.

## Follow-up: bucket-level settings are not carried over automatically

Versioning, default encryption, public-access-block, bucket policy, and tags
are **not** mirrored onto the new bucket by this integration. Run these
against \`${p.NEW_S3_BUCKET_NAME}\` afterward if the old bucket had them:

- \`aws/s3/update-bucket-versioning\`
- \`aws/s3/update-bucket-encryption\`
- \`aws/s3/update-bucket-permissions\`
- \`aws/s3/tag-bucket\`
`;
  },
});
