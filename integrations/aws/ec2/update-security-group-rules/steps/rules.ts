import {
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  type EC2Client,
  type IpPermission,
} from "@aws-sdk/client-ec2";
import { pollUntil } from "../../../../../src/core/wait";

/**
 * A single desired rule, as both `create-security-group` (starting rules)
 * and `update-security-group-rules` (desired ongoing rules) accept it from
 * their params. Exactly one of `cidr`/`sourceGroupId` per rule, matching the
 * verified AWS constraint that Authorize/Revoke accept exactly one of
 * CIDR/prefix-list/source-group per permission.
 */
export interface DesiredRule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
}

export type Direction = "ingress" | "egress";

export interface RuleDiff {
  toRevoke: IpPermission[];
  toAdd: IpPermission[];
}

/** Converts one desired rule into the single-entry IpPermission shape AWS's APIs expect. */
function toIpPermission(rule: DesiredRule): IpPermission {
  return {
    IpProtocol: rule.protocol,
    FromPort: rule.fromPort,
    ToPort: rule.toPort,
    IpRanges: rule.cidr ? [{ CidrIp: rule.cidr }] : undefined,
    UserIdGroupPairs: rule.sourceGroupId ? [{ GroupId: rule.sourceGroupId }] : undefined,
  };
}

/**
 * The full-tuple diff key: protocol, port range, and exactly one of
 * CIDR/source-group — matching the "specify exactly one" constraint the
 * Authorize/Revoke docs verify. A rule that changed only its port range is
 * one revoke + one add, not an in-place edit (no such edit API exists for
 * security group rules).
 */
function ruleKey(permission: IpPermission, cidr?: string, sourceGroupId?: string): string {
  return [
    permission.IpProtocol ?? "",
    permission.FromPort ?? "",
    permission.ToPort ?? "",
    cidr ?? "",
    sourceGroupId ?? "",
  ].join("|");
}

/** Expands a live IpPermission (possibly carrying several CIDRs/groups) into one entry per tuple. */
function expandLive(permissions: IpPermission[]): Map<string, IpPermission> {
  const entries = new Map<string, IpPermission>();
  for (const permission of permissions) {
    for (const range of permission.IpRanges ?? []) {
      if (!range.CidrIp) continue;
      const single: IpPermission = {
        IpProtocol: permission.IpProtocol,
        FromPort: permission.FromPort,
        ToPort: permission.ToPort,
        IpRanges: [{ CidrIp: range.CidrIp }],
      };
      entries.set(ruleKey(single, range.CidrIp, undefined), single);
    }
    for (const pair of permission.UserIdGroupPairs ?? []) {
      if (!pair.GroupId) continue;
      const single: IpPermission = {
        IpProtocol: permission.IpProtocol,
        FromPort: permission.FromPort,
        ToPort: permission.ToPort,
        UserIdGroupPairs: [{ GroupId: pair.GroupId }],
      };
      entries.set(ruleKey(single, undefined, pair.GroupId), single);
    }
  }
  return entries;
}

/**
 * Diffs the live rule set (from a `DescribeSecurityGroupsCommand` read) against
 * the desired rule list. Diffing is by full tuple, not a partial key — see
 * `ruleKey`. Rules present live but not desired become `toRevoke`; rules
 * desired but not live become `toAdd`.
 */
export function diffRules(live: IpPermission[], desired: DesiredRule[]): RuleDiff {
  const liveEntries = expandLive(live);

  const desiredEntries = new Map<string, IpPermission>();
  for (const rule of desired) {
    const permission = toIpPermission(rule);
    desiredEntries.set(ruleKey(permission, rule.cidr, rule.sourceGroupId), permission);
  }

  const toRevoke: IpPermission[] = [];
  for (const [key, permission] of liveEntries) {
    if (!desiredEntries.has(key)) toRevoke.push(permission);
  }

  const toAdd: IpPermission[] = [];
  for (const [key, permission] of desiredEntries) {
    if (!liveEntries.has(key)) toAdd.push(permission);
  }

  return { toRevoke, toAdd };
}

function isDuplicatePermission(err: unknown): boolean {
  return (err as { name?: string })?.name === "InvalidPermission.Duplicate";
}

/**
 * Applies a rule diff to a security group: revokes `toRevoke` (batched, one
 * call with an array), then authorizes `toAdd` (batched), catching and
 * ignoring `InvalidPermission.Duplicate` on the authorize calls (a race with
 * a concurrent manual change, or a rule already present from an interrupted
 * prior reconcile).
 */
export async function applyRuleDiff(
  ec2: EC2Client,
  groupId: string,
  direction: Direction,
  diff: RuleDiff,
): Promise<void> {
  if (diff.toRevoke.length > 0) {
    if (direction === "ingress") {
      await ec2.send(
        new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: diff.toRevoke }),
      );
    } else {
      await ec2.send(
        new RevokeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions: diff.toRevoke }),
      );
    }
  }

  if (diff.toAdd.length > 0) {
    try {
      if (direction === "ingress") {
        await ec2.send(
          new AuthorizeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: diff.toAdd }),
        );
      } else {
        await ec2.send(
          new AuthorizeSecurityGroupEgressCommand({ GroupId: groupId, IpPermissions: diff.toAdd }),
        );
      }
    } catch (err) {
      if (!isDuplicatePermission(err)) throw err;
    }
  }
}

/** Reads a security group's live rule sets, or undefined if it doesn't exist. */
export async function describeGroupRules(
  ec2: EC2Client,
  groupId: string,
): Promise<{ ingress: IpPermission[]; egress: IpPermission[] } | undefined> {
  const described = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
  const group = described.SecurityGroups?.[0];
  if (!group) return undefined;
  return { ingress: group.IpPermissions ?? [], egress: group.IpPermissionsEgress ?? [] };
}

/** True if the live rule set (expanded to single-tuple entries) set-equals the desired list. */
function rulesMatch(live: IpPermission[], desired: DesiredRule[]): boolean {
  const liveKeys = new Set(expandLive(live).keys());
  const desiredKeys = new Set(
    desired.map((rule) => ruleKey(toIpPermission(rule), rule.cidr, rule.sourceGroupId)),
  );
  if (liveKeys.size !== desiredKeys.size) return false;
  for (const key of desiredKeys) {
    if (!liveKeys.has(key)) return false;
  }
  return true;
}

/**
 * `pollUntil` wrapping a fresh `DescribeSecurityGroupsCommand` read, confirming
 * the live rule set now set-equals the desired set for both directions — the
 * same eventual-consistency guard the plan calls for after every apply.
 */
export async function pollRulesConverged(
  ec2: EC2Client,
  groupId: string,
  desiredIngress: DesiredRule[],
  desiredEgress: DesiredRule[],
): Promise<boolean> {
  return pollUntil(
    async () => {
      const rules = await describeGroupRules(ec2, groupId);
      if (!rules) return false;
      return rulesMatch(rules.ingress, desiredIngress) && rulesMatch(rules.egress, desiredEgress);
    },
    { intervalMs: 3_000, timeoutMs: 30_000, label: `security group ${groupId} rules converging` },
  );
}
