import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  DescribeAddressesCommand,
  DisassociateAddressCommand,
  ReleaseAddressCommand,
} from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import { awsClients, ferryIdentityTags } from "../../../../../src/providers/aws";
import type { Params } from "../params";

const INTEGRATION_ID = "aws/ec2/assign-elastic-ip";

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "InvalidAllocationID.NotFound" || name === "InvalidAssociationID.NotFound";
}

/**
 * One combined allocate+associate step — an allocated-but-unassociated EIP
 * from this integration has no purpose on its own, so partial progress is
 * still "missing" from check()'s point of view (see the plan's task 10).
 */
export const assignEipStep: Step<Params> = {
  id: "assign-eip",
  title: "Allocate and associate an Elastic IP",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const described = await ec2.send(
      new DescribeAddressesCommand({
        Filters: [
          { Name: "tag:ferry:integration-id", Values: [INTEGRATION_ID] },
          { Name: "tag:ferry:logical-name", Values: [ctx.params.LOGICAL_NAME] },
        ],
      }),
    );

    const address = described.Addresses?.[0];
    if (!address) return "missing";
    if (!address.AssociationId) return "missing";
    if (address.InstanceId === ctx.params.INSTANCE_ID) return "exists";
    return "conflict";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);

    const allocated = await ec2.send(
      new AllocateAddressCommand({
        Domain: "vpc",
        TagSpecifications: [
          {
            ResourceType: "elastic-ip",
            Tags: [
              ...ferryIdentityTags(INTEGRATION_ID, ctx.params.LOGICAL_NAME),
              ...Object.entries(ctx.params.TAGS).map(([Key, Value]) => ({ Key, Value })),
            ],
          },
        ],
      }),
    );

    const allocationId = allocated.AllocationId;
    const publicIp = allocated.PublicIp;
    if (!allocationId || !publicIp) {
      throw new Error("AllocateAddress did not return an allocation id / public IP");
    }
    ctx.log.info(`Allocated ${publicIp} (${allocationId}), associating with ${ctx.params.INSTANCE_ID}...`);

    // AllowReassociation is explicitly false — not the API's permissive
    // default — so a target instance already holding a different EIP, or this
    // address already attached elsewhere, fails loudly instead of silently
    // being moved.
    const associated = await ec2.send(
      new AssociateAddressCommand({
        AllocationId: allocationId,
        InstanceId: ctx.params.INSTANCE_ID,
        AllowReassociation: false,
      }),
    );

    const associationId = associated.AssociationId;
    if (!associationId) throw new Error("AssociateAddress did not return an association id");

    ctx.log.success(`Associated ${publicIp} with ${ctx.params.INSTANCE_ID}`);

    return { allocationId, publicIp, associationId };
  },

  async rollback(ctx) {
    const allocationId = ctx.outputs.allocationId as string | undefined;
    if (!allocationId) return; // untouched this run

    const { ec2 } = awsClients(ctx);
    const associationId = ctx.outputs.associationId as string | undefined;

    if (associationId) {
      try {
        await ec2.send(new DisassociateAddressCommand({ AssociationId: associationId }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }

    try {
      await ec2.send(new ReleaseAddressCommand({ AllocationId: allocationId }));
      ctx.log.warn(`Rolled back — released ${allocationId}`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      ctx.log.warn(`${allocationId} was already gone during rollback`);
    }
  },

  resource(ctx) {
    return {
      type: "aws_eip",
      name: ctx.params.LOGICAL_NAME,
      attributes: {
        allocationId: (ctx.outputs.allocationId as string) ?? "",
        publicIp: (ctx.outputs.publicIp as string) ?? "",
        instanceId: ctx.params.INSTANCE_ID,
      },
    };
  },
};
