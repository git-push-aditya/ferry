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

function ec2Ctx<P>(
  params: P,
  outputs: Record<string, unknown>,
  send: (command: Command) => unknown,
): StepContext<P> {
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
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function recorder() {
  const sent: string[] = [];
  const inputs: Record<string, unknown>[] = [];
  const push = (command: Command) => {
    sent.push(command.constructor.name);
    inputs.push(command.input);
  };
  return { sent, inputs, push };
}

// ---------------------------------------------------------------------------
// launch-instance
// ---------------------------------------------------------------------------

const LAUNCH_PARAMS: LaunchParams = {
  LOGICAL_NAME: "web-1",
  AMI_ID: "ami-123",
  INSTANCE_TYPE: "t3.micro",
  SUBNET_ID: "subnet-123",
  SECURITY_GROUP_IDS: ["sg-1", "sg-2"],
  KEY_PAIR_NAME: "my-key",
  CLIENT_TOKEN_OVERRIDE: undefined,
  TAGS: { env: "prod" },
};

describe("launch-instance", () => {
  test("check() finds no tagged instance -> missing", async () => {
    const ctx = ec2Ctx(LAUNCH_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") return { Reservations: [] };
      return {};
    });
    expect(await launchStep.check(ctx)).toBe("missing");
  });

  test("check() finds an existing non-terminated tagged instance -> exists", async () => {
    const ctx = ec2Ctx(LAUNCH_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ State: { Name: "running" } }] }] };
      }
      return {};
    });
    expect(await launchStep.check(ctx)).toBe("exists");
  });

  test("create() sends RunInstances with TagSpecifications + ClientToken and captures outputs", async () => {
    const { sent, inputs, push } = recorder();
    const ctx = ec2Ctx(LAUNCH_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "RunInstancesCommand") {
        return {
          Instances: [
            { InstanceId: "i-abc", PrivateIpAddress: "10.0.0.1", Placement: { AvailabilityZone: "ap-south-1a" } },
          ],
        };
      }
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-abc",
                  State: { Name: "running" },
                  PrivateIpAddress: "10.0.0.1",
                  Placement: { AvailabilityZone: "ap-south-1a" },
                },
              ],
            },
          ],
        };
      }
      return {};
    });

    const outputs = await launchStep.create!(ctx);

    expect(sent[0]).toBe("RunInstancesCommand");
    const runInput = inputs[0];
    expect(runInput.ImageId).toBe("ami-123");
    expect(runInput.ClientToken).toBeTruthy();
    expect(runInput.TagSpecifications).toEqual([
      {
        ResourceType: "instance",
        Tags: [
          { Key: "ferry:integration-id", Value: "aws/ec2/launch-instance" },
          { Key: "ferry:logical-name", Value: "web-1" },
          { Key: "env", Value: "prod" },
        ],
      },
    ]);
    expect(outputs.instanceId).toBe("i-abc");
    expect(outputs.privateIp).toBe("10.0.0.1");
    expect(outputs.availabilityZone).toBe("ap-south-1a");
  });

  test("rollback terminates the launched instance", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(LAUNCH_PARAMS, { instanceId: "i-abc" }, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "TerminateInstancesCommand") return {};
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ State: { Name: "terminated" } }] }] };
      }
      return {};
    });

    await launchStep.rollback!(ctx);

    expect(sent).toContain("TerminateInstancesCommand");
  });

  test("rollback is a no-op when nothing was created this run", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(LAUNCH_PARAMS, {}, (cmd) => {
      push(cmd);
      return {};
    });
    await launchStep.rollback!(ctx);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// terminate-instance
// ---------------------------------------------------------------------------

const TERMINATE_PARAMS: TerminateParams = {
  INSTANCE_ID: "i-term1",
  PRESERVE_VOLUME_CHECK: true,
};

describe("terminate-instance", () => {
  test("check(): already terminated -> exists", async () => {
    const ctx = ec2Ctx(TERMINATE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ State: { Name: "terminated" } }] }] };
      }
      return {};
    });
    expect(await terminateStep.check(ctx)).toBe("exists");
  });

  test("check(): purged entirely (InvalidInstanceID.NotFound) -> exists", async () => {
    const ctx = ec2Ctx(TERMINATE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") return awsError("InvalidInstanceID.NotFound");
      return {};
    });
    expect(await terminateStep.check(ctx)).toBe("exists");
  });

  test("check(): running with no stranded volume -> missing", async () => {
    const ctx = ec2Ctx({ ...TERMINATE_PARAMS, PRESERVE_VOLUME_CHECK: false }, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return { Reservations: [{ Instances: [{ State: { Name: "running" }, BlockDeviceMappings: [] }] }] };
      }
      return {};
    });
    expect(await terminateStep.check(ctx)).toBe("missing");
  });

  test("check(): running with DeleteOnTermination=false volume + PRESERVE_VOLUME_CHECK -> conflict", async () => {
    const ctx = ec2Ctx(TERMINATE_PARAMS, {}, (cmd) => {
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                {
                  State: { Name: "running" },
                  BlockDeviceMappings: [{ Ebs: { DeleteOnTermination: false } }],
                },
              ],
            },
          ],
        };
      }
      return {};
    });
    expect(await terminateStep.check(ctx)).toBe("conflict");
  });

  test("create() terminates the instance and captures a snapshot", async () => {
    const { sent, push } = recorder();
    let describeCount = 0;
    const ctx = ec2Ctx(TERMINATE_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        describeCount += 1;
        if (describeCount === 1) {
          return {
            Reservations: [
              { Instances: [{ ImageId: "ami-1", InstanceType: "t3.micro", SubnetId: "subnet-1", SecurityGroups: [], Tags: [] }] },
            ],
          };
        }
        return { Reservations: [{ Instances: [{ State: { Name: "terminated" } }] }] };
      }
      return {};
    });

    const outputs = await terminateStep.create!(ctx);

    expect(sent).toContain("TerminateInstancesCommand");
    expect(outputs.instanceId).toBe("i-term1");
    expect(outputs.terminatedThisRun).toBe(true);
  });

  test("rollback is a no-op (logs warning, sends nothing) when terminated this run", async () => {
    const { sent, push } = recorder();
    const warnings: string[] = [];
    const ctx = ec2Ctx(TERMINATE_PARAMS, { instanceId: "i-term1", terminatedThisRun: true }, (cmd) => {
      push(cmd);
      return {};
    });
    ctx.log = { info() {}, warn: (m: string) => warnings.push(m), error() {}, success() {} };

    await expect(terminateStep.rollback!(ctx)).resolves.toBeUndefined();

    expect(sent).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("rollback does nothing when the run never terminated anything", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(TERMINATE_PARAMS, {}, (cmd) => {
      push(cmd);
      return {};
    });
    await expect(terminateStep.rollback!(ctx)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stop-start-instance
// ---------------------------------------------------------------------------

const STOP_PARAMS: StopStartParams = { INSTANCE_ID: "i-ss1", ACTION: "stop" };
const START_PARAMS: StopStartParams = { INSTANCE_ID: "i-ss1", ACTION: "start" };

function describeReply(state: string) {
  return { Reservations: [{ Instances: [{ State: { Name: state } }] }] };
}

describe("stop-start-instance", () => {
  test("check(ACTION=stop): running -> missing", async () => {
    const ctx = ec2Ctx(STOP_PARAMS, {}, (cmd) => (cmd.constructor.name === "DescribeInstancesCommand" ? describeReply("running") : {}));
    expect(await stopStartStep.check(ctx)).toBe("missing");
  });

  test("check(ACTION=stop): already stopped -> exists (skip)", async () => {
    const ctx = ec2Ctx(STOP_PARAMS, {}, (cmd) => (cmd.constructor.name === "DescribeInstancesCommand" ? describeReply("stopped") : {}));
    expect(await stopStartStep.check(ctx)).toBe("exists");
  });

  test("check(ACTION=start): stopped -> missing", async () => {
    const ctx = ec2Ctx(START_PARAMS, {}, (cmd) => (cmd.constructor.name === "DescribeInstancesCommand" ? describeReply("stopped") : {}));
    expect(await stopStartStep.check(ctx)).toBe("missing");
  });

  test("check(ACTION=start): already running -> exists (skip)", async () => {
    const ctx = ec2Ctx(START_PARAMS, {}, (cmd) => (cmd.constructor.name === "DescribeInstancesCommand" ? describeReply("running") : {}));
    expect(await stopStartStep.check(ctx)).toBe("exists");
  });

  test("check(): mid-transition state -> conflict", async () => {
    const ctx = ec2Ctx(STOP_PARAMS, {}, (cmd) => (cmd.constructor.name === "DescribeInstancesCommand" ? describeReply("pending") : {}));
    expect(await stopStartStep.check(ctx)).toBe("conflict");
  });

  test("create(ACTION=stop) sends StopInstances and polls to stopped immediately (no real wait)", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(STOP_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeInstancesCommand") return describeReply("stopped");
      return {};
    });

    const start = Date.now();
    const outputs = await stopStartStep.create!(ctx);
    expect(Date.now() - start).toBeLessThan(2000);

    expect(sent).toContain("StopInstancesCommand");
    expect(outputs.actionTakenThisRun).toBe("stop");
  });

  test("create(ACTION=start) sends StartInstances", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(START_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeInstancesCommand") return describeReply("running");
      return {};
    });
    const outputs = await stopStartStep.create!(ctx);
    expect(sent).toContain("StartInstancesCommand");
    expect(outputs.actionTakenThisRun).toBe("start");
  });

  test("rollback reverses a stop by starting the instance", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(STOP_PARAMS, { actionTakenThisRun: "stop" }, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeInstancesCommand") return describeReply("running");
      return {};
    });
    await stopStartStep.rollback!(ctx);
    expect(sent).toContain("StartInstancesCommand");
  });

  test("rollback reverses a start by stopping the instance", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(START_PARAMS, { actionTakenThisRun: "start" }, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeInstancesCommand") return describeReply("stopped");
      return {};
    });
    await stopStartStep.rollback!(ctx);
    expect(sent).toContain("StopInstancesCommand");
  });

  test("rollback does nothing when untouched this run", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(STOP_PARAMS, {}, (cmd) => {
      push(cmd);
      return {};
    });
    await stopStartStep.rollback!(ctx);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// create-security-group
// ---------------------------------------------------------------------------

const GROUP_PARAMS: GroupParams = {
  GROUP_NAME: "web-sg",
  GROUP_DESCRIPTION: "web tier",
  VPC_ID: "vpc-1",
  INGRESS_RULES: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidr: "10.0.0.0/8" }],
  EGRESS_RULES: [],
};

