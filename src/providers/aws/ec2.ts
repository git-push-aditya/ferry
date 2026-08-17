import {
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeInstancesCommand,
  DescribeTagsCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Instance,
  type EC2Client,
  type Tag,
} from "@aws-sdk/client-ec2";
import { pollUntil } from "../../core/wait";
import type { Logger } from "../../core/logger";

function isInstanceNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "InvalidInstanceID.NotFound";
}

/** Reads a single instance, or undefined if it doesn't exist (or was already purged). */
export async function describeInstance(
  ec2: EC2Client,
  instanceId: string,
): Promise<Instance | undefined> {
  try {
    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return described.Reservations?.[0]?.Instances?.[0];
  } catch (err) {
    if (isInstanceNotFound(err)) return undefined;
    throw err;
  }
}

export type Ec2InstanceStateName =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped";

export async function instanceStateName(
  ec2: EC2Client,
  instanceId: string,
): Promise<Ec2InstanceStateName | undefined> {
  const instance = await describeInstance(ec2, instanceId);
  return instance?.State?.Name as Ec2InstanceStateName | undefined;
}

/** Polls DescribeInstances until the instance reaches `desired`, or the timeout is hit. */
export async function pollInstanceState(
  ec2: EC2Client,
  instanceId: string,
  desired: Ec2InstanceStateName,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<boolean> {
  return pollUntil(async () => (await instanceStateName(ec2, instanceId)) === desired, {
    intervalMs: opts?.intervalMs ?? 5_000,
    timeoutMs: opts?.timeoutMs ?? 5 * 60_000,
    label: `instance ${instanceId} reaching "${desired}"`,
  });
}

/**
 * Shared stop/start helpers — used by both stop-start-instance and
 * update-instance-type, per the plan's "intentional shared-helper reuse, not
 * duplication" resolution (same principle that promoted retryWithBackoff).
 */
export async function stopInstance(
  ec2: EC2Client,
  instanceId: string,
  log?: Pick<Logger, "info">,
): Promise<void> {
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  log?.info(`Stopping ${instanceId}...`);
  await pollInstanceState(ec2, instanceId, "stopped", { timeoutMs: 5 * 60_000 });
}

export async function startInstance(
  ec2: EC2Client,
  instanceId: string,
  log?: Pick<Logger, "info">,
): Promise<void> {
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  log?.info(`Starting ${instanceId}...`);
  await pollInstanceState(ec2, instanceId, "running", { timeoutMs: 5 * 60_000 });
}

/**
 * Reads every tag currently on an EC2 resource (instance, volume, snapshot,
 * AMI, security group, EIP — DescribeTags is resource-type-agnostic).
 */
export async function describeResourceTags(
  ec2: EC2Client,
  resourceId: string,
): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  let nextToken: string | undefined;
  do {
    const page = await ec2.send(
      new DescribeTagsCommand({
        Filters: [{ Name: "resource-id", Values: [resourceId] }],
        NextToken: nextToken,
      }),
    );
    for (const tag of page.Tags ?? []) {
      if (tag.Key) tags[tag.Key] = tag.Value ?? "";
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return tags;
}

/** CreateTags both adds new tags and overwrites existing ones sharing a key. */
export async function applyResourceTags(
  ec2: EC2Client,
  resourceId: string,
  tags: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(tags);
  if (entries.length === 0) return;
  const Tags: Tag[] = entries.map(([Key, Value]) => ({ Key, Value }));
  await ec2.send(new CreateTagsCommand({ Resources: [resourceId], Tags }));
}

export async function removeResourceTags(
  ec2: EC2Client,
  resourceId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const Tags: Tag[] = keys.map((Key) => ({ Key }));
  await ec2.send(new DeleteTagsCommand({ Resources: [resourceId], Tags }));
}

/** The tag pair every identity-tagged resource this project creates carries. */
export function ferryIdentityTags(integrationId: string, logicalName: string): Tag[] {
  return [
    { Key: "ferry:integration-id", Value: integrationId },
    { Key: "ferry:logical-name", Value: logicalName },
  ];
}
