import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  DeletePolicyCommand,
  DeleteRoleCommand,
  DetachRolePolicyCommand,
  GetPolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { loadIntegrationEnv } from "./lib/env";
import { makeIamClient, makeS3Client, makeStsClient } from "./lib/aws";
import { ensure } from "./lib/ensure";
import { setStepTotal, step, info, warn, success, error as logError } from "./lib/logger";
import { connect, selfCheck, type SnowflakeConnection } from "./lib/snowflake";
import { finalRoleTrustPolicy, initialRoleTrustPolicy, integrationRolePolicy } from "./lib/policies";
import { describeAwsError, isAssumeRoleDenied, isAwsError } from "./lib/errors";
import { writeReport } from "./lib/report";
import {
  createRollbackStack,
  disarmRollback,
  installRollbackSignalHandlers,
  registerRollback,
  runRollback,
} from "./lib/rollback";
import { pollUntil } from "./lib/wait";

const TOTAL_STEPS = 14;
const DRY_RUN = process.argv.includes("--dry-run");

// AWS IAM is eventually consistent: a newly created role/policy, or a role
// whose trust policy was just patched, isn't reliably usable everywhere for a
// few seconds. Rather than guess a fixed sleep, poll a read-your-write check
// until it's actually confirmed (bounded by a timeout), then add a smaller
// fixed buffer for the parts (STS AssumeRole evaluation) that can lag behind
// even a confirmed GetRole/GetPolicy read. This avoids tripping the
// (rollback-triggering) failure path on a fresh account.
const IAM_CREATE_POLL_INTERVAL_MS = 3_000;
const IAM_CREATE_POLL_TIMEOUT_MS = 20_000;
const IAM_CREATE_BUFFER_WAIT_MS = 15_000;
const TRUST_POLICY_POLL_INTERVAL_MS = 3_000;
const TRUST_POLICY_POLL_TIMEOUT_MS = 30_000;
const TRUST_POLICY_BUFFER_WAIT_MS = 20_000;

