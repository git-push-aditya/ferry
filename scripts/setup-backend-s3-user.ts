import { chmod, writeFile } from "node:fs/promises";
import {
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreatePolicyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeletePolicyCommand,
  DeleteUserCommand,
  DetachUserPolicyCommand,
  GetPolicyCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  ListAttachedUserPoliciesCommand,
} from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { loadBackendEnv } from "./lib/env";
import { makeIamClient, makeStsClient } from "./lib/aws";
import { ensure } from "./lib/ensure";
import { setStepTotal, step, info, warn, success, error as logError } from "./lib/logger";
import { backendUserPolicy } from "./lib/policies";
import { describeAwsError, isAwsError } from "./lib/errors";
import { writeReport } from "./lib/report";
import {
  createRollbackStack,
  disarmRollback,
  installRollbackSignalHandlers,
  registerRollback,
  runRollback,
} from "./lib/rollback";

function isNoSuchEntity(err: unknown): boolean {
  return (err as { name?: string })?.name === "NoSuchEntityException";
}

const TOTAL_STEPS = 7;
const DRY_RUN = process.argv.includes("--dry-run");
const WRITE_ENV = process.argv.includes("--write-env");

async function main(): Promise<void> {
  setStepTotal(TOTAL_STEPS);

  step("Load + validate environment");
  const env = loadBackendEnv();
  success("Environment valid");

  const iam = makeIamClient(env);
  const sts = makeStsClient(env);

  step("STS GetCallerIdentity");
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account;
  if (!accountId) throw new Error("STS GetCallerIdentity did not return an Account id");
  info(`Provisioning as ${identity.Arn} (account ${accountId})`);

  if (DRY_RUN) {
    console.log("\n--dry-run: validated environment and credentials. Plan:");
    console.log(`  1. Ensure IAM policy ${env.BACKEND_IAM_POLICY_NAME} exists`);
    console.log(`  2. Ensure IAM user ${env.BACKEND_IAM_USER_NAME} exists (programmatic only)`);
    console.log(`  3. Attach policy to user`);
    console.log(`  4. Create access key (skip if user already holds 2)`);
    console.log("No changes made.");
    return;
  }

  const rollback = createRollbackStack();
  installRollbackSignalHandlers(rollback);

  try {
    step("Ensure IAM policy (artifact H)");
    const policyArn = `arn:aws:iam::${accountId}:policy/${env.BACKEND_IAM_POLICY_NAME}`;
    const policyCreated = await ensure(
      `Policy ${env.BACKEND_IAM_POLICY_NAME}`,
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
            PolicyName: env.BACKEND_IAM_POLICY_NAME,
            PolicyDocument: JSON.stringify(backendUserPolicy(env.EXPORT_S3_BUCKET)),
          }),
        );
      },
    );
    if (policyCreated) {
      registerRollback(rollback, `IAM policy ${env.BACKEND_IAM_POLICY_NAME}`, async () => {
        await iam.send(new DeletePolicyCommand({ PolicyArn: policyArn }));
      });
    }

    step("Ensure IAM user (programmatic access only)");
    const userCreated = await ensure(
      `User ${env.BACKEND_IAM_USER_NAME}`,
      async () => {
        try {
          await iam.send(new GetUserCommand({ UserName: env.BACKEND_IAM_USER_NAME }));
          return true;
        } catch (err) {
          if (isNoSuchEntity(err)) return false;
          throw err;
        }
      },
      async () => {
        await iam.send(new CreateUserCommand({ UserName: env.BACKEND_IAM_USER_NAME }));
      },
    );
    if (userCreated) {
      registerRollback(rollback, `IAM user ${env.BACKEND_IAM_USER_NAME}`, async () => {
        await iam.send(
          new DeleteUserCommand({ UserName: env.BACKEND_IAM_USER_NAME }),
        );
      });
    }

    step("Attach policy to user");
    // AttachUserPolicy is idempotent, so it can't tell us whether the attachment
    // is ours. Check first — detaching a pre-existing attachment on rollback
    // would damage state this run did not create.
    const attachedBefore = await iam.send(
      new ListAttachedUserPoliciesCommand({ UserName: env.BACKEND_IAM_USER_NAME }),
    );
    const attachmentPreexisted = (attachedBefore.AttachedPolicies ?? []).some(
      (p) => p.PolicyArn === policyArn,
    );
    await iam.send(
      new AttachUserPolicyCommand({ UserName: env.BACKEND_IAM_USER_NAME, PolicyArn: policyArn }),
    );
    success("Policy attached to user");
    if (!attachmentPreexisted) {
      registerRollback(rollback, `Policy attached to ${env.BACKEND_IAM_USER_NAME}`, async () => {
        try {
          await iam.send(
            new DetachUserPolicyCommand({ UserName: env.BACKEND_IAM_USER_NAME, PolicyArn: policyArn }),
          );
        } catch (err) {
          if (!isNoSuchEntity(err)) throw err;
        }
      });
    }

    step("Create access key");
    const existingKeys = await iam.send(new ListAccessKeysCommand({ UserName: env.BACKEND_IAM_USER_NAME }));
    const keyMetadata = existingKeys.AccessKeyMetadata ?? [];
    if (keyMetadata.length >= 2) {
      warn(`User already holds ${keyMetadata.length} access keys (AWS max is 2) — not creating another`);
      for (const key of keyMetadata) info(`  existing key: ${key.AccessKeyId}`);
      throw new Error("Delete/rotate an existing key before requesting a new one.");
    }

    const created = await iam.send(new CreateAccessKeyCommand({ UserName: env.BACKEND_IAM_USER_NAME }));
    const accessKey = created.AccessKey;
    if (!accessKey?.AccessKeyId || !accessKey?.SecretAccessKey) {
      throw new Error("CreateAccessKey did not return an access key pair");
    }
    registerRollback(rollback, `Access key ${accessKey.AccessKeyId}`, async () => {
      try {
        await iam.send(
          new DeleteAccessKeyCommand({ UserName: env.BACKEND_IAM_USER_NAME, AccessKeyId: accessKey.AccessKeyId }),
        );
      } catch (err) {
        if (!isNoSuchEntity(err)) throw err;
      }
    });

    step("Write report");
    const userArn = `arn:aws:iam::${accountId}:user/${env.BACKEND_IAM_USER_NAME}`;
    const reportPath = await writeReport(
      env.BACKEND_IAM_USER_NAME,
      `# Backend S3 IAM User — \`${env.BACKEND_IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`setup:backend\`. Contains a live
> AWS secret access key — treat as sensitive, do not commit or share. Rotate
> the key in IAM if this file leaks.

## AWS IAM

- User name: \`${env.BACKEND_IAM_USER_NAME}\`
- User ARN: \`${userArn}\`
- Policy name: \`${env.BACKEND_IAM_POLICY_NAME}\`
- Policy ARN: \`${policyArn}\`

## S3 bucket

- Bucket: \`${env.EXPORT_S3_BUCKET}\`

## Access key

- AWS_ACCESS_KEY_ID: \`${accessKey.AccessKeyId}\`
- AWS_SECRET_ACCESS_KEY: \`${accessKey.SecretAccessKey}\`
`,
    );
    success(`Credentials written to ${reportPath} (chmod 0600) — not printed to stdout`);
    info(`AWS_ACCESS_KEY_ID=${accessKey.AccessKeyId}`);

    if (WRITE_ENV) {
      const path = "./.env.backend";
      await writeFile(
        path,
        `AWS_ACCESS_KEY_ID=${accessKey.AccessKeyId}\nAWS_SECRET_ACCESS_KEY=${accessKey.SecretAccessKey}\n`,
        { mode: 0o600 },
      );
      await chmod(path, 0o600);
      success(`Also written to ${path} (chmod 0600)`);
    }

    // Past this point the run is a success — nothing may be torn down.
    disarmRollback(rollback);
  } catch (err) {
    await runRollback(rollback);
    throw err;
  }
}

main().catch((err) => {
  if (isAwsError(err)) logError(describeAwsError(err));
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
