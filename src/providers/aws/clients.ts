import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { EC2Client } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AwsCredentials } from "./credentials";

export const AWS_PROVIDER_ID = "aws";

export interface AwsClients {
  s3: S3Client;
  iam: IAMClient;
  sts: STSClient;
  ec2: EC2Client;
  ssm: SSMClient;
  secretsManager: SecretsManagerClient;
  region: string;
}

function credentials(env: AwsCredentials) {
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

export function makeS3Client(env: AwsCredentials): S3Client {
  return new S3Client({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeIamClient(env: AwsCredentials): IAMClient {
  // IAM is a global service; the SDK still requires a region for signing.
  return new IAMClient({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeStsClient(env: AwsCredentials): STSClient {
  return new STSClient({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeEc2Client(env: AwsCredentials): EC2Client {
  return new EC2Client({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeSsmClient(env: AwsCredentials): SSMClient {
  return new SSMClient({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeSecretsManagerClient(env: AwsCredentials): SecretsManagerClient {
  return new SecretsManagerClient({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeAwsClients(env: AwsCredentials): AwsClients {
  return {
    s3: makeS3Client(env),
    iam: makeIamClient(env),
    sts: makeStsClient(env),
    ec2: makeEc2Client(env),
    ssm: makeSsmClient(env),
    secretsManager: makeSecretsManagerClient(env),
    region: env.AWS_REGION,
  };
}

/** Typed accessor so steps don't cast `ctx.clients` themselves. */
export function awsClients(ctx: { clients: Record<string, unknown> }): AwsClients {
  const clients = ctx.clients[AWS_PROVIDER_ID] as AwsClients | undefined;
  if (!clients) {
    throw new Error(`This step needs AWS clients — add "aws" to the integration's credentials`);
  }
  return clients;
}