function isNoSuchEntity(err: unknown): boolean {
  return (err as { name?: string })?.name === "NoSuchEntityException";
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * SHOW ... LIKE uses SQL LIKE patterns, where '_' matches any single character —
 * and our resource names contain underscores. Row count alone would report a
 * near-miss name as "already exists" and silently skip registering rollback,
 * so match the returned name exactly (Snowflake upper-cases bare identifiers).
 */
function showMatchesExactly(rows: Record<string, unknown>[], name: string): boolean {
  const target = name.toUpperCase();
  return rows.some((row) => String(row.name ?? row.NAME ?? "").toUpperCase() === target);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  setStepTotal(TOTAL_STEPS);

  step("Load + validate environment");
  const env = loadIntegrationEnv();
  success("Environment valid");

  const s3 = makeS3Client(env);
  const iam = makeIamClient(env);
  const sts = makeStsClient(env);

  step("STS GetCallerIdentity");
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account;
  if (!accountId) throw new Error("STS GetCallerIdentity did not return an Account id");
  info(`Provisioning as ${identity.Arn} (account ${accountId})`);

  if (DRY_RUN) {
    console.log("\n--dry-run: validated environment and credentials. Plan:");
    console.log(`  1. Ensure S3 bucket s3://${env.EXPORT_S3_BUCKET} exists (region ${env.AWS_REGION})`);
    console.log(`  2. Ensure IAM policy ${env.AWS_STORAGE_POLICY_NAME} exists`);
    console.log(`  3. Ensure IAM role ${env.AWS_STORAGE_ROLE_NAME} exists + policy attached`);
    console.log(`  4. Create/reconcile Snowflake storage integration ${env.SF_STORAGE_INTEGRATION_NAME}`);
    console.log(`  5. DESC INTEGRATION, patch role trust policy with Snowflake identity`);
    console.log(`  6. Create stage ${env.SF_STAGE_NAME}, run verification COPY, clean up`);
    console.log("No changes made.");
    return;
  }

  const rollback = createRollbackStack();
  installRollbackSignalHandlers(rollback);

  // Held outside the try so rollback (in catch) still has a live connection to
  // DROP the Snowflake objects, and the connection is only closed afterwards.
  let sf: SnowflakeConnection | undefined;

  try {
    step("Ensure S3 bucket");
    const bucketCreated = await ensure(
      `Bucket ${env.EXPORT_S3_BUCKET}`,
      async () => {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: env.EXPORT_S3_BUCKET }));
          return true;
        } catch (err) {
          if (isNotFound(err)) return false;
          throw err;
        }
      },
      async () => {
        try {
          await s3.send(
            new CreateBucketCommand({
              Bucket: env.EXPORT_S3_BUCKET,
              ...(env.AWS_REGION === "us-east-1"
                ? {}
                : { CreateBucketConfiguration: { LocationConstraint: env.AWS_REGION as never } }),
            }),
          );
        } catch (err) {
          const name = (err as { name?: string })?.name;
          if (name !== "BucketAlreadyOwnedByYou") throw err;
        }
      },
    );
    if (bucketCreated) {
      registerRollback(rollback, `S3 bucket ${env.EXPORT_S3_BUCKET}`, async () => {
        // Only reachable for a bucket this run created, so emptying it is safe.
        let continuationToken: string | undefined;
        do {
          const listed = await s3.send(
            new ListObjectsV2Command({
              Bucket: env.EXPORT_S3_BUCKET,
              ContinuationToken: continuationToken,
            }),
          );
          const objects = listed.Contents ?? [];
          if (objects.length) {
            await s3.send(
              new DeleteObjectsCommand({
                Bucket: env.EXPORT_S3_BUCKET,
                Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
              }),
            );
          }
          continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (continuationToken);
        await s3.send(new DeleteBucketCommand({ Bucket: env.EXPORT_S3_BUCKET }));
      });
    }

    let markerCreated = false;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: env.EXPORT_S3_BUCKET, Key: env.EXPORT_S3_PREFIX }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      markerCreated = true;
    }
    await s3.send(
      new PutObjectCommand({ Bucket: env.EXPORT_S3_BUCKET, Key: env.EXPORT_S3_PREFIX, Body: "" }),
    );
    info(`Prefix marker s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX} present`);
    if (markerCreated && !bucketCreated) {
      registerRollback(rollback, `Prefix marker ${env.EXPORT_S3_PREFIX}`, async () => {
        await s3.send(new DeleteObjectCommand({ Bucket: env.EXPORT_S3_BUCKET, Key: env.EXPORT_S3_PREFIX }));
      });
    }

    step("Ensure IAM policy (artifact A)");
    const policyArn = `arn:aws:iam::${accountId}:policy/${env.AWS_STORAGE_POLICY_NAME}`;
    const policyCreated = await ensure(
      `Policy ${env.AWS_STORAGE_POLICY_NAME}`,
      async () => {
        try {
          await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
          return true;
        } catch (err) {
          if (isNoSuchEntity(err)) return false;
          throw err;
        }
      },
      async () => {
        await iam.send(
          new CreatePolicyCommand({
            PolicyName: env.AWS_STORAGE_POLICY_NAME,
            PolicyDocument: JSON.stringify(integrationRolePolicy(env.EXPORT_S3_BUCKET, env.EXPORT_S3_PREFIX)),
          }),
        );
      },
    );
    if (policyCreated) {
      registerRollback(rollback, `IAM policy ${env.AWS_STORAGE_POLICY_NAME}`, async () => {
        await iam.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
      });
    }

    step("Ensure IAM role + attach policy");
    const roleCreated = await ensure(
      `Role ${env.AWS_STORAGE_ROLE_NAME}`,
      async () => {
        try {
          await iam.send(new GetRoleCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME }));
          return true;
        } catch (err) {
          if (isNoSuchEntity(err)) return false;
          throw err;
        }
      },
      async () => {
        await iam.send(
          new CreateRoleCommand({
            RoleName: env.AWS_STORAGE_ROLE_NAME,
            AssumeRolePolicyDocument: JSON.stringify(initialRoleTrustPolicy(accountId)),
          }),
        );
      },
    );
    if (roleCreated) {
      registerRollback(rollback, `IAM role ${env.AWS_STORAGE_ROLE_NAME}`, async () => {
        await iam.send(new DeleteRoleCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME }));
      });
    }

    // AttachRolePolicy is idempotent, so it can't tell us whether the attachment
    // is ours. Check first — detaching a pre-existing attachment on rollback
    // would damage state this run did not create.
    const attachedBefore = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME }),
    );
    const attachmentPreexisted = (attachedBefore.AttachedPolicies ?? []).some(
      (p) => p.PolicyArn === policyArn,
    );
    await iam.send(new AttachRolePolicyCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME, PolicyArn: policyArn }));
    success("Policy attached to role");
    if (!attachmentPreexisted) {
      registerRollback(rollback, `Policy attached to ${env.AWS_STORAGE_ROLE_NAME}`, async () => {
        try {
          await iam.send(
            new DetachRolePolicyCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME, PolicyArn: policyArn }),
          );
        } catch (err) {
          if (!isNoSuchEntity(err)) throw err;
        }
      });
    }

    if (policyCreated || roleCreated) {
      await pollUntil(
        async () => {
          try {
            if (policyCreated) await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
            if (roleCreated) await iam.send(new GetRoleCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME }));
            return true;
          } catch (err) {
            if (isNoSuchEntity(err)) return false;
            throw err;
          }
        },
        {
          intervalMs: IAM_CREATE_POLL_INTERVAL_MS,
          timeoutMs: IAM_CREATE_POLL_TIMEOUT_MS,
          label: "New IAM policy/role readable",
        },
      );
      info(
        `Waiting an additional ${IAM_CREATE_BUFFER_WAIT_MS / 1000}s for IAM propagation to other AWS services`,
      );
      await sleep(IAM_CREATE_BUFFER_WAIT_MS);
    }

    step("Connect to Snowflake");
    await selfCheck(env);
    const conn = await connect(env);
    sf = conn;
    info("Connected; SELECT 1 self-check passed");

    step("Create/reconcile Snowflake storage integration (artifact D)");
    const roleArn = `arn:aws:iam::${accountId}:role/${env.AWS_STORAGE_ROLE_NAME}`;
    const integrationPreexisted = showMatchesExactly(
      await conn.runQuery(`SHOW INTEGRATIONS LIKE '${env.SF_STORAGE_INTEGRATION_NAME}';`),
      env.SF_STORAGE_INTEGRATION_NAME,
    );
    await conn.runQuery(
      `CREATE STORAGE INTEGRATION IF NOT EXISTS ${env.SF_STORAGE_INTEGRATION_NAME}
        TYPE = EXTERNAL_STAGE
        STORAGE_PROVIDER = 'S3'
        STORAGE_AWS_ROLE_ARN = '${roleArn}'
        ENABLED = TRUE
        STORAGE_ALLOWED_LOCATIONS = ('s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}');`,
    );
    await conn.runQuery(
      `ALTER STORAGE INTEGRATION ${env.SF_STORAGE_INTEGRATION_NAME} SET
        STORAGE_AWS_ROLE_ARN = '${roleArn}',
        ENABLED = TRUE,
        STORAGE_ALLOWED_LOCATIONS = ('s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}');`,
    );
    success("Storage integration created/reconciled");
    if (!integrationPreexisted) {
      registerRollback(rollback, `Storage integration ${env.SF_STORAGE_INTEGRATION_NAME}`, async () => {
        await conn.runQuery(`DROP STORAGE INTEGRATION IF EXISTS ${env.SF_STORAGE_INTEGRATION_NAME};`);
      });
    }

    step("DESC INTEGRATION (artifact E)");
    const descRows = await conn.runQuery(`DESC INTEGRATION ${env.SF_STORAGE_INTEGRATION_NAME};`);
    const propMap = new Map<string, string>();
    for (const row of descRows) {
      const property = String(row.property ?? row.PROPERTY ?? "");
      const value = String(row.property_value ?? row.PROPERTY_VALUE ?? "");
      propMap.set(property, value);
    }
    const storageAwsIamUserArn = propMap.get("STORAGE_AWS_IAM_USER_ARN");
    const storageAwsExternalId = propMap.get("STORAGE_AWS_EXTERNAL_ID");
    if (!storageAwsIamUserArn || !storageAwsExternalId) {
      throw new Error(
        "DESC INTEGRATION did not return STORAGE_AWS_IAM_USER_ARN / STORAGE_AWS_EXTERNAL_ID",
      );
    }
    info(`Snowflake IAM user: ${storageAwsIamUserArn}`);

    step("Patch role trust policy (artifact C)");
    await iam.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: env.AWS_STORAGE_ROLE_NAME,
        PolicyDocument: JSON.stringify(finalRoleTrustPolicy(storageAwsIamUserArn, storageAwsExternalId)),
      }),
    );
    success("Trust policy patched with Snowflake principal + external id");
    await pollUntil(
      async () => {
        const role = await iam.send(new GetRoleCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME }));
        const doc = role.Role?.AssumeRolePolicyDocument;
        if (!doc) return false;
        const decoded = decodeURIComponent(doc);
        return decoded.includes(storageAwsExternalId) && decoded.includes(storageAwsIamUserArn);
      },
      {
        intervalMs: TRUST_POLICY_POLL_INTERVAL_MS,
        timeoutMs: TRUST_POLICY_POLL_TIMEOUT_MS,
        label: "Trust policy read-back matches the patch",
      },
    );
    info(
      `Waiting an additional ${TRUST_POLICY_BUFFER_WAIT_MS / 1000}s before the verification COPY — ` +
        "STS AssumeRole evaluation can lag behind a confirmed GetRole read",
    );
    await sleep(TRUST_POLICY_BUFFER_WAIT_MS);

    step("Create external stage (artifact F)");
    const stagePreexisted = showMatchesExactly(
      await conn.runQuery(`SHOW STAGES LIKE '${env.SF_STAGE_NAME}';`),
      env.SF_STAGE_NAME,
    );
    await conn.runQuery(
      `CREATE STAGE IF NOT EXISTS ${env.SF_STAGE_NAME}
        STORAGE_INTEGRATION = ${env.SF_STORAGE_INTEGRATION_NAME}
        URL = 's3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}'
        FILE_FORMAT = (TYPE = CSV);`,
    );
    success("Stage ready");
    if (!stagePreexisted) {
      registerRollback(rollback, `Stage ${env.SF_STAGE_NAME}`, async () => {
        await conn.runQuery(`DROP STAGE IF EXISTS ${env.SF_STAGE_NAME};`);
      });
    }

    step("Verification COPY (artifact G) with retry");
    const backoffsMs = [2000, 4000, 8000, 16000, 30000, 30000];
    let copySucceeded = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffsMs.length; attempt += 1) {
      try {
        await conn.runQuery(
          `COPY INTO @${env.SF_STAGE_NAME}/setup_test
            FROM (SELECT CURRENT_TIMESTAMP)
            FILE_FORMAT = (TYPE = CSV) HEADER = TRUE OVERWRITE = TRUE;`,
        );
        copySucceeded = true;
        break;
      } catch (err) {
        lastErr = err;
        if (!isAssumeRoleDenied(err) || attempt === backoffsMs.length) throw err;
        warn(`COPY denied (attempt ${attempt + 1}), retrying in ${backoffsMs[attempt]}ms — trust policy may still be propagating`);
        await sleep(backoffsMs[attempt]);
      }
    }
    if (!copySucceeded) throw lastErr;
    success("Verification COPY succeeded");
    registerRollback(rollback, "Verification test object in S3", async () => {
      const stray = await s3.send(
        new ListObjectsV2Command({ Bucket: env.EXPORT_S3_BUCKET, Prefix: `${env.EXPORT_S3_PREFIX}setup_test` }),
      );
      const strayObjects = stray.Contents ?? [];
      if (strayObjects.length) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: env.EXPORT_S3_BUCKET,
            Delete: { Objects: strayObjects.map((o) => ({ Key: o.Key! })) },
          }),
        );
      }
    });

    step("Confirm object landed in S3, then clean up");
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: env.EXPORT_S3_BUCKET, Prefix: `${env.EXPORT_S3_PREFIX}setup_test` }),
    );
    const objects = listed.Contents ?? [];
    if (!objects.length) throw new Error("Verification object did not land in S3 under the expected prefix");
    info(`Found ${objects.length} verification object(s) in S3`);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.EXPORT_S3_BUCKET,
        Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
      }),
    );
    success("Verification object(s) removed");

    step("Summary");
    const maskedExternalId = `${"*".repeat(Math.max(storageAwsExternalId.length - 4, 0))}${storageAwsExternalId.slice(-4)}`;
    console.log(`
  Bucket:              s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}
  Storage integration: ${env.SF_STORAGE_INTEGRATION_NAME}
  Role ARN:            ${roleArn}
  Stage:               ${env.SF_STAGE_NAME}
  Snowflake IAM user:  ${storageAwsIamUserArn}
  External id:         ${maskedExternalId}
  ✅ verified`);

    const reportPath = await writeReport(
      env.SF_STORAGE_INTEGRATION_NAME,
      `# Snowflake ⇄ S3 Integration — \`${env.SF_STORAGE_INTEGRATION_NAME}\`

> Generated ${new Date().toISOString()} by \`setup:integration\`. Contains the
> role's trust-policy external id — treat as sensitive, do not commit or share.

## S3

- Bucket: \`${env.EXPORT_S3_BUCKET}\`
- Prefix: \`${env.EXPORT_S3_PREFIX}\`

## AWS IAM

- Policy name: \`${env.AWS_STORAGE_POLICY_NAME}\`
- Policy ARN: \`${policyArn}\`
- Role name: \`${env.AWS_STORAGE_ROLE_NAME}\`
- Role ARN: \`${roleArn}\`
- Trust policy principal (Snowflake IAM user): \`${storageAwsIamUserArn}\`
- Trust policy external id: \`${storageAwsExternalId}\`

## Snowflake

- Storage integration: \`${env.SF_STORAGE_INTEGRATION_NAME}\`
- Stage: \`${env.SF_STAGE_NAME}\`

## Verification

✅ Verified — a test COPY landed a CSV under \`s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}\` and was cleaned up.
`,
    );
    success(`Report written to ${reportPath}`);

    // Past this point the run is a success — nothing may be torn down.
    disarmRollback(rollback);
  } catch (err) {
    // Runs BEFORE the finally below, so Snowflake DROPs still have a live connection.
    await runRollback(rollback);
    throw err;
  } finally {
    if (sf) {
      step("Close Snowflake connection");
      await sf.close();
    }
  }
}

main().catch((err) => {
  if (isAwsError(err)) logError(describeAwsError(err));
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
