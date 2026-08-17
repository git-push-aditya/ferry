import {
  CreatePolicyVersionCommand,
  DeletePolicyVersionCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListPolicyVersionsCommand,
  SetDefaultPolicyVersionCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients } from "../../../../../../src/providers/aws";
import { isNoSuchEntity } from "../../../../../../src/providers/aws/iam";
import type { Params } from "../params";

const MFA_PRESENT_KEY = "aws:MultiFactorAuthPresent";
const MFA_AGE_KEY = "aws:MultiFactorAuthAge";

interface Statement {
  Effect?: string;
  Condition?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

interface PolicyDoc {
  Version?: string;
  Statement: Statement[];
  [key: string]: unknown;
}

/** URL-decodes and parses a policy document the way IAM returns it. */
function parseDocument(raw: string): PolicyDoc {
  const doc = JSON.parse(decodeURIComponent(raw)) as PolicyDoc;
  if (!Array.isArray(doc.Statement)) doc.Statement = doc.Statement ? [doc.Statement] : [];
  return doc;
}

/** Does every statement already carry the MFA condition(s) this run wants? */
function alreadyEnforced(doc: PolicyDoc, maxAgeSeconds: number | undefined): boolean {
  return doc.Statement.every((stmt) => {
    const present = stmt.Condition?.Bool?.[MFA_PRESENT_KEY];
    const presentOk = present === "true" || present === true;
    if (!presentOk) return false;
    if (maxAgeSeconds === undefined) return true;
    const age = stmt.Condition?.NumericLessThan?.[MFA_AGE_KEY];
    return String(age) === String(maxAgeSeconds);
  });
}

/**
 * Adds the MFA condition to every statement in the document, rather than
 * carving out a dedicated new statement — simpler to reason about ("every
 * action this policy grants now requires MFA") and avoids duplicating
 * Action/Resource blocks. Documented explicitly here since the plan leaves
 * this as an implementation choice.
 */
function withMfaCondition(doc: PolicyDoc, maxAgeSeconds: number | undefined): PolicyDoc {
  const statements = doc.Statement.map((stmt) => {
    const condition = { ...(stmt.Condition ?? {}) };
    condition.Bool = { ...(condition.Bool ?? {}), [MFA_PRESENT_KEY]: "true" };
    if (maxAgeSeconds !== undefined) {
      condition.NumericLessThan = {
        ...(condition.NumericLessThan ?? {}),
        [MFA_AGE_KEY]: String(maxAgeSeconds),
      };
    }
    return { ...stmt, Condition: condition };
  });
  return { ...doc, Statement: statements };
}

/**
 * Always-reconciles (no create()) — transposed from `s3BucketPolicyStep`'s
 * whole-document-replace shape, but operating on a customer-managed policy's
 * default version rather than a bucket policy. IAM caps a policy at 5
 * versions; at the cap, the oldest non-default version is deleted first to
 * make room.
 */
export const mfaPolicyConditionStep: Step<Params> = {
  id: "mfa-policy-condition",
  title: "Reconcile MFA policy condition",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const policyArn = ctx.params.IAM_POLICY_ARN;
    const maxAgeSeconds = ctx.params.MFA_CONDITION_MAX_AGE_SECONDS;

    const policy = await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }));
    const priorVersionId = policy.Policy?.DefaultVersionId;
    if (!priorVersionId) throw new Error(`Could not read the default version of ${policyArn}`);

    const version = await iam.send(
      new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: priorVersionId }),
    );
    const rawDoc = version.PolicyVersion?.Document;
    if (!rawDoc) throw new Error(`Could not read the policy document of ${policyArn}`);
    const currentDoc = parseDocument(rawDoc);

    if (alreadyEnforced(currentDoc, maxAgeSeconds)) {
      ctx.log.info(`${policyArn} already carries the MFA condition on every statement — no-op`);
      return {};
    }

    // IAM caps a policy at 5 versions. Make room if needed before creating a
    // new one, without ever touching the current default.
    const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
    const all = versions.Versions ?? [];
    if (all.length >= 5) {
      const deletable = all
        .filter((v) => !v.IsDefaultVersion && v.VersionId)
        .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0));
      const oldest = deletable[0];
      if (oldest?.VersionId) {
        await iam.send(
          new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: oldest.VersionId }),
        );
        ctx.log.info(`Deleted oldest non-default policy version ${oldest.VersionId} to make room`);
      }
    }

    const mergedDoc = withMfaCondition(currentDoc, maxAgeSeconds);
    await iam.send(
      new CreatePolicyVersionCommand({
        PolicyArn: policyArn,
        PolicyDocument: JSON.stringify(mergedDoc),
        SetAsDefault: true,
      }),
    );
    ctx.log.success(`Added the MFA condition to every statement of ${policyArn}`);

    return {
      priorPolicyVersionId: priorVersionId,
      priorPolicyDocument: JSON.stringify(currentDoc),
      mfaPolicyChangedThisRun: true,
    };
  },

  async rollback(ctx) {
    const priorVersionId = ctx.outputs.priorPolicyVersionId as string | undefined;
    if (!priorVersionId) return; // untouched this run

    const { iam } = awsClients(ctx);
    const policyArn = ctx.params.IAM_POLICY_ARN;

    try {
      // Cleaner than reconstructing the prior document as a fresh version:
      // just reinstate the version that was default before this run.
      await iam.send(
        new SetDefaultPolicyVersionCommand({ PolicyArn: policyArn, VersionId: priorVersionId }),
      );
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }

    // Delete the version this run created — only safe now that it's no
    // longer the default.
    try {
      const versions = await iam.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
      const nonDefault = (versions.Versions ?? []).filter(
        (v) => !v.IsDefaultVersion && v.VersionId !== priorVersionId,
      );
      for (const v of nonDefault) {
        if (!v.VersionId) continue;
        await iam.send(new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId }));
      }
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_policy_version",
      name: ctx.params.IAM_POLICY_ARN,
      attributes: {
        policyArn: ctx.params.IAM_POLICY_ARN,
        conditionAdded: MFA_PRESENT_KEY,
      },
    };
  },
};
