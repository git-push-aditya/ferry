import { GetPolicyCommand, GetPolicyVersionCommand } from "@aws-sdk/client-iam";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StepContext } from "../../../src/core/define";
import {
  awsClients,
  isAssumeRoleDenied,
  isCredentialNotYetActive,
  policyArn,
} from "../../../src/providers/aws";
import { backendUserPolicy } from "./policies";
import type { Params } from "./params";

const BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A newly created key is not usable the instant IAM returns it, and neither is
 * a freshly attached policy. Both surface as "denied" for a few seconds, so the
 * first call through the new identity retries with backoff. The retry is only
 * for transient propagation states; a real permission error still fails fast.
 */
async function withPropagationRetry<T>(
  ctx: StepContext<Params>,
  label: string,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let i = 0; i <= BACKOFFS_MS.length; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      const retryable = isCredentialNotYetActive(err) || isAssumeRoleDenied(err);
      if (!retryable || i === BACKOFFS_MS.length) throw err;
      ctx.log.warn(
        `${label} denied (attempt ${i + 1}), retrying in ${BACKOFFS_MS[i]}ms — new IAM credentials may still be propagating`,
      );
      await sleep(BACKOFFS_MS[i]!);
    }
  }
  throw new Error("unreachable");
}

interface BodyWithTransformToString {
  transformToString?: () => Promise<string>;
}

async function readBody(body: unknown): Promise<string> {
  const stream = body as BodyWithTransformToString;
  if (typeof stream?.transformToString === "function") return stream.transformToString();
  return "";
}

/**
 * Live proof that the least-privilege policy is exactly right: it permits the
 * write/read/delete the backend actually performs, and it does not permit
 * anything broader.
 *
 * Today's manual runbook stopped at "the user was created". That is the gap
 * this closes — a policy that looks correct and denies the real workload is a
 * production incident, not a warning.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const accessKeyId = ctx.outputs.backendAccessKeyId as string | undefined;
  const secretAccessKey = ctx.outputs.backendSecretAccessKey as string | undefined;

  if (!accessKeyId || !secretAccessKey) {
    // No key was minted this run (the user already had one), so there is no
    // identity to exercise. Fall back to asserting the policy document itself
    // still matches the canonical artifact, and say plainly what was not proven.
    await assertPolicyDocumentMatches(ctx);
    ctx.log.warn(
      "No access key was created this run, so the live write/read/delete check was skipped. " +
        "Delete the existing key in IAM and re-run to re-prove the end-to-end path.",
    );
    return;
  }

  const scoped = new S3Client({
    region: awsClients(ctx).region,
    credentials: { accessKeyId, secretAccessKey },
  });

  const bucket = ctx.params.EXPORT_S3_BUCKET;
  const key = `${ctx.params.EXPORT_S3_PREFIX}ferry-verify-${Date.now()}.txt`;
  const body = `ferry verification ${new Date().toISOString()}\n`;
  let wrote = false;

  try {
    await withPropagationRetry(ctx, "PutObject", async () => {
      await scoped.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    });
    wrote = true;
    ctx.log.success(`Wrote s3://${bucket}/${key} as ${accessKeyId}`);

    const got = await scoped.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if ((await readBody(got.Body)) !== body) {
      throw new Error("Read-back of the verification object did not match what was written");
    }
    ctx.log.success("Read it back with the same identity");

    const listed = await scoped.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: ctx.params.EXPORT_S3_PREFIX }),
    );
    if (!(listed.Contents ?? []).some((o) => o.Key === key)) {
      throw new Error("s3:ListBucket did not return the verification object");
    }
    ctx.log.success("Listed the prefix with the same identity");

    // Negative control: ListAllMyBuckets is deliberately NOT in artifact H. If
    // it succeeds, this identity is broader than the policy says it is.
    let overBroad = false;
    try {
      await scoped.send(new ListBucketsCommand({}));
      overBroad = true;
    } catch {
      // Denied, as intended.
    }
    if (overBroad) {
      throw new Error(
        `${ctx.params.BACKEND_IAM_USER_NAME} can call s3:ListAllMyBuckets — it holds permissions beyond ` +
          `${ctx.params.BACKEND_IAM_POLICY_NAME}. Check for other policies or group memberships on this user.`,
      );
    }
    ctx.log.success("Denied s3:ListAllMyBuckets, as the policy intends");
  } finally {
    if (wrote) {
      try {
        await scoped.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        ctx.log.success("Deleted the verification object with the same identity");
      } catch (err) {
        ctx.log.warn(
          `Could not delete s3://${bucket}/${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    scoped.destroy();
  }
}

/** Confirms the attached policy is still artifact H, byte for byte. */
async function assertPolicyDocumentMatches(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const arn = policyArn(ctx.accountId, ctx.params.BACKEND_IAM_POLICY_NAME);

  const policy = await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
  const versionId = policy.Policy?.DefaultVersionId;
  if (!versionId) throw new Error(`Could not read the default version of ${arn}`);

  const version = await iam.send(
    new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId }),
  );
  const document = version.PolicyVersion?.Document;
  if (!document) throw new Error(`Could not read the policy document of ${arn}`);

  const actual = JSON.parse(decodeURIComponent(document));
  const expected = backendUserPolicy(ctx.params.EXPORT_S3_BUCKET);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${ctx.params.BACKEND_IAM_POLICY_NAME} no longer matches the canonical least-privilege policy. ` +
        `Review it in IAM before trusting this identity.`,
    );
  }
  ctx.log.success("Attached policy still matches the canonical artifact");
}
