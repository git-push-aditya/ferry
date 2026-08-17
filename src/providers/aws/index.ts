import type { ProviderDef } from "../../core/provider";
import { AWS_PROVIDER_ID, makeAwsClients, type AwsClients } from "./clients";
import { AWS_CREDENTIAL_KEYS, awsCredentialsSchema, type AwsCredentials } from "./credentials";
import { resolveIdentity } from "./sts";

export const awsProvider: ProviderDef<AwsClients> = {
  id: AWS_PROVIDER_ID,
  credentialKeys: AWS_CREDENTIAL_KEYS,
  credentialSchema: awsCredentialsSchema,
  createClients: (creds) => makeAwsClients(creds as AwsCredentials),
  resolveIdentity: async (clients) => {
    const identity = await resolveIdentity(clients);
    return {
      accountId: identity.accountId,
      description: `provisioning as ${identity.arn} (account ${identity.accountId})`,
    };
  },
};

export * from "./clients";
export * from "./credentials";
export * from "./ec2";
export * from "./errors";
export * from "./iam";
export * from "./params";
export * from "./s3";
export * from "./sts";
