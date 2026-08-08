import {
  GetPolicyCommand,
  GetRoleCommand,
  GetUserCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type { StepState } from "../../core/define";

export function isNoSuchEntity(err: unknown): boolean {
  return (err as { name?: string })?.name === "NoSuchEntityException";
}

export function policyArn(accountId: string, policyName: string): string {
  return `arn:aws:iam::${accountId}:policy/${policyName}`;
}

export function roleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

export function userArn(accountId: string, userName: string): string {
  return `arn:aws:iam::${accountId}:user/${userName}`;
}

/**
 * IAM has no "exists but isn't ours" case the way S3 does: policy/role/user
 * names are account-scoped, so NoSuchEntity means missing and anything else is
 * a real error worth surfacing.
 */
async function presence(probe: () => Promise<unknown>): Promise<StepState> {
  try {
    await probe();
    return "exists";
  } catch (err) {
    if (isNoSuchEntity(err)) return "missing";
    throw err;
  }
}

export function policyState(iam: IAMClient, arn: string): Promise<StepState> {
  return presence(() => iam.send(new GetPolicyCommand({ PolicyArn: arn })));
}

export function roleState(iam: IAMClient, roleName: string): Promise<StepState> {
  return presence(() => iam.send(new GetRoleCommand({ RoleName: roleName })));
}

export function userState(iam: IAMClient, userName: string): Promise<StepState> {
  return presence(() => iam.send(new GetUserCommand({ UserName: userName })));
}
