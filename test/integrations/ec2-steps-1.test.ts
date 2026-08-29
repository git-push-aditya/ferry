import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { launchStep } from "../../integrations/aws/ec2/launch-instance/steps/launch";
import type { Params as LaunchParams } from "../../integrations/aws/ec2/launch-instance/params";
import { groupStep } from "../../integrations/aws/ec2/create-security-group/steps/group";
import type { Params as GroupParams } from "../../integrations/aws/ec2/create-security-group/params";
import { reconcileRulesStep } from "../../integrations/aws/ec2/update-security-group-rules/steps/reconcile-rules";
import type { Params as RulesParams } from "../../integrations/aws/ec2/update-security-group-rules/params";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
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

// ---------------------------------------------------------------------------
// stop-start-instance
// ---------------------------------------------------------------------------

function describeReply(state: string) {
  return { Reservations: [{ Instances: [{ State: { Name: state } }] }] };
}

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

