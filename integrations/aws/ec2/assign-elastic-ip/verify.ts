import { DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import { requireOutput, type StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const allocationId = requireOutput<string>(ctx, "allocationId");

  const described = await ec2.send(
    new DescribeAddressesCommand({ AllocationIds: [allocationId] }),
  );
  const address = described.Addresses?.[0];

  if (!address?.AssociationId) {
    throw new Error(`Expected ${allocationId} to be associated, but it is not`);
  }
  if (address.InstanceId !== ctx.params.INSTANCE_ID) {
    throw new Error(
      `Expected ${allocationId} to be associated with ${ctx.params.INSTANCE_ID}, found "${address.InstanceId ?? "(none)"}"`,
    );
  }

  ctx.log.success(`Confirmed ${address.PublicIp} is associated with ${ctx.params.INSTANCE_ID}`);
}
