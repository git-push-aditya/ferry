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
type SendFn = (command: Command) => unknown;

function ec2Ctx<P>(
  params: P,
  outputs: Record<string, unknown>,
  send: SendFn,
  ssmSend?: SendFn,
): StepContext<P> {
  const ec2 = {
    async send(command: Command) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  const ssm = {
    async send(command: Command) {
      const reply = (ssmSend ?? (() => ({})))(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: ec2, iam: ec2, sts: ec2, ec2, ssm, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

function awsError(name: string, httpStatusCode = 400): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

// ---------------------------------------------------------------------------
// create-ebs-snapshot
// ---------------------------------------------------------------------------

const SNAPSHOT_PARAMS: SnapshotParams = {
  VOLUME_ID: "vol-1",
  LOGICAL_NAME: "root-backup",
  DESCRIPTION: "",
  TAGS: "",
  STOP_INSTANCE_FIRST: false,
  INSTANCE_ID: undefined,
};

describe("aws/ec2/create-ebs-snapshot", () => {
  test("check(): existing pending snapshot -> exists", async () => {
    const ctx = ec2Ctx(SNAPSHOT_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeSnapshotsCommand") {
        return { Snapshots: [{ SnapshotId: "snap-1", State: "pending" }] };
      }
      return {};
    });
    expect(await snapshotStep.check(ctx)).toBe("exists");
  });

  test("check(): existing completed snapshot -> exists", async () => {
    const ctx = ec2Ctx(SNAPSHOT_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeSnapshotsCommand") {
        return { Snapshots: [{ SnapshotId: "snap-1", State: "completed" }] };
      }
      return {};
    });
    expect(await snapshotStep.check(ctx)).toBe("exists");
  });

  test("check(): no matching snapshot -> missing", async () => {
    const ctx = ec2Ctx(SNAPSHOT_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeSnapshotsCommand") return { Snapshots: [] };
      return {};
    });
    expect(await snapshotStep.check(ctx)).toBe("missing");
  });

  test("create(): captures snapshotId, already completed on first poll", async () => {
    const ctx = ec2Ctx(SNAPSHOT_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "CreateSnapshotCommand") return { SnapshotId: "snap-99" };
      if (name === "DescribeSnapshotsCommand") return { Snapshots: [{ SnapshotId: "snap-99", State: "completed" }] };
      return {};
    });
    const out = await snapshotStep.create!(ctx);
    expect(out).toEqual({ snapshotId: "snap-99", volumeId: "vol-1" });
  });

  test("create(): STOP_INSTANCE_FIRST stops then starts around the snapshot", async () => {
    const calls: string[] = [];
    const params: SnapshotParams = { ...SNAPSHOT_PARAMS, STOP_INSTANCE_FIRST: true, INSTANCE_ID: "i-1" };
    const ctx = ec2Ctx(params, {}, (cmd) => {
      const name = cmd.constructor.name;
      calls.push(name);
      if (name === "StopInstancesCommand" || name === "StartInstancesCommand") return {};
      if (name === "DescribeInstancesCommand") {
        const state = calls.filter((c) => c === "StopInstancesCommand").length > 0 &&
          calls.filter((c) => c === "StartInstancesCommand").length === 0
          ? "stopped"
          : "running";
        return { Reservations: [{ Instances: [{ State: { Name: state } }] }] };
      }
      if (name === "CreateSnapshotCommand") return { SnapshotId: "snap-5" };
      if (name === "DescribeSnapshotsCommand") return { Snapshots: [{ SnapshotId: "snap-5", State: "completed" }] };
      return {};
    });
    const out = await snapshotStep.create!(ctx);
    expect(out).toEqual({ snapshotId: "snap-5", volumeId: "vol-1" });
    expect(calls.indexOf("StopInstancesCommand")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("StartInstancesCommand")).toBeGreaterThan(calls.indexOf("CreateSnapshotCommand"));
    expect(calls.indexOf("StopInstancesCommand")).toBeLessThan(calls.indexOf("CreateSnapshotCommand"));
  });

  test("rollback(): deletes the captured snapshot", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(SNAPSHOT_PARAMS, { snapshotId: "snap-77" }, (cmd) => {
      seen.push(cmd.constructor.name);
      return {};
    });
    await snapshotStep.rollback!(ctx);
    expect(seen).toEqual(["DeleteSnapshotCommand"]);
  });

  test("rollback(): no-op when snapshotId was never captured", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(SNAPSHOT_PARAMS, {}, (cmd) => {
      seen.push(cmd.constructor.name);
      return {};
    });
    await snapshotStep.rollback!(ctx);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resize-ebs-volume
// ---------------------------------------------------------------------------

const RESIZE_PARAMS: ResizeParams = {
  VOLUME_ID: "vol-1",
  TARGET_SIZE_GIB: 100,
};

describe("aws/ec2/resize-ebs-volume", () => {
  test("check(): current size already >= target -> exists", async () => {
    const ctx = ec2Ctx(RESIZE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") return { Volumes: [{ Size: 100 }] };
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("exists");
  });

  test("check(): target smaller than current size throws (not a StepState)", async () => {
    const params: ResizeParams = { ...RESIZE_PARAMS, TARGET_SIZE_GIB: 50 };
    const ctx = ec2Ctx(params, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") return { Volumes: [{ Size: 100 }] };
      return {};
    });
    await expect(resizeStep.check(ctx)).rejects.toThrow(FerryError);
  });

  test("check(): in-flight modification to same target -> missing (skip re-issuing)", async () => {
    const ctx = ec2Ctx(RESIZE_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 50 }] };
      if (name === "DescribeVolumesModificationsCommand") {
        return { VolumesModifications: [{ ModificationState: "modifying", TargetSize: 100 }] };
      }
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("missing");
  });

  test("check(): in-flight modification to a different target -> conflict", async () => {
    const ctx = ec2Ctx(RESIZE_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 50 }] };
      if (name === "DescribeVolumesModificationsCommand") {
        return { VolumesModifications: [{ ModificationState: "modifying", TargetSize: 200 }] };
      }
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("conflict");
  });

  test("check(): no in-flight modification, smaller current size -> missing", async () => {
    const ctx = ec2Ctx(RESIZE_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 50 }] };
      if (name === "DescribeVolumesModificationsCommand") return { VolumesModifications: [] };
      return {};
    });
    expect(await resizeStep.check(ctx)).toBe("missing");
  });

  test("create(): issues ModifyVolume, polls to optimizing, no SSM step configured", async () => {
    const seen: string[] = [];
    let modificationChecks = 0;
    const ctx = ec2Ctx(RESIZE_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      seen.push(name);
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 50 }] };
      if (name === "DescribeVolumesModificationsCommand") {
        modificationChecks += 1;
        // First check (before ModifyVolume): nothing in flight yet, so
        // create() must issue a fresh ModifyVolume. Every check afterward
        // (the poll) reports the modification as already optimizing.
        if (modificationChecks === 1) return { VolumesModifications: [] };
        return { VolumesModifications: [{ ModificationState: "optimizing", TargetSize: 100 }] };
      }
      return {};
    });
    const out = await resizeStep.create!(ctx);
    expect(out.preResizeSize).toBe(50);
    expect(out.osResizePerformed).toBe(false);
    expect(seen).toContain("ModifyVolumeCommand");
  });

  test("create(): already-in-flight to same target skips re-issuing ModifyVolume", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(RESIZE_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      seen.push(name);
      if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 50 }] };
      if (name === "DescribeVolumesModificationsCommand") {
        return { VolumesModifications: [{ ModificationState: "optimizing", TargetSize: 100 }] };
      }
      return {};
    });
    await resizeStep.create!(ctx);
    expect(seen).not.toContain("ModifyVolumeCommand");
  });

  test("create(): with SSM configured, runs SSM sub-step and reports success", async () => {
    const params: ResizeParams = {
      ...RESIZE_PARAMS,
      SSM_DOCUMENT_NAME: "AWS-GrowPartition",
      SSM_INSTANCE_ID: "i-1",
    };
    const ctx = ec2Ctx(
      params,
      {},
      (cmd) => {
        const name = cmd.constructor.name;
        if (name === "DescribeVolumesCommand") return { Volumes: [{ Size: 50 }] };
        if (name === "DescribeVolumesModificationsCommand") {
          return { VolumesModifications: [{ ModificationState: "optimizing", TargetSize: 100 }] };
        }
        return {};
      },
      (cmd) => {
        const name = cmd.constructor.name;
        if (name === "SendCommandCommand") return { Command: { CommandId: "cmd-1" } };
        if (name === "GetCommandInvocationCommand") return { Status: "Success" };
        return {};
      },
    );
    const out = await resizeStep.create!(ctx);
    expect(out.osResizePerformed).toBe(true);
    expect(out.ssmCommandId).toBe("cmd-1");
  });

  test("rollback(): makes no API calls, only warns", async () => {
    const seen: string[] = [];
    const warnings: string[] = [];
    const ctx = ec2Ctx(RESIZE_PARAMS, { volumeId: "vol-1", osResizePerformed: false }, (cmd) => {
      seen.push(cmd.constructor.name);
      return {};
    });
    ctx.log = { ...NO_LOG, warn: (m: string) => warnings.push(m) };
    await resizeStep.rollback!(ctx);
    expect(seen).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("PERMANENT");
  });
});

