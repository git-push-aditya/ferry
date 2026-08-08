import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentials } from "./credentials";

export const AWS_PROVIDER_ID = "aws";

export interface AwsClients {
  s3: S3Client;
  iam: IAMClient;
  sts: STSClient;
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

export function makeAwsClients(env: AwsCredentials): AwsClients {
  return {
    s3: makeS3Client(env),
    iam: makeIamClient(env),
    sts: makeStsClient(env),
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
