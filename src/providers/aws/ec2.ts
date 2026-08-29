import { randomUUID } from "node:crypto";
import {
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeInstancesCommand,
  DescribeTagsCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Instance,
  type EC2Client,
  type Tag,
} from "@aws-sdk/client-ec2";
import type { Step, StepContext } from "../../core/define";
import { pollUntil } from "../../core/wait";
import type { Logger } from "../../core/logger";
import { awsClients } from "./clients";

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

export interface Ec2LaunchOptions<P> {
  /**
   * Used as the `ferry:logical-name` identity tag. EC2 has no natural
   * global-uniqueness probe the way S3 bucket names do, so identity here is a
   * tag pair, not a name.
   */
  logicalName(params: P): string;
  /**
   * The `ferry:integration-id` tag value. Passed in rather than hardcoded so
   * two integrations that both launch instances do not collide on check().
   */
  integrationId: string;

  amiId(params: P): string;
  instanceType(params: P): string;
  subnetId(params: P): string;
  securityGroupIds(params: P): string[];
  keyPairName?(params: P): string | undefined;
  tags?(params: P): Record<string, string>;
  /**
   * Accepted as an override so a re-run after a partial failure (RunInstances
   * succeeded, the poll did not) can reuse the same token rather than
   * generating a fresh one that would launch a second instance.
   */
  clientTokenOverride?(params: P): string | undefined;

  /**
   * Cloud-init / shell script run at first boot. Passed as plain text; the
   * SDK base64-encodes it. Added for self-hosted-runner-registration, which
   * needs the instance to start the runner binary on boot.
   */
  userData?(ctx: StepContext<P>): string | undefined;
  /**
   * An IAM **instance profile** ARN, not a role ARN. EC2 delivers credentials
   * through a profile; a bare role cannot be attached to an instance.
   * Resolved from ctx rather than params because it is usually an earlier
   * step's output, not something the caller can know up front.
   */
  iamInstanceProfileArn?(ctx: StepContext<P>): string | undefined;

  id?: string;
  title?: string;
}

/**
 * Launch one EC2 instance, identified by a ferry tag pair rather than a name.
 *
 * Promoted out of the former `aws/ec2/launch-instance` integration when that
 * folder was cut: launching an instance is a step other integrations compose
 * with (a self-hosted runner needs an instance, an instance profile and a
 * registration in one ordered run), not a procedure anyone needs on its own —
 * `aws ec2 run-instances` already covers that case.
 *
 * Per the Step contract, `check()` is a shallow presence probe, not drift
 * detection: a param mismatch (different AMI, type, subnet) on an existing
 * tagged instance is still `exists`, never `conflict`.
 */
export function ec2LaunchStep<P>(opts: Ec2LaunchOptions<P>): Step<P> {
  const TERMINAL_STATES = new Set(["terminated", "shutting-down"]);
  return {
    id: opts.id ?? "launch-instance",
    title: opts.title ?? "Launch the EC2 instance",

    async check(ctx) {
      const { ec2 } = awsClients(ctx);
      const described = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:ferry:integration-id", Values: [opts.integrationId] },
            { Name: "tag:ferry:logical-name", Values: [opts.logicalName(ctx.params)] },
          ],
        }),
      );

      for (const reservation of described.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const stateName = instance.State?.Name;
          if (stateName && !TERMINAL_STATES.has(stateName)) return "exists";
        }
      }
      return "missing";
    },

    async create(ctx) {
      const { ec2 } = awsClients(ctx);
      const clientToken = opts.clientTokenOverride?.(ctx.params) ?? randomUUID();

      const run = await ec2.send(
        new RunInstancesCommand({
          ImageId: opts.amiId(ctx.params),
          InstanceType: opts.instanceType(ctx.params) as never,
          MinCount: 1,
          MaxCount: 1,
          SubnetId: opts.subnetId(ctx.params),
          SecurityGroupIds: opts.securityGroupIds(ctx.params),
          KeyName: opts.keyPairName?.(ctx.params),
          ClientToken: clientToken,
          UserData: (() => {
            const script = opts.userData?.(ctx);
            return script ? Buffer.from(script, "utf-8").toString("base64") : undefined;
          })(),
          IamInstanceProfile: (() => {
            const arn = opts.iamInstanceProfileArn?.(ctx);
            return arn ? { Arn: arn } : undefined;
          })(),
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [
                ...ferryIdentityTags(opts.integrationId, opts.logicalName(ctx.params)),
                ...Object.entries(opts.tags?.(ctx.params) ?? {}).map(([Key, Value]) => ({ Key, Value })),
              ],
            },
          ],
        }),
      );

      const instance = run.Instances?.[0];
      const instanceId = instance?.InstanceId;
      if (!instanceId) throw new Error("RunInstances did not return an instance id");

      ctx.log.info(`Launched ${instanceId}, waiting for it to reach "running"...`);
      await pollInstanceState(ec2, instanceId, "running", { timeoutMs: 10 * 60_000 });

      const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const settled = described.Reservations?.[0]?.Instances?.[0];

      ctx.log.success(`Instance ${instanceId} is running`);

      return {
        instanceId,
        privateIp: settled?.PrivateIpAddress ?? instance.PrivateIpAddress ?? "",
        availabilityZone:
          settled?.Placement?.AvailabilityZone ?? instance.Placement?.AvailabilityZone ?? "",
        clientToken,
      };
    },

    async rollback(ctx) {
      const instanceId = ctx.outputs.instanceId as string | undefined;
      if (!instanceId) return;

      const { ec2 } = awsClients(ctx);
      try {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
        await pollInstanceState(ec2, instanceId, "terminated", { timeoutMs: 5 * 60_000 });
        ctx.log.warn(`Rolled back — terminated ${instanceId}`);
      } catch (err) {
        if (isInstanceNotFound(err)) {
          ctx.log.warn(`${instanceId} was already gone during rollback`);
          return;
        }
        throw err;
      }
    },

    resource(ctx) {
      return {
        type: "aws_ec2_instance",
        name: opts.logicalName(ctx.params),
        attributes: {
          instanceId: (ctx.outputs.instanceId as string) ?? "",
          availabilityZone: (ctx.outputs.availabilityZone as string) ?? "",
          privateIp: (ctx.outputs.privateIp as string) ?? "",
        },
      };
    },

    handoff: {
      terraform: {
        type: "aws_instance",
        address: "aws_instance.this",
        importId: (ctx) => (ctx.outputs.instanceId as string) ?? "",
      },
    },
  };
}