// ---------------------------------------------------------------------------
// create-ami-from-instance
// ---------------------------------------------------------------------------

const AMI_PARAMS: AmiParams = {
  INSTANCE_ID: "i-1",
  LOGICAL_NAME: "golden-image",
  AMI_NAME: "golden-image-v1",
  DESCRIPTION: undefined,
  NO_REBOOT: true,
  TAGS_JSON: "",
};

describe("aws/ec2/create-ami-from-instance", () => {
  test("check(): tagged image already available -> exists", async () => {
    const ctx = ec2Ctx(AMI_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeImagesCommand") {
        return { Images: [{ ImageId: "ami-1", State: "available" }] };
      }
      return {};
    });
    expect(await createAmiStep.check(ctx)).toBe("exists");
  });

  test("check(): no tagged image -> missing", async () => {
    const ctx = ec2Ctx(AMI_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeImagesCommand") return { Images: [] };
      return {};
    });
    expect(await createAmiStep.check(ctx)).toBe("missing");
  });

  test("create(): captures imageId + backing snapshot ids, NO_REBOOT passed through", async () => {
    let capturedNoReboot: unknown;
    const ctx = ec2Ctx(AMI_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "CreateImageCommand") {
        capturedNoReboot = cmd.input.NoReboot;
        return { ImageId: "ami-9" };
      }
      if (name === "DescribeImagesCommand") {
        return {
          Images: [
            {
              ImageId: "ami-9",
              State: "available",
              BlockDeviceMappings: [{ Ebs: { SnapshotId: "snap-a" } }, { Ebs: { SnapshotId: "snap-b" } }],
            },
          ],
        };
      }
      return {};
    });
    const out = await createAmiStep.create!(ctx);
    expect(out).toEqual({ imageId: "ami-9", snapshotIds: ["snap-a", "snap-b"] });
    expect(capturedNoReboot).toBe(true);
  });

  test("rollback(): deregisters image and deletes every captured snapshot", async () => {
    const seen: { name: string; input: Record<string, unknown> }[] = [];
    const ctx = ec2Ctx(
      AMI_PARAMS,
      { imageId: "ami-9", snapshotIds: ["snap-a", "snap-b"] },
      (cmd) => {
        seen.push({ name: cmd.constructor.name, input: cmd.input });
        return {};
      },
    );
    await createAmiStep.rollback!(ctx);
    expect(seen[0]!.name).toBe("DeregisterImageCommand");
    expect(seen.filter((c) => c.name === "DeleteSnapshotCommand").map((c) => c.input.SnapshotId)).toEqual([
      "snap-a",
      "snap-b",
    ]);
  });

  test("rollback(): no-op when imageId was never captured", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(AMI_PARAMS, {}, (cmd) => {
      seen.push(cmd.constructor.name);
      return {};
    });
    await createAmiStep.rollback!(ctx);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assign-elastic-ip
// ---------------------------------------------------------------------------

const EIP_PARAMS: EipParams = {
  LOGICAL_NAME: "web-eip",
  INSTANCE_ID: "i-1",
  TAGS: {},
};

describe("aws/ec2/assign-elastic-ip", () => {
  test("check(): no tagged address -> missing", async () => {
    const ctx = ec2Ctx(EIP_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeAddressesCommand") return { Addresses: [] };
      return {};
    });
    expect(await assignEipStep.check(ctx)).toBe("missing");
  });

  test("check(): tagged but unassociated -> missing", async () => {
    const ctx = ec2Ctx(EIP_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeAddressesCommand") {
        return { Addresses: [{ AllocationId: "eipalloc-1" }] };
      }
      return {};
    });
    expect(await assignEipStep.check(ctx)).toBe("missing");
  });

  test("check(): tagged + associated to target instance -> exists", async () => {
    const ctx = ec2Ctx(EIP_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeAddressesCommand") {
        return { Addresses: [{ AllocationId: "eipalloc-1", AssociationId: "eipassoc-1", InstanceId: "i-1" }] };
      }
      return {};
    });
    expect(await assignEipStep.check(ctx)).toBe("exists");
  });

  test("check(): tagged + associated elsewhere -> conflict", async () => {
    const ctx = ec2Ctx(EIP_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeAddressesCommand") {
        return { Addresses: [{ AllocationId: "eipalloc-1", AssociationId: "eipassoc-1", InstanceId: "i-999" }] };
      }
      return {};
    });
    expect(await assignEipStep.check(ctx)).toBe("conflict");
  });

  test("create(): allocates + associates with AllowReassociation false", async () => {
    let captured: Record<string, unknown> | undefined;
    const ctx = ec2Ctx(EIP_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "AllocateAddressCommand") return { AllocationId: "eipalloc-1", PublicIp: "1.2.3.4" };
      if (name === "AssociateAddressCommand") {
        captured = cmd.input;
        return { AssociationId: "eipassoc-1" };
      }
      return {};
    });
    const out = await assignEipStep.create!(ctx);
    expect(out).toEqual({ allocationId: "eipalloc-1", publicIp: "1.2.3.4", associationId: "eipassoc-1" });
    expect(captured?.AllowReassociation).toBe(false);
  });

  test("rollback(): disassociates then releases", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(
      EIP_PARAMS,
      { allocationId: "eipalloc-1", associationId: "eipassoc-1" },
      (cmd) => {
        seen.push(cmd.constructor.name);
        return {};
      },
    );
    await assignEipStep.rollback!(ctx);
    expect(seen).toEqual(["DisassociateAddressCommand", "ReleaseAddressCommand"]);
  });
});

