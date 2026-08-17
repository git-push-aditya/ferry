import {
  CreateSnapshotCommand,
  DeleteSnapshotCommand,
  DescribeSnapshotsCommand,
} from "@aws-sdk/client-ec2";
import type { Step, StepContext } from "../../../../../src/core/define";
import { awsClients, ferryIdentityTags, startInstance, stopInstance } from "../../../../../src/providers/aws";
import { pollUntil } from "../../../../../src/core/wait";
import { parsedTags, type Params } from "../params";

const INTEGRATION_ID = "aws/ec2/create-ebs-snapshot";

async function findIdentitySnapshot(ctx: StepContext<Params>) {
  const { ec2 } = awsClients(ctx);
  const described = await ec2.send(
    new DescribeSnapshotsCommand({
      OwnerIds: ["self"],
      Filters: [
        { Name: "tag:ferry:integration-id", Values: [INTEGRATION_ID] },
        { Name: "tag:ferry:logical-name", Values: [ctx.params.LOGICAL_NAME] },
        { Name: "volume-id", Values: [ctx.params.VOLUME_ID] },
      ],
    }),
  );
  return described.Snapshots?.[0];
}

/**
 * Snapshots are point-in-time, not a natural idempotency target the way a
 * bucket name is — identity here is a `ferry:integration-id` +
 * `ferry:logical-name` tag pair applied at creation time, looked up via
 * DescribeSnapshots so a retried run doesn't create a second, redundant
 * snapshot.
 */
export const snapshotStep: Step<Params> = {
  id: "create-ebs-snapshot",
  title: "Create an EBS snapshot",

  async check(ctx) {
    const snapshot = await findIdentitySnapshot(ctx);
    if (!snapshot) return "missing";
    return snapshot.State === "pending" || snapshot.State === "completed" ? "exists" : "missing";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const { VOLUME_ID, LOGICAL_NAME, DESCRIPTION, STOP_INSTANCE_FIRST, INSTANCE_ID } = ctx.params;

    if (STOP_INSTANCE_FIRST && INSTANCE_ID) {
      await stopInstance(ec2, INSTANCE_ID, ctx.log);
    }

    let snapshotId: string | undefined;
    try {
      const created = await ec2.send(
        new CreateSnapshotCommand({
          VolumeId: VOLUME_ID,
          Description: DESCRIPTION || undefined,
          TagSpecifications: [
            {
              ResourceType: "snapshot",
              Tags: [
                ...ferryIdentityTags(INTEGRATION_ID, LOGICAL_NAME),
                ...Object.entries(parsedTags(ctx.params)).map(([Key, Value]) => ({ Key, Value })),
              ],
            },
          ],
        }),
      );
      snapshotId = created.SnapshotId;
      if (!snapshotId) throw new Error("CreateSnapshot did not return a SnapshotId");

      ctx.log.info(`Snapshot ${snapshotId} pending — this can take a while for large/busy volumes...`);
      await pollUntil(
        async () => {
          const described = await ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId!] }));
          const state = described.Snapshots?.[0]?.State;
          if (state === "error") {
            throw new Error(`Snapshot ${snapshotId} entered "error" state while completing`);
          }
          return state === "completed";
        },
        { intervalMs: 15_000, timeoutMs: 20 * 60_000, label: `snapshot ${snapshotId} completing` },
      );
    } finally {
      if (STOP_INSTANCE_FIRST && INSTANCE_ID) {
        await startInstance(ec2, INSTANCE_ID, ctx.log);
      }
    }

    return { snapshotId, volumeId: VOLUME_ID };
  },

  async rollback(ctx) {
    const snapshotId = ctx.outputs.snapshotId as string | undefined;
    if (!snapshotId) return;
    const { ec2 } = awsClients(ctx);
    await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
  },

  resource(ctx) {
    return {
      type: "aws_ebs_snapshot",
      name: ctx.params.LOGICAL_NAME,
      attributes: {
        snapshotId: (ctx.outputs.snapshotId as string) ?? "",
        volumeId: ctx.params.VOLUME_ID,
      },
    };
  },
};
