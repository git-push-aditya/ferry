import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { launchStep } from "../../integrations/aws/ec2/launch-instance/steps/launch";
import type { Params as LaunchParams } from "../../integrations/aws/ec2/launch-instance/params";
import { terminateStep } from "../../integrations/aws/ec2/terminate-instance/steps/terminate";
import type { Params as TerminateParams } from "../../integrations/aws/ec2/terminate-instance/params";
import { stopStartStep } from "../../integrations/aws/ec2/stop-start-instance/steps/stop-start";
import type { Params as StopStartParams } from "../../integrations/aws/ec2/stop-start-instance/params";
import { groupStep } from "../../integrations/aws/ec2/create-security-group/steps/group";
import type { Params as GroupParams } from "../../integrations/aws/ec2/create-security-group/params";
import { reconcileRulesStep } from "../../integrations/aws/ec2/update-security-group-rules/steps/reconcile-rules";
import type { Params as RulesParams } from "../../integrations/aws/ec2/update-security-group-rules/params";
import { attachDetachStep } from "../../integrations/aws/ec2/attach-detach-ebs-volume/steps/attach-detach";
import type { Params as AttachDetachParams } from "../../integrations/aws/ec2/attach-detach-ebs-volume/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

type Command = { constructor: { name: string }; input: Record<string, unknown> };

/** dry-run context: check() only — create()/reconcile() must never be invoked by these tests. */
function ec2PlanCtx<P>(params: P, send: (command: Command) => unknown): StepContext<P> {
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

describe("ec2 dry-run plan: launch-instance", () => {
  const params: LaunchParams = {
    LOGICAL_NAME: "web-1",
    AMI_ID: "ami-123",
    INSTANCE_TYPE: "t3.micro",
    SUBNET_ID: "subnet-123",
    SECURITY_GROUP_IDS: ["sg-1"],
    KEY_PAIR_NAME: undefined,
    CLIENT_TOKEN_OVERRIDE: undefined,
    TAGS: {},
  };

  test("no tagged instance found -> missing", async () => {
    const ctx = ec2PlanCtx(params, () => ({ Reservations: [] }));
    expect(await launchStep.check(ctx)).toBe("missing");
  });

  test("tagged instance already running -> exists", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      Reservations: [{ Instances: [{ State: { Name: "running" } }] }],
    }));
    expect(await launchStep.check(ctx)).toBe("exists");
  });
});

describe("ec2 dry-run plan: terminate-instance", () => {
  const params: TerminateParams = { INSTANCE_ID: "i-1", PRESERVE_VOLUME_CHECK: true };

  test("running instance, no stranded volume -> missing", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      Reservations: [{ Instances: [{ State: { Name: "running" }, BlockDeviceMappings: [] }] }],
    }));
    expect(await terminateStep.check(ctx)).toBe("missing");
  });

  test("already terminated -> exists", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      Reservations: [{ Instances: [{ State: { Name: "terminated" } }] }],
    }));
    expect(await terminateStep.check(ctx)).toBe("exists");
  });

  test("running with preserved (DeleteOnTermination=false) volume -> conflict", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      Reservations: [
        {
          Instances: [
            { State: { Name: "running" }, BlockDeviceMappings: [{ Ebs: { DeleteOnTermination: false } }] },
          ],
        },
      ],
    }));
    expect(await terminateStep.check(ctx)).toBe("conflict");
  });
});

describe("ec2 dry-run plan: stop-start-instance", () => {
  test("ACTION=stop, instance running -> missing", async () => {
    const ctx = ec2PlanCtx<StopStartParams>({ INSTANCE_ID: "i-1", ACTION: "stop" }, () => ({
      Reservations: [{ Instances: [{ State: { Name: "running" } }] }],
    }));
    expect(await stopStartStep.check(ctx)).toBe("missing");
  });

  test("ACTION=start, instance already running -> exists", async () => {
    const ctx = ec2PlanCtx<StopStartParams>({ INSTANCE_ID: "i-1", ACTION: "start" }, () => ({
      Reservations: [{ Instances: [{ State: { Name: "running" } }] }],
    }));
    expect(await stopStartStep.check(ctx)).toBe("exists");
  });

  test("mid-transition (pending) -> conflict", async () => {
    const ctx = ec2PlanCtx<StopStartParams>({ INSTANCE_ID: "i-1", ACTION: "stop" }, () => ({
      Reservations: [{ Instances: [{ State: { Name: "pending" } }] }],
    }));
    expect(await stopStartStep.check(ctx)).toBe("conflict");
  });
});

