import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";

interface AwsCreds {
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_SESSION_TOKEN?: string;
  AWS_REGION: string;
}

function credentials(env: AwsCreds) {
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

export function makeS3Client(env: AwsCreds): S3Client {
  return new S3Client({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeIamClient(env: AwsCreds): IAMClient {
  // IAM is a global service; the SDK still requires a region for signing.
  return new IAMClient({ region: env.AWS_REGION, credentials: credentials(env) });
}

export function makeStsClient(env: AwsCreds): STSClient {
  return new STSClient({ region: env.AWS_REGION, credentials: credentials(env) });
}