function convergedRulesReply() {
  return {
    SecurityGroups: [
      {
        GroupId: "sg-new",
        IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "10.0.0.0/8" }] }],
        IpPermissionsEgress: [],
      },
    ],
  };
}

describe("create-security-group", () => {
  test("check(): no group with that name/vpc -> missing", async () => {
    const ctx = ec2Ctx(GROUP_PARAMS, {}, (cmd) =>
      cmd.constructor.name === "DescribeSecurityGroupsCommand" ? { SecurityGroups: [] } : {},
    );
    expect(await groupStep.check(ctx)).toBe("missing");
  });

  test("check(): group exists and is tagged ours -> exists", async () => {
    const ctx = ec2Ctx(GROUP_PARAMS, {}, (cmd) =>
      cmd.constructor.name === "DescribeSecurityGroupsCommand"
        ? {
            SecurityGroups: [
              { GroupId: "sg-old", Tags: [{ Key: "ferry:integration-id", Value: "aws/ec2/create-security-group" }] },
            ],
          }
        : {},
    );
    expect(await groupStep.check(ctx)).toBe("exists");
  });

  test("check(): group exists with same name but untagged -> conflict", async () => {
    const ctx = ec2Ctx(GROUP_PARAMS, {}, (cmd) =>
      cmd.constructor.name === "DescribeSecurityGroupsCommand"
        ? { SecurityGroups: [{ GroupId: "sg-foreign", Tags: [] }] }
        : {},
    );
    expect(await groupStep.check(ctx)).toBe("conflict");
  });

  test("create() applies starting rules after creating the group", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(GROUP_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "CreateSecurityGroupCommand") return { GroupId: "sg-new" };
      if (cmd.constructor.name === "DescribeSecurityGroupsCommand") return convergedRulesReply();
      return {};
    });

    const outputs = await groupStep.create!(ctx);

    expect(sent).toContain("CreateSecurityGroupCommand");
    expect(sent).toContain("AuthorizeSecurityGroupIngressCommand");
    expect(outputs.groupId).toBe("sg-new");
    expect(outputs.ruleCount).toBe(1);
  });

  test("reconcile() re-applies missing rules on an already-existing tagged group (idempotency-gap fix)", async () => {
    const { sent, inputs, push } = recorder();
    let describeCalls = 0;
    const ctx = ec2Ctx(GROUP_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeSecurityGroupsCommand") {
        describeCalls += 1;
        // Calls 1 (group lookup) and 2 (rule read before diffing): no rules
        // applied yet. Call 3+ (poll convergence, after the Authorize call
        // has been sent) reports converged.
        if (describeCalls <= 2) {
          return { SecurityGroups: [{ GroupId: "sg-existing", IpPermissions: [], IpPermissionsEgress: [] }] };
        }
        return convergedRulesReply();
      }
      return {};
    });

    const outputs = await groupStep.reconcile!(ctx);

    expect(sent).toContain("AuthorizeSecurityGroupIngressCommand");
    expect(sent).not.toContain("RevokeSecurityGroupIngressCommand");
    expect(outputs.groupId).toBe("sg-existing");
    const authorizeCall = inputs[sent.indexOf("AuthorizeSecurityGroupIngressCommand")];
    expect(authorizeCall.GroupId).toBe("sg-existing");
  });

  test("rollback deletes the group", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(GROUP_PARAMS, { groupId: "sg-new" }, (cmd) => {
      push(cmd);
      return {};
    });
    await groupStep.rollback!(ctx);
    expect(sent).toEqual(["DeleteSecurityGroupCommand"]);
  });

  test("rollback tolerates DependencyViolation", async () => {
    const ctx = ec2Ctx(GROUP_PARAMS, { groupId: "sg-new" }, (cmd) => {
      if (cmd.constructor.name === "DeleteSecurityGroupCommand") return awsError("DependencyViolation");
      return {};
    });
    await expect(groupStep.rollback!(ctx)).resolves.toBeUndefined();
  });

  test("rollback does nothing when no group was created", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(GROUP_PARAMS, {}, (cmd) => {
      push(cmd);
      return {};
    });
    await groupStep.rollback!(ctx);
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// update-security-group-rules
// ---------------------------------------------------------------------------

const RULES_PARAMS: RulesParams = {
  GROUP_ID: "sg-123",
  DESIRED_INGRESS_RULES: [
    { protocol: "tcp", fromPort: 443, toPort: 443, cidr: "0.0.0.0/0" }, // kept (present in both)
    { protocol: "tcp", fromPort: 8080, toPort: 8080, cidr: "10.0.0.0/8" }, // to add
  ],
  DESIRED_EGRESS_RULES: [],
};

const LIVE_INGRESS = [
  { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, // kept
  { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.2.3.4/32" }] }, // to revoke
];

describe("update-security-group-rules", () => {
  test("check(): group exists -> missing (still needs reconcile)", async () => {
    const ctx = ec2Ctx(RULES_PARAMS, {}, (cmd) =>
      cmd.constructor.name === "DescribeSecurityGroupsCommand"
        ? { SecurityGroups: [{ GroupId: "sg-123", IpPermissions: [], IpPermissionsEgress: [] }] }
        : {},
    );
    expect(await reconcileRulesStep.check(ctx)).toBe("missing");
  });

  test("check(): group doesn't exist -> conflict", async () => {
    const ctx = ec2Ctx(RULES_PARAMS, {}, (cmd) =>
      cmd.constructor.name === "DescribeSecurityGroupsCommand" ? { SecurityGroups: [] } : {},
    );
    expect(await reconcileRulesStep.check(ctx)).toBe("conflict");
  });

  test("reconcile(): revokes not-desired, adds missing, leaves shared rule untouched", async () => {
    const { sent, inputs, push } = recorder();
    let describeCount = 0;
    const ctx = ec2Ctx(RULES_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeSecurityGroupsCommand") {
        describeCount += 1;
        if (describeCount === 1) {
          return { SecurityGroups: [{ GroupId: "sg-123", IpPermissions: LIVE_INGRESS, IpPermissionsEgress: [] }] };
        }
        // convergence poll: report desired state already reached
        return {
          SecurityGroups: [
            {
              GroupId: "sg-123",
              IpPermissions: [
                { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] },
                { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, IpRanges: [{ CidrIp: "10.0.0.0/8" }] },
              ],
              IpPermissionsEgress: [],
            },
          ],
        };
      }
      return {};
    });

    const outputs = await reconcileRulesStep.reconcile!(ctx);

    expect(sent).toContain("RevokeSecurityGroupIngressCommand");
    expect(sent).toContain("AuthorizeSecurityGroupIngressCommand");

    const revokeInput = inputs[sent.indexOf("RevokeSecurityGroupIngressCommand")];
    expect(revokeInput.IpPermissions).toEqual([
      { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.2.3.4/32" }] },
    ]);
    const addInput = inputs[sent.indexOf("AuthorizeSecurityGroupIngressCommand")];
    expect(addInput.IpPermissions).toEqual([
      { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, IpRanges: [{ CidrIp: "10.0.0.0/8" }] },
    ]);

    // The 443 rule (present in both) is never mentioned in either call.
    expect(revokeInput.IpPermissions).not.toContainEqual(
      expect.objectContaining({ FromPort: 443 }),
    );
    expect(addInput.IpPermissions).not.toContainEqual(
      expect.objectContaining({ FromPort: 443 }),
    );

    expect(JSON.parse(outputs.revokedIngressJson as string)).toEqual(revokeInput.IpPermissions);
    expect(JSON.parse(outputs.addedIngressJson as string)).toEqual(addInput.IpPermissions);
  });

  test("rollback reverses the diff using the captured pre-image, not a re-diff", async () => {
    const { sent, inputs, push } = recorder();
    const revoked = [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.2.3.4/32" }] }];
    const added = [{ IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, IpRanges: [{ CidrIp: "10.0.0.0/8" }] }];
    const ctx = ec2Ctx(
      RULES_PARAMS,
      {
        revokedIngressJson: JSON.stringify(revoked),
        addedIngressJson: JSON.stringify(added),
        revokedEgressJson: "[]",
        addedEgressJson: "[]",
      },
      (cmd) => {
        push(cmd);
        return {};
      },
    );

    await reconcileRulesStep.rollback!(ctx);

    // Re-authorize what was revoked, re-revoke what was added — no live
    // DescribeSecurityGroups read is needed for rollback's own diff.
    expect(sent.filter((n) => n === "DescribeSecurityGroupsCommand")).toEqual([]);
    const revokeIdx = sent.indexOf("RevokeSecurityGroupIngressCommand");
    const authorizeIdx = sent.indexOf("AuthorizeSecurityGroupIngressCommand");
    expect(inputs[revokeIdx].IpPermissions).toEqual(added);
    expect(inputs[authorizeIdx].IpPermissions).toEqual(revoked);
  });
});

// ---------------------------------------------------------------------------
// attach-detach-ebs-volume
// ---------------------------------------------------------------------------

const ATTACH_PARAMS: AttachDetachParams = {
  VOLUME_ID: "vol-1",
  INSTANCE_ID: "i-1",
  DEVICE: "/dev/sdf",
  ACTION: "attach",
  FORCE: false,
};
const DETACH_PARAMS: AttachDetachParams = { ...ATTACH_PARAMS, ACTION: "detach" };

function ebsReplies(opts: {
  volume?: unknown;
  instance?: unknown;
}) {
  return (cmd: Command) => {
    if (cmd.constructor.name === "DescribeVolumesCommand") return opts.volume ?? {};
    if (cmd.constructor.name === "DescribeInstancesCommand") return opts.instance ?? {};
    return {};
  };
}

describe("attach-detach-ebs-volume", () => {
  test("check(ACTION=attach): unattached volume, same AZ implied -> missing", async () => {
    const ctx = ec2Ctx(
      ATTACH_PARAMS,
      {},
      ebsReplies({ volume: { Volumes: [{ VolumeId: "vol-1", Attachments: [] }] } }),
    );
    expect(await attachDetachStep.check(ctx)).toBe("missing");
  });

  test("check(ACTION=attach): already attached to this instance with same device -> exists", async () => {
    const ctx = ec2Ctx(
      ATTACH_PARAMS,
      {},
      ebsReplies({
        volume: { Volumes: [{ VolumeId: "vol-1", Attachments: [{ InstanceId: "i-1", Device: "/dev/sdf" }] }] },
      }),
    );
    expect(await attachDetachStep.check(ctx)).toBe("exists");
  });

  test("check(ACTION=detach): attached to instance, root volume + running -> conflict", async () => {
    const ctx = ec2Ctx(
      DETACH_PARAMS,
      {},
      ebsReplies({
        volume: { Volumes: [{ VolumeId: "vol-1", Attachments: [{ InstanceId: "i-1", Device: "/dev/sda1" }] }] },
        instance: {
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
        },
      }),
    );
    expect(await attachDetachStep.check(ctx)).toBe("conflict");
  });

  test("check(ACTION=detach): already detached -> exists", async () => {
    const ctx = ec2Ctx(
      DETACH_PARAMS,
      {},
      ebsReplies({ volume: { Volumes: [{ VolumeId: "vol-1", Attachments: [] }] } }),
    );
    expect(await attachDetachStep.check(ctx)).toBe("exists");
  });

  test("create(ACTION=attach) sends AttachVolume and confirms same-AZ instance", async () => {
    const { sent, push } = recorder();
    let volCalls = 0;
    const ctx = ec2Ctx(ATTACH_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeVolumesCommand") {
        volCalls += 1;
        // After AttachVolumeCommand is sent, poll sees it attached.
        const attached = sent.includes("AttachVolumeCommand");
        return {
          Volumes: [
            {
              VolumeId: "vol-1",
              AvailabilityZone: "ap-south-1a",
              Attachments: attached ? [{ InstanceId: "i-1", State: "attached" }] : [],
            },
          ],
        };
      }
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            { Instances: [{ InstanceId: "i-1", State: { Name: "running" }, Placement: { AvailabilityZone: "ap-south-1a" } }] },
          ],
        };
      }
      return {};
    });

    const outputs = await attachDetachStep.create!(ctx);
    expect(sent).toContain("AttachVolumeCommand");
    expect(outputs.actionTakenThisRun).toBe("attach");
  });

  test("create(ACTION=attach) throws when volume and instance are in different AZs", async () => {
    const ctx = ec2Ctx(
      ATTACH_PARAMS,
      {},
      ebsReplies({
        volume: { Volumes: [{ VolumeId: "vol-1", AvailabilityZone: "ap-south-1a", Attachments: [] }] },
        instance: {
          Reservations: [
            { Instances: [{ InstanceId: "i-1", State: { Name: "running" }, Placement: { AvailabilityZone: "ap-south-1b" } }] },
          ],
        },
      }),
    );
    await expect(attachDetachStep.create!(ctx)).rejects.toThrow(/Availability Zone/);
  });

  test("create(ACTION=detach) sends DetachVolume", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(DETACH_PARAMS, {}, (cmd) => {
      push(cmd);
      if (cmd.constructor.name === "DescribeVolumesCommand") {
        const detached = sent.includes("DetachVolumeCommand");
        return {
          Volumes: [
            { VolumeId: "vol-1", State: detached ? "available" : "in-use", Attachments: detached ? [] : [{ InstanceId: "i-1" }] },
          ],
        };
      }
      if (cmd.constructor.name === "DescribeInstancesCommand") {
        return {
          Reservations: [
            {
              Instances: [
                { InstanceId: "i-1", State: { Name: "running" }, RootDeviceName: "/dev/sda1", BlockDeviceMappings: [] },
              ],
            },
          ],
        };
      }
      return {};
    });

    const outputs = await attachDetachStep.create!(ctx);
    expect(sent).toContain("DetachVolumeCommand");
    expect(outputs.actionTakenThisRun).toBe("detach");
  });

  test("rollback reverses attach with a detach", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(ATTACH_PARAMS, { actionTakenThisRun: "attach", device: "/dev/sdf" }, (cmd) => {
      push(cmd);
      return {};
    });
    await attachDetachStep.rollback!(ctx);
    expect(sent).toEqual(["DetachVolumeCommand"]);
  });

  test("rollback reverses detach with an attach", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(DETACH_PARAMS, { actionTakenThisRun: "detach", device: "/dev/sdf" }, (cmd) => {
      push(cmd);
      return {};
    });
    await attachDetachStep.rollback!(ctx);
    expect(sent).toEqual(["AttachVolumeCommand"]);
  });

  test("rollback does nothing when untouched this run", async () => {
    const { sent, push } = recorder();
    const ctx = ec2Ctx(ATTACH_PARAMS, {}, (cmd) => {
      push(cmd);
      return {};
    });
    await attachDetachStep.rollback!(ctx);
    expect(sent).toEqual([]);
  });
});
