import {
  CreateImageCommand,
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImagesCommand,
} from "@aws-sdk/client-ec2";
import type { Step } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients, ferryIdentityTags } from "../../../../../src/providers/aws";
import { parsedTags, type Params } from "../params";

const INTEGRATION_ID = "aws/ec2/create-ami-from-instance";

async function findTaggedImage(ec2: ReturnType<typeof awsClients>["ec2"], logicalName: string) {
  const described = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["self"],
      Filters: [
        { Name: "tag:ferry:integration-id", Values: [INTEGRATION_ID] },
        { Name: "tag:ferry:logical-name", Values: [logicalName] },
      ],
    }),
  );
  return described.Images?.find((image) => image.State === "pending" || image.State === "available");
}

/**
 * Bakes an AMI from a running (or stopped) instance. No natural "does this
 * AMI already exist" check exists by name/content, so — same approach as
 * create-ebs-snapshot — the AMI is tagged at creation with the identity tags
 * and check() looks those up.
 */
export const createAmiStep: Step<Params> = {
  id: "create-ami-from-instance",
  title: "Create an AMI from the instance",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const match = await findTaggedImage(ec2, ctx.params.LOGICAL_NAME);
    return match ? "exists" : "missing";
  },

  async create(ctx) {
    const { ec2 } = awsClients(ctx);
    const { INSTANCE_ID, AMI_NAME, DESCRIPTION, NO_REBOOT, LOGICAL_NAME } = ctx.params;

    ctx.log.info(
      NO_REBOOT
        ? `Creating AMI "${AMI_NAME}" from ${INSTANCE_ID} without rebooting it (crash-consistent snapshots)...`
        : `Creating AMI "${AMI_NAME}" from ${INSTANCE_ID} — this will REBOOT the instance to ensure full consistency...`,
    );

    const created = await ec2.send(
      new CreateImageCommand({
        InstanceId: INSTANCE_ID,
        Name: AMI_NAME,
        Description: DESCRIPTION,
        NoReboot: NO_REBOOT,
        TagSpecifications: [
          {
            ResourceType: "image",
            Tags: [...ferryIdentityTags(INTEGRATION_ID, LOGICAL_NAME), ...toTags(parsedTags(ctx.params))],
          },
        ],
      }),
    );

    const imageId = created.ImageId;
    if (!imageId) throw new Error("CreateImage did not return an ImageId");

    let failure: string | undefined;
    await pollUntil(
      async () => {
        const described = await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
        const image = described.Images?.[0];
        if (!image) return false;
        if (image.State === "failed" || image.StateReason) {
          failure = image.StateReason?.Message ?? `AMI ${imageId} reported state "failed"`;
          return true; // stop polling; the throw below fires immediately after
        }
        return image.State === "available";
      },
      { intervalMs: 10_000, timeoutMs: 20 * 60_000, label: `AMI ${imageId} reaching "available"` },
    );
    if (failure) throw new Error(`AMI creation from ${INSTANCE_ID} failed: ${failure}`);

    const finalDescribe = await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
    const image = finalDescribe.Images?.[0];
    const snapshotIds = (image?.BlockDeviceMappings ?? [])
      .map((mapping) => mapping.Ebs?.SnapshotId)
      .filter((id): id is string => Boolean(id));

    ctx.log.success(`AMI ${imageId} is available, backed by ${snapshotIds.length} snapshot(s)`);

    return { imageId, snapshotIds };
  },

  /**
   * Both the AMI and its backing snapshots are this run's own creations, so a
   * full (not best-effort) cleanup is correct: deregistering an AMI does not
   * automatically delete the snapshots behind it.
   */
  async rollback(ctx) {
    const { ec2 } = awsClients(ctx);
    const imageId = ctx.outputs.imageId as string | undefined;
    const snapshotIds = (ctx.outputs.snapshotIds as string[] | undefined) ?? [];
    if (!imageId) return;

    ctx.log.warn(`Deregistering AMI ${imageId} and deleting its ${snapshotIds.length} backing snapshot(s)...`);
    await ec2.send(new DeregisterImageCommand({ ImageId: imageId }));
    for (const snapshotId of snapshotIds) {
      await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
    }
  },

  resource(ctx) {
    return {
      type: "aws_ami",
      name: ctx.params.AMI_NAME,
      attributes: {
        imageId: (ctx.outputs.imageId as string | undefined) ?? "",
        sourceInstanceId: ctx.params.INSTANCE_ID,
        noReboot: String(ctx.params.NO_REBOOT),
      },
    };
  },
};

function toTags(tags: Record<string, string>) {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}