describe("ec2 dry-run plan: create-security-group", () => {
  const params: GroupParams = {
    GROUP_NAME: "web-sg",
    GROUP_DESCRIPTION: "web tier",
    VPC_ID: "vpc-1",
    INGRESS_RULES: [],
    EGRESS_RULES: [],
  };

  test("no group by that name/vpc -> missing", async () => {
    const ctx = ec2PlanCtx(params, () => ({ SecurityGroups: [] }));
    expect(await groupStep.check(ctx)).toBe("missing");
  });

  test("group exists, tagged ours -> exists", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      SecurityGroups: [
        { GroupId: "sg-1", Tags: [{ Key: "ferry:integration-id", Value: "aws/ec2/create-security-group" }] },
      ],
    }));
    expect(await groupStep.check(ctx)).toBe("exists");
  });

  test("group exists, untagged (name collision) -> conflict", async () => {
    const ctx = ec2PlanCtx(params, () => ({ SecurityGroups: [{ GroupId: "sg-1", Tags: [] }] }));
    expect(await groupStep.check(ctx)).toBe("conflict");
  });
});

describe("ec2 dry-run plan: update-security-group-rules", () => {
  const params: RulesParams = {
    GROUP_ID: "sg-123",
    DESIRED_INGRESS_RULES: [],
    DESIRED_EGRESS_RULES: [],
  };

  test("group exists -> missing (reconcile still needs to run)", async () => {
    const ctx = ec2PlanCtx(params, () => ({
      SecurityGroups: [{ GroupId: "sg-123", IpPermissions: [], IpPermissionsEgress: [] }],
    }));
    expect(await reconcileRulesStep.check(ctx)).toBe("missing");
  });

  test("group doesn't exist -> conflict", async () => {
    const ctx = ec2PlanCtx(params, () => ({ SecurityGroups: [] }));
    expect(await reconcileRulesStep.check(ctx)).toBe("conflict");
  });
});

describe("ec2 dry-run plan: attach-detach-ebs-volume", () => {
  const attachParams: AttachDetachParams = {
    VOLUME_ID: "vol-1",
    INSTANCE_ID: "i-1",
    DEVICE: "/dev/sdf",
    ACTION: "attach",
    FORCE: false,
  };
  const detachParams: AttachDetachParams = { ...attachParams, ACTION: "detach" };

  test("ACTION=attach, volume unattached -> missing", async () => {
    const ctx = ec2PlanCtx(attachParams, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") {
        return { Volumes: [{ VolumeId: "vol-1", Attachments: [] }] };
      }
      return {};
    });
    expect(await attachDetachStep.check(ctx)).toBe("missing");
  });

  test("ACTION=attach, already attached with matching device -> exists", async () => {
    const ctx = ec2PlanCtx(attachParams, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") {
        return { Volumes: [{ VolumeId: "vol-1", Attachments: [{ InstanceId: "i-1", Device: "/dev/sdf" }] }] };
      }
      return {};
    });
    expect(await attachDetachStep.check(ctx)).toBe("exists");
  });

  test("ACTION=detach, already detached -> exists", async () => {
    const ctx = ec2PlanCtx(detachParams, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") {
        return { Volumes: [{ VolumeId: "vol-1", Attachments: [] }] };
      }
      return {};
    });
    expect(await attachDetachStep.check(ctx)).toBe("exists");
  });

  test("ACTION=detach, root volume of a running instance -> conflict", async () => {
    const ctx = ec2PlanCtx(detachParams, (cmd) => {
      if (cmd.constructor.name === "DescribeVolumesCommand") {
        return { Volumes: [{ VolumeId: "vol-1", Attachments: [{ InstanceId: "i-1", Device: "/dev/sda1" }] }] };
      }
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  State: { Name: "running" },
                  RootDeviceName: "/dev/sda1",
                  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-1" } }],
                },
              ],
            },
          ],
        };
      }
      return {};
    });
    expect(await attachDetachStep.check(ctx)).toBe("conflict");
  });
});
