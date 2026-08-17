import { randomUUID } from "node:crypto";
import { DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import { awsClients, ferryIdentityTags, pollInstanceState } from "../../../../../src/providers/aws";
import type { Params } from "../params";

const TERMINAL_STATES = new Set(["terminated", "shutting-down"]);

function isInstanceNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "InvalidInstanceID.NotFound";
}

/**
 * Identity here is a tag pair, not a name — EC2 has no natural
 * global-uniqueness probe the way S3 bucket names do. A match found by
 * `ferry:integration-id` + `ferry:logical-name` is "ours" full stop; per the
 * Step contract, check() is a shallow presence probe, not drift detection, so
 * a param mismatch (different AMI/type/subnet) on an existing tagged instance
 * is still "exists", never "conflict".
 */
export const launchStep: Step<Params> = {
  id: "launch-instance",
  title: "Launch the EC2 instance",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const described = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:ferry:integration-id", Values: ["aws/ec2/launch-instance"] },
          { Name: "tag:ferry:logical-name", Values: [ctx.params.LOGICAL_NAME] },
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
    const clientToken = ctx.params.CLIENT_TOKEN_OVERRIDE ?? randomUUID();

    const run = await ec2.send(
      new RunInstancesCommand({
        ImageId: ctx.params.AMI_ID,
        InstanceType: ctx.params.INSTANCE_TYPE as never,
        MinCount: 1,
        MaxCount: 1,
        SubnetId: ctx.params.SUBNET_ID,
        SecurityGroupIds: ctx.params.SECURITY_GROUP_IDS,
        KeyName: ctx.params.KEY_PAIR_NAME,
        ClientToken: clientToken,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              ...ferryIdentityTags("aws/ec2/launch-instance", ctx.params.LOGICAL_NAME),
              ...Object.entries(ctx.params.TAGS).map(([Key, Value]) => ({ Key, Value })),
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
      availabilityZone: settled?.Placement?.AvailabilityZone ?? instance.Placement?.AvailabilityZone ?? "",
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
      name: ctx.params.LOGICAL_NAME,
      attributes: {
        instanceId: (ctx.outputs.instanceId as string) ?? "",
        availabilityZone: (ctx.outputs.availabilityZone as string) ?? "",
        privateIp: (ctx.outputs.privateIp as string) ?? "",
      },
    };
  },
};
