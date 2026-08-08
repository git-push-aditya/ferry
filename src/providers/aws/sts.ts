import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AwsClients } from "./clients";

export interface AwsIdentity {
  accountId: string;
  arn: string;
}

/** Resolved once per run, before any step, so every step shares one account id. */
export async function resolveIdentity(clients: AwsClients): Promise<AwsIdentity> {
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) throw new Error("STS GetCallerIdentity did not return an Account id");
  return { accountId: identity.Account, arn: identity.Arn ?? "(unknown arn)" };
}
