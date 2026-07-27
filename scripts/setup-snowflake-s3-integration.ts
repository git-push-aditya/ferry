import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreateRoleCommand,
  GetPolicyCommand,
  GetRoleCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { loadIntegrationEnv } from "./lib/env";
import { makeIamClient, makeS3Client, makeStsClient } from "./lib/aws";
import { ensure } from "./lib/ensure";
import { setStepTotal, step, info, warn, success, error as logError } from "./lib/logger";
import { connect, selfCheck, type SnowflakeConnection } from "./lib/snowflake";
import { finalRoleTrustPolicy, initialRoleTrustPolicy, integrationRolePolicy } from "./lib/policies";
import { describeAwsError, isAssumeRoleDenied } from "./lib/errors";
import { writeReport } from "./lib/report";

const TOTAL_STEPS = 14;
const DRY_RUN = process.argv.includes("--dry-run");

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

  step("Ensure S3 bucket");
  await ensure(
    `Bucket ${env.EXPORT_S3_BUCKET}`,
    async () => {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: env.EXPORT_S3_BUCKET }));
        return true;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (status === 404) return false;
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
  await s3.send(
    new PutObjectCommand({ Bucket: env.EXPORT_S3_BUCKET, Key: env.EXPORT_S3_PREFIX, Body: "" }),
  );
  info(`Prefix marker s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX} present`);

  step("Ensure IAM policy (artifact A)");
  const policyArn = `arn:aws:iam::${accountId}:policy/${env.AWS_STORAGE_POLICY_NAME}`;
  await ensure(
    `Policy ${env.AWS_STORAGE_POLICY_NAME}`,
    async () => {
      try {
        await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
        return true;
      } catch (err) {
        if ((err as { name?: string })?.name === "NoSuchEntity") return false;
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

  step("Ensure IAM role + attach policy");
  await ensure(
    `Role ${env.AWS_STORAGE_ROLE_NAME}`,
    async () => {
      try {
        await iam.send(new GetRoleCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME }));
        return true;
      } catch (err) {
        if ((err as { name?: string })?.name === "NoSuchEntity") return false;
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
  await iam.send(new AttachRolePolicyCommand({ RoleName: env.AWS_STORAGE_ROLE_NAME, PolicyArn: policyArn }));
  success("Policy attached to role");

  step("Connect to Snowflake");
  await selfCheck(env);
  const sf: SnowflakeConnection = await connect(env);
  info("Connected; SELECT 1 self-check passed");

  try {
    step("Create/reconcile Snowflake storage integration (artifact D)");
    const roleArn = `arn:aws:iam::${accountId}:role/${env.AWS_STORAGE_ROLE_NAME}`;
    await sf.runQuery(
      `CREATE STORAGE INTEGRATION IF NOT EXISTS ${env.SF_STORAGE_INTEGRATION_NAME}
        TYPE = EXTERNAL_STAGE
        STORAGE_PROVIDER = 'S3'
        STORAGE_AWS_ROLE_ARN = '${roleArn}'
        ENABLED = TRUE
        STORAGE_ALLOWED_LOCATIONS = ('s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}');`,
    );
    await sf.runQuery(
      `ALTER STORAGE INTEGRATION ${env.SF_STORAGE_INTEGRATION_NAME} SET
        STORAGE_AWS_ROLE_ARN = '${roleArn}',
        ENABLED = TRUE,
        STORAGE_ALLOWED_LOCATIONS = ('s3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}');`,
    );
    success("Storage integration created/reconciled");

    step("DESC INTEGRATION (artifact E)");
    const descRows = await sf.runQuery(`DESC INTEGRATION ${env.SF_STORAGE_INTEGRATION_NAME};`);
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

    step("Create external stage (artifact F)");
    await sf.runQuery(
      `CREATE STAGE IF NOT EXISTS ${env.SF_STAGE_NAME}
        STORAGE_INTEGRATION = ${env.SF_STORAGE_INTEGRATION_NAME}
        URL = 's3://${env.EXPORT_S3_BUCKET}/${env.EXPORT_S3_PREFIX}'
        FILE_FORMAT = (TYPE = CSV);`,
    );
    success("Stage ready");

    step("Verification COPY (artifact G) with retry");
    const backoffsMs = [2000, 4000, 8000, 16000, 30000, 30000];
    let copySucceeded = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffsMs.length; attempt += 1) {
      try {
        await sf.runQuery(
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
  } finally {
    step("Close Snowflake connection");
    await sf.close();
  }
}

main().catch((err) => {
  logError(describeAwsError(err));
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
