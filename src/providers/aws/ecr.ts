import { DescribeRepositoriesCommand, type ECRClient } from "@aws-sdk/client-ecr";
import type { StepState } from "../../core/define";

export function isRepositoryNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "RepositoryNotFoundException";
}

export function ecrRepositoryArn(accountId: string, region: string, repositoryName: string): string {
  return `arn:aws:ecr:${region}:${accountId}:repository/${repositoryName}`;
}

/** Shallow presence check — RepositoryNotFoundException is ECR's own not-found error, not a generic 404. */
export async function ecrRepositoryState(ecr: ECRClient, repositoryName: string): Promise<StepState> {
  try {
    await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    return "exists";
  } catch (err) {
    if (isRepositoryNotFound(err)) return "missing";
    throw err;
  }
}
