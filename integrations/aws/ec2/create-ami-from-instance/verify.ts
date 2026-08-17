import { DescribeImagesCommand } from "@aws-sdk/client-ec2";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import type { Params } from "./params";

/** Confirms the AMI is available and its block device mappings still reference the captured snapshots. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const imageId = ctx.outputs.imageId as string | undefined;
  if (!imageId) throw new Error("No imageId captured from create() — cannot verify");

  const described = await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
  const image = described.Images?.[0];
  if (!image) throw new Error(`AMI ${imageId} not found during verification`);
  if (image.State !== "available") {
    throw new Error(`Expected AMI ${imageId} to be "available", found "${image.State ?? "(unknown)"}"`);
  }
  ctx.log.success(`Confirmed AMI ${imageId} is available`);

  const expectedSnapshotIds = new Set((ctx.outputs.snapshotIds as string[] | undefined) ?? []);
  const actualSnapshotIds = new Set(
    (image.BlockDeviceMappings ?? []).map((mapping) => mapping.Ebs?.SnapshotId).filter(Boolean),
  );
  for (const snapshotId of expectedSnapshotIds) {
    if (!actualSnapshotIds.has(snapshotId)) {
      throw new Error(`Expected AMI ${imageId} to reference backing snapshot ${snapshotId}, but it does not`);
    }
  }
  ctx.log.success(`Confirmed AMI ${imageId} references its ${expectedSnapshotIds.size} backing snapshot(s)`);
}
