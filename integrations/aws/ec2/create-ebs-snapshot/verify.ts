import { DescribeSnapshotsCommand } from "@aws-sdk/client-ec2";
import type { StepContext } from "../../../../src/core/define";
import { awsClients } from "../../../../src/providers/aws";
import { requireOutput } from "../../../../src/core/define";
import type { Params } from "./params";

/** Live proof: read the snapshot back and confirm it completed against the right volume. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const snapshotId = requireOutput<string>(ctx, "snapshotId");

  const described = await ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] }));
  const snapshot = described.Snapshots?.[0];

  if (!snapshot) throw new Error(`Snapshot ${snapshotId} was not found`);
  if (snapshot.State !== "completed") {
    throw new Error(`Snapshot ${snapshotId} is "${snapshot.State}", expected "completed"`);
  }
  if (snapshot.VolumeId !== ctx.params.VOLUME_ID) {
    throw new Error(
      `Snapshot ${snapshotId} has VolumeId "${snapshot.VolumeId}", expected "${ctx.params.VOLUME_ID}"`,
    );
  }
  ctx.log.success(`Confirmed snapshot ${snapshotId} is completed for volume ${ctx.params.VOLUME_ID}`);
}
