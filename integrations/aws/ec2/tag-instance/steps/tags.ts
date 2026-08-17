import type { Step } from "../../../../../src/core/define";
import {
  applyResourceTags,
  awsClients,
  describeInstance,
  describeResourceTags,
  removeResourceTags,
} from "../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Always-reconcile, self-idempotent — the closest analogue in this repo to
 * s3VersioningStep's "whole-document-replace API" pattern, since CreateTags /
 * DeleteTags collectively let this step PUT the desired tag set directly
 * rather than diffing add/remove the way security-group rules require.
 *
 * This integration never creates the instance itself — "conflict" (not
 * "missing") is reported when it doesn't exist, since there's nothing to tag.
 */
export const tagsStep: Step<Params> = {
  id: "instance-tags",
  title: "Reconcile instance tags",

  async check(ctx) {
    const { ec2 } = awsClients(ctx);
    const instance = await describeInstance(ec2, ctx.params.INSTANCE_ID);
    return instance ? "exists" : "conflict";
  },

  async reconcile(ctx) {
    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;
    const desired = ctx.params.TAGS;
    const prune = ctx.params.PRUNE_UNMANAGED_TAGS;

    const current = await describeResourceTags(ec2, instanceId);

    const toApply: Record<string, string> = {};
    const priorValues: Record<string, string | null> = {};

    for (const [key, value] of Object.entries(desired)) {
      if (current[key] !== value) {
        toApply[key] = value;
        priorValues[key] = key in current ? current[key]! : null;
      }
    }

    const toRemove: string[] = [];
    if (prune) {
      for (const key of Object.keys(current)) {
        if (!(key in desired)) {
          toRemove.push(key);
          priorValues[key] = current[key]!;
        }
      }
    }

    if (Object.keys(toApply).length > 0) {
      await applyResourceTags(ec2, instanceId, toApply);
      ctx.log.success(`Applied ${Object.keys(toApply).length} tag(s) on ${instanceId}`);
    }
    if (toRemove.length > 0) {
      await removeResourceTags(ec2, instanceId, toRemove);
      ctx.log.success(`Removed ${toRemove.length} unmanaged tag(s) on ${instanceId}`);
    }
    if (Object.keys(toApply).length === 0 && toRemove.length === 0) {
      ctx.log.info(`${instanceId} already matches the desired tag set — nothing to do`);
    }

    return {
      touchedKeysJson: JSON.stringify(Object.keys(priorValues)),
      priorValuesJson: JSON.stringify(priorValues),
      removedKeysJson: JSON.stringify(toRemove),
    };
  },

  async rollback(ctx) {
    const touchedKeysJson = ctx.outputs.touchedKeysJson as string | undefined;
    if (!touchedKeysJson) return; // untouched this run

    const { ec2 } = awsClients(ctx);
    const instanceId = ctx.params.INSTANCE_ID;
    const touchedKeys = JSON.parse(touchedKeysJson) as string[];
    const priorValues = JSON.parse(ctx.outputs.priorValuesJson as string) as Record<
      string,
      string | null
    >;

    const toRestore: Record<string, string> = {};
    const toDelete: string[] = [];
    for (const key of touchedKeys) {
      const prior = priorValues[key];
      if (prior === null) {
        toDelete.push(key); // this run added a key that didn't exist before
      } else {
        toRestore[key] = prior; // this run changed or removed an existing key
      }
    }

    if (Object.keys(toRestore).length > 0) await applyResourceTags(ec2, instanceId, toRestore);
    if (toDelete.length > 0) await removeResourceTags(ec2, instanceId, toDelete);
    ctx.log.warn(`Rolled back tags on ${instanceId}`);
  },

  resource(ctx) {
    return {
      type: "aws_ec2_instance_tags",
      name: ctx.params.INSTANCE_ID,
      attributes: {
        instanceId: ctx.params.INSTANCE_ID,
        tagCount: String(Object.keys(ctx.params.TAGS).length),
      },
    };
  },
};