// ---------------------------------------------------------------------------
// tag-instance
// ---------------------------------------------------------------------------

const TAG_PARAMS: TagParams = {
  INSTANCE_ID: "i-1",
  TAGS: { env: "prod", team: "platform" },
  PRUNE_UNMANAGED_TAGS: false,
};

describe("aws/ec2/tag-instance", () => {
  test("check(): instance exists -> exists", async () => {
    const ctx = ec2Ctx(TAG_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ InstanceId: "i-1" }] }] };
      }
      return {};
    });
    expect(await tagsStep.check(ctx)).toBe("exists");
  });

  test("check(): instance missing -> conflict", async () => {
    const ctx = ec2Ctx(TAG_PARAMS, {}, () => ({ Reservations: [] }));
    expect(await tagsStep.check(ctx)).toBe("conflict");
  });

  test("reconcile(): additive-only, leaves unmanaged tags when PRUNE is false", async () => {
    const applied: Record<string, unknown>[] = [];
    const removed: Record<string, unknown>[] = [];
    const ctx = ec2Ctx(TAG_PARAMS, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeTagsCommand") {
        return { Tags: [{ Key: "env", Value: "staging" }, { Key: "extra", Value: "keepme" }] };
      }
      if (name === "CreateTagsCommand") {
        applied.push(cmd.input);
        return {};
      }
      if (name === "DeleteTagsCommand") {
        removed.push(cmd.input);
        return {};
      }
      return {};
    });
    const out = await tagsStep.reconcile!(ctx);
    expect(removed).toEqual([]);
    expect(applied.length).toBe(1);
    const tagsSent = applied[0]!.Tags as { Key: string; Value: string }[];
    const keys = tagsSent.map((t) => t.Key).sort();
    expect(keys).toEqual(["env", "team"]);
    const priorValues = JSON.parse(out.priorValuesJson as string);
    expect(priorValues).toEqual({ env: "staging", team: null });
  });

  test("reconcile(): PRUNE_UNMANAGED_TAGS removes tags not in desired set", async () => {
    const removed: Record<string, unknown>[] = [];
    const params: TagParams = { ...TAG_PARAMS, PRUNE_UNMANAGED_TAGS: true };
    const ctx = ec2Ctx(params, {}, (cmd) => {
      const name = cmd.constructor.name;
      if (name === "DescribeTagsCommand") {
        return { Tags: [{ Key: "env", Value: "prod" }, { Key: "team", Value: "platform" }, { Key: "extra", Value: "x" }] };
      }
      if (name === "DeleteTagsCommand") {
        removed.push(cmd.input);
        return {};
      }
      return {};
    });
    const out = await tagsStep.reconcile!(ctx);
    expect(removed.length).toBe(1);
    const tagsSent = removed[0]!.Tags as { Key: string }[];
    expect(tagsSent.map((t) => t.Key)).toEqual(["extra"]);
    const removedKeys = JSON.parse(out.removedKeysJson as string);
    expect(removedKeys).toEqual(["extra"]);
  });

  test("rollback(): restores exactly the captured prior values", async () => {
    const applied: Record<string, unknown>[] = [];
    const removed: Record<string, unknown>[] = [];
    const ctx = ec2Ctx(
      TAG_PARAMS,
      {
        touchedKeysJson: JSON.stringify(["env", "team", "extra"]),
        priorValuesJson: JSON.stringify({ env: "staging", team: null, extra: "keepme" }),
      },
      (cmd) => {
        const name = cmd.constructor.name;
        if (name === "CreateTagsCommand") {
          applied.push(cmd.input);
          return {};
        }
        if (name === "DeleteTagsCommand") {
          removed.push(cmd.input);
          return {};
        }
        return {};
      },
    );
    await tagsStep.rollback!(ctx);
    const restoredTags = applied[0]!.Tags as { Key: string; Value: string }[];
    const restoredMap = Object.fromEntries(restoredTags.map((t) => [t.Key, t.Value]));
    expect(restoredMap).toEqual({ env: "staging", extra: "keepme" });
    const deletedKeys = removed[0]!.Tags as { Key: string }[];
    expect(deletedKeys.map((t) => t.Key)).toEqual(["team"]);
  });

  test("rollback(): no-op when nothing was touched this run", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(TAG_PARAMS, {}, (cmd) => {
      seen.push(cmd.constructor.name);
      return {};
    });
    await tagsStep.rollback!(ctx);
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// update-instance-type
// ---------------------------------------------------------------------------

const UPDATE_PARAMS: UpdateTypeParams = {
  INSTANCE_ID: "i-1",
  TARGET_INSTANCE_TYPE: "m5.large",
};

/** Instance state machine driven purely by which commands have already been sent. */
function makeInstanceStateTracker(initial: "running" | "stopped") {
  let state: "running" | "stopped" = initial;
  let type = "m5.small";
  return {
    handle(cmd: Command): unknown | undefined {
      const name = cmd.constructor.name;
      if (name === "StopInstancesCommand") {
        state = "stopped";
        return {};
      }
      if (name === "StartInstancesCommand") {
        state = "running";
        return {};
      }
      if (name === "ModifyInstanceAttributeCommand") {
        type = (cmd.input.InstanceType as { Value: string }).Value;
        return {};
      }
      if (name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ InstanceType: type, State: { Name: state } }] }] };
      }
      return undefined;
    },
    get type() {
      return type;
    },
    get state() {
      return state;
    },
  };
}

