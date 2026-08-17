import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { s3BucketExistsGuardStep, s3BucketPolicyStep, s3PublicAccessBlockStep } from "../../../../src/providers/aws";
import { paramsSchema, parsedPolicy, type Params } from "./params";
import { verify } from "./verify";

/**
 * Reconciles bucket policy and public-access-block on a bucket that already
 * exists. ACLs are deliberately out of scope — see params.ts.
 *
 * PutPublicAccessBlock can make a permissive policy inert if applied after
 * it, so this reconciles the policy first and public-access-block second:
 * whatever BLOCK_PUBLIC_ACCESS says wins, which matches "block by default"
 * being the safer failure mode.
 */
export default defineIntegration<Params>({
  id: "aws/s3/update-bucket-permissions",
  schemaVersion: 1,
  summary:
    "Reconciles an existing bucket's policy and public-access-block, proven with a config round-trip and a live PAB check.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    s3BucketExistsGuardStep<Params>({ bucket: (p) => p.S3_BUCKET_NAME }),
    s3BucketPolicyStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      policy: (p) => parsedPolicy(p),
    }),
    s3PublicAccessBlockStep<Params>({
      bucket: (p) => p.S3_BUCKET_NAME,
      blocked: (p) => p.BLOCK_PUBLIC_ACCESS,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.S3_BUCKET_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Bucket Permissions — \`${p.S3_BUCKET_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/s3/update-bucket-permissions\`.

## Settings

| Setting | Value |
| --- | --- |
| Bucket policy | ${p.BUCKET_POLICY_JSON ? "set (see .env for the document)" : "not managed by ferry"} |
| Public access block | ${p.BLOCK_PUBLIC_ACCESS ? "blocking all public access" : "not blocking public access"} |

## Verification

Verified — confirmed the stored policy matches the desired document (a config
round-trip, not a live access check) and confirmed public-access-block
matches live against the bucket.
`;
  },
});
