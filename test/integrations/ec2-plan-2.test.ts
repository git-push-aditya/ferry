import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { FerryError } from "../../src/core/errors";

import { snapshotStep } from "../../integrations/aws/ec2/create-ebs-snapshot/steps/snapshot";
import type { Params as SnapshotParams } from "../../integrations/aws/ec2/create-ebs-snapshot/params";
import { resizeStep } from "../../integrations/aws/ec2/resize-ebs-volume/steps/resize";
import type { Params as ResizeParams } from "../../integrations/aws/ec2/resize-ebs-volume/params";
import { createAmiStep } from "../../integrations/aws/ec2/create-ami-from-instance/steps/create-ami";
import type { Params as AmiParams } from "../../integrations/aws/ec2/create-ami-from-instance/params";
import { assignEipStep } from "../../integrations/aws/ec2/assign-elastic-ip/steps/assign-eip";
import type { Params as EipParams } from "../../integrations/aws/ec2/assign-elastic-ip/params";
import { tagsStep } from "../../integrations/aws/ec2/tag-instance/steps/tags";
import type { Params as TagParams } from "../../integrations/aws/ec2/tag-instance/params";
import { updateInstanceTypeStep } from "../../integrations/aws/ec2/update-instance-type/steps/update-instance-type";
import type { Params as UpdateTypeParams } from "../../integrations/aws/ec2/update-instance-type/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** Dry-run plan context: check() only — create()/reconcile() must never be called from these tests. */
function planCtx<P>(params: P, send: (command: Command) => unknown): StepContext<P> {
  const ec2 = {
    async send(command: Command) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: ec2, iam: ec2, sts: ec2, ec2, ssm: ec2, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs: {},
    dryRun: true,
    log: NO_LOG,
  };
}

describe("aws/ec2/create-ebs-snapshot — dry-run plan", () => {
  const params: SnapshotParams = {
    VOLUME_ID: "vol-1",
    LOGICAL_NAME: "root-backup",
    DESCRIPTION: "",
    TAGS: "",
    STOP_INSTANCE_FIRST: false,
    INSTANCE_ID: undefined,
  };

  test("no matching snapshot -> missing", async () => {
    const ctx = planCtx(params, () => ({ Snapshots: [] }));
    expect(await snapshotStep.check(ctx)).toBe("missing");
  });

  test("matching pending snapshot -> exists", async () => {
    const ctx = planCtx(params, () => ({ Snapshots: [{ SnapshotId: "snap-1", State: "pending" }] }));
    expect(await snapshotStep.check(ctx)).toBe("exists");
  });
});

describe("aws/ec2/resize-ebs-volume — dry-run plan", () => {
  const params: ResizeParams = { VOLUME_ID: "vol-1", TARGET_SIZE_GIB: 100 };

  test("current size already at target -> exists", async () => {
    const ctx = planCtx(params, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") return { Volumes: [{ Size: 100 }] };
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("exists");
  });

  test("smaller current size, no in-flight modification -> missing", async () => {
    const ctx = planCtx(params, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 40 }] };
      if (name === "DescribeVolumesModificationsCommand") return { VolumesModifications: [] };
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("missing");
  });

  test("smaller current size, conflicting in-flight modification -> conflict", async () => {
    const ctx = planCtx(params, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 40 }] };
      if (name === "DescribeVolumesModificationsCommand") {
        return { VolumesModifications: [{ ModificationState: "modifying", TargetSize: 999 }] };
      }
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("conflict");
  });

  test("shrink target throws FerryError instead of returning a StepState", async () => {
    const shrinkParams: ResizeParams = { VOLUME_ID: "vol-1", TARGET_SIZE_GIB: 10 };
    const ctx = planCtx(shrinkParams, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") return { Volumes: [{ Size: 100 }] };
      return {};
    });
    await expect(resizeStep.check(ctx)).rejects.toThrow(FerryError);
  });
});

describe("aws/ec2/create-ami-from-instance — dry-run plan", () => {
  const params: AmiParams = {
    INSTANCE_ID: "i-1",
    LOGICAL_NAME: "golden-image",
    AMI_NAME: "golden-image-v1",
    DESCRIPTION: undefined,
    NO_REBOOT: false,
    TAGS_JSON: "",
  };

  test("no tagged image -> missing", async () => {
    const ctx = planCtx(params, () => ({ Images: [] }));
    expect(await createAmiStep.check(ctx)).toBe("missing");
  });

  test("tagged image available -> exists", async () => {
    const ctx = planCtx(params, () => ({ Images: [{ ImageId: "ami-1", State: "available" }] }));
    expect(await createAmiStep.check(ctx)).toBe("exists");
  });
});

describe("aws/ec2/assign-elastic-ip — dry-run plan", () => {
  const params: EipParams = { LOGICAL_NAME: "web-eip", INSTANCE_ID: "i-1", TAGS: {} };

  test("no tagged address -> missing", async () => {
    const ctx = planCtx(params, () => ({ Addresses: [] }));
    expect(await assignEipStep.check(ctx)).toBe("missing");
  });

  test("tagged + associated to target -> exists", async () => {
    const ctx = planCtx(params, () => ({
      Addresses: [{ AllocationId: "eipalloc-1", AssociationId: "eipassoc-1", InstanceId: "i-1" }],
    }));
    expect(await assignEipStep.check(ctx)).toBe("exists");
  });

  test("tagged + associated elsewhere -> conflict", async () => {
    const ctx = planCtx(params, () => ({
      Addresses: [{ AllocationId: "eipalloc-1", AssociationId: "eipassoc-1", InstanceId: "i-other" }],
    }));
    expect(await assignEipStep.check(ctx)).toBe("conflict");
  });
});

describe("aws/ec2/tag-instance — dry-run plan", () => {
  const params: TagParams = { INSTANCE_ID: "i-1", TAGS: { env: "prod" }, PRUNE_UNMANAGED_TAGS: false };

  test("instance exists -> exists", async () => {
    const ctx = planCtx(params, () => ({ Reservations: [{ Instances: [{ InstanceId: "i-1" }] }] }));
    expect(await tagsStep.check(ctx)).toBe("exists");
  });

  test("instance missing -> conflict", async () => {
    const ctx = planCtx(params, () => ({ Reservations: [] }));
    expect(await tagsStep.check(ctx)).toBe("conflict");
  });
});

describe("aws/ec2/update-instance-type — dry-run plan", () => {
  const params: UpdateTypeParams = { INSTANCE_ID: "i-1", TARGET_INSTANCE_TYPE: "m5.large" };

  test("already target type -> exists", async () => {
    const ctx = planCtx(params, () => ({
      Reservations: [{ Instances: [{ InstanceType: "m5.large", State: { Name: "running" } }] }],
    }));
    expect(await updateInstanceTypeStep.check(ctx)).toBe("exists");
  });

  test("different type, stopped -> missing", async () => {
    const ctx = planCtx(params, () => ({
      Reservations: [{ Instances: [{ InstanceType: "m5.small", State: { Name: "stopped" } }] }],
    }));
    expect(await updateInstanceTypeStep.check(ctx)).toBe("missing");
  });

  test("instance in a transitional state -> conflict", async () => {
    const ctx = planCtx(params, () => ({
      Reservations: [{ Instances: [{ InstanceType: "m5.small", State: { Name: "shutting-down" } }] }],
    }));
    expect(await updateInstanceTypeStep.check(ctx)).toBe("conflict");
  });
});