describe("aws/ec2/update-instance-type", () => {
  test("check(): already the target type -> exists", async () => {
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ InstanceType: "m5.large", State: { Name: "running" } }] }] };
      }
      return {};
    });
    expect(await updateInstanceTypeStep.check(ctx)).toBe("exists");
  });

  test("check(): different type, running -> missing", async () => {
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ InstanceType: "m5.small", State: { Name: "running" } }] }] };
      }
      return {};
    });
    expect(await updateInstanceTypeStep.check(ctx)).toBe("missing");
  });

  test("check(): instance pending -> conflict", async () => {
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ InstanceType: "m5.small", State: { Name: "pending" } }] }] };
      }
      return {};
    });
    expect(await updateInstanceTypeStep.check(ctx)).toBe("conflict");
  });

  test("check(): instance not found -> conflict", async () => {
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, () => ({ Reservations: [] }));
    expect(await updateInstanceTypeStep.check(ctx)).toBe("conflict");
  });

  test("create(): stop -> modify -> start orchestration when originally running", async () => {
    const tracker = makeInstanceStateTracker("running");
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, (cmd) => tracker.handle(cmd) ?? {});
    const out = await updateInstanceTypeStep.create!(ctx);
    expect(out.originalInstanceType).toBe("m5.small");
    expect(out.wasOriginallyRunning).toBe(true);
    expect(out.modifyAppliedThisRun).toBe(true);
    expect(out.newInstanceType).toBe("m5.large");
    expect(tracker.state).toBe("running");
    expect(tracker.type).toBe("m5.large");
  });

  test("create(): originally stopped -> does not restart", async () => {
    const tracker = makeInstanceStateTracker("stopped");
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, (cmd) => tracker.handle(cmd) ?? {});
    const out = await updateInstanceTypeStep.create!(ctx);
    expect(out.wasOriginallyRunning).toBe(false);
    expect(tracker.state).toBe("stopped");
    expect(tracker.type).toBe("m5.large");
  });

  test("rollback(): case 1 - before modify ran, just restores original power state", async () => {
    const seen: string[] = [];
    // modifyAppliedThisRun is absent/false: never got that far.
    const ctx = ec2Ctx(
      UPDATE_PARAMS,
      { originalInstanceType: "m5.small", wasOriginallyRunning: true, modifyAppliedThisRun: false },
      (cmd) => {
        seen.push(cmd.constructor.name);
        if (cmd.constructor.name === "DescribeInstancesCommand") {
          return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
        }
        return {};
      },
    );
    await updateInstanceTypeStep.rollback!(ctx);
    expect(seen).toContain("StartInstancesCommand");
    expect(seen).not.toContain("ModifyInstanceAttributeCommand");
  });

  test("rollback(): case 1 - before modify ran, originally stopped -> no restart attempted", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(
      UPDATE_PARAMS,
      { originalInstanceType: "m5.small", wasOriginallyRunning: false, modifyAppliedThisRun: false },
      (cmd) => {
        seen.push(cmd.constructor.name);
        return {};
      },
    );
    await updateInstanceTypeStep.rollback!(ctx);
    expect(seen).toEqual([]);
  });

  test("rollback(): case 2 - after modify, restart succeeds", async () => {
    const seen: string[] = [];
    let started = false;
    const ctx = ec2Ctx(
      UPDATE_PARAMS,
      { originalInstanceType: "m5.small", wasOriginallyRunning: true, modifyAppliedThisRun: true },
      (cmd) => {
        const name = cmd.constructor.name;
        seen.push(name);
        if (name === "StartInstancesCommand") {
          started = true;
          return {};
        }
        if (name === "DescribeInstancesCommand") {
          return { Reservations: [{ Instances: [{ State: { Name: started ? "running" : "stopped" } }] }] };
        }
        return {};
      },
    );
    await updateInstanceTypeStep.rollback!(ctx);
    expect(seen).toContain("ModifyInstanceAttributeCommand");
    expect(seen).toContain("StartInstancesCommand");
  });

  test("rollback(): case 2 - after modify, originally stopped -> reverts type, no restart", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(
      UPDATE_PARAMS,
      { originalInstanceType: "m5.small", wasOriginallyRunning: false, modifyAppliedThisRun: true },
      (cmd) => {
        seen.push(cmd.constructor.name);
        return {};
      },
    );
    await updateInstanceTypeStep.rollback!(ctx);
    expect(seen).toEqual(["ModifyInstanceAttributeCommand"]);
  });

  test("rollback(): case 3 - restart keeps failing with capacity error -> reverts type, then throws loudly", async () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const ctx = ec2Ctx(
      UPDATE_PARAMS,
      { originalInstanceType: "m5.small", wasOriginallyRunning: true, modifyAppliedThisRun: true },
      (cmd) => {
        const name = cmd.constructor.name;
        seen.push(name);
        if (name === "StartInstancesCommand") {
          return awsError("InsufficientInstanceCapacity");
        }
        return {};
      },
    );
    ctx.log = { ...NO_LOG, error: (m: string) => errors.push(m) };

    // retryWithBackoff sleeps real time between attempts (5s/15s/30s) — patch
    // setTimeout for the duration of this call only so the test stays fast.
    const realSetTimeout = globalThis.setTimeout;
    // @ts-expect-error - intentionally narrowing the global for this test only
    globalThis.setTimeout = (fn: (...a: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    try {
      await expect(updateInstanceTypeStep.rollback!(ctx)).rejects.toThrow();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(seen).toContain("ModifyInstanceAttributeCommand");
    expect(seen.filter((n) => n === "StartInstancesCommand").length).toBe(4); // initial + 3 retries
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("manual intervention required");
  });

  test("rollback(): no-op when untouched this run", async () => {
    const seen: string[] = [];
    const ctx = ec2Ctx(UPDATE_PARAMS, {}, (cmd) => {
      seen.push(cmd.constructor.name);
      return {};
    });
    await updateInstanceTypeStep.rollback!(ctx);
    expect(seen).toEqual([]);
  });
});
