import {
  ListUserTagsCommand,
  TagUserCommand,
  UntagUserCommand,
  type Tag,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients } from "../../../../../../src/providers/aws";
import { parsedTags, type Params } from "../params";

/**
 * Reads every current tag on the user, paginated via Marker/IsTruncated —
 * mirrors `readCurrentTags` in `aws/iam/role/tag-role`.
 */
async function readCurrentTags(
  iam: ReturnType<typeof awsClients>["iam"],
  userName: string,
): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListUserTagsCommand({ UserName: userName, Marker: marker }));
    for (const tag of page.Tags ?? []) {
      if (tag.Key) tags[tag.Key] = tag.Value ?? "";
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return tags;
}

/**
 * TagUser is a merge, not a replace — AWS's own docs: a tag sharing an
 * existing key is overwritten with the new value; keys not mentioned are left
 * alone. So this is inherently always-reconcile (the desired set depends on
 * params, not knowable as a plan-time missing/exists split), same shape as
 * `aws/iam/role/tag-role`'s `tagsStep`.
 *
 * PRUNE_UNMANAGED_TAGS opts into full declarative convergence (removing keys
 * present on the user but absent from TAGS_JSON) — off by default, matching
 * the project's "never silently delete what this run didn't introduce" ethos.
 *
 * The full pre-run tag snapshot is captured for rollback (not just the
 * touched keys) — simplest-and-still-correct, same discipline as
 * `s3BucketPolicyStep` capturing the prior whole document.
 */
export const tagsStep: Step<Params> = {
  id: "user-tags",
  title: "Reconcile user tags",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const userName = ctx.params.IAM_USER_NAME;
    const desired = parsedTags(ctx.params);
    const prune = ctx.params.PRUNE_UNMANAGED_TAGS;

    if (desired === undefined) {
      ctx.log.info("TAGS_JSON not set — leaving the user's tags untouched");
      return {};
    }

    const { iam } = awsClients(ctx);
    const currentTags = await readCurrentTags(iam, userName);

    const toSet = Object.entries(desired).filter(([k, v]) => currentTags[k] !== v);
    const toPrune = prune
      ? Object.keys(currentTags).filter((k) => !(k in desired))
      : [];

    if (toSet.length === 0 && toPrune.length === 0) {
      ctx.log.info(`All ${Object.keys(desired).length} desired tag(s) already match — no-op`);
      return { priorTags: JSON.stringify(currentTags), prunedThisRun: JSON.stringify([]) };
    }

    if (toSet.length > 0) {
      const tags: Tag[] = toSet.map(([Key, Value]) => ({ Key, Value }));
      await iam.send(new TagUserCommand({ UserName: userName, Tags: tags }));
      ctx.log.success(`Set ${tags.length} tag(s) on user ${userName}`);
    }

    if (toPrune.length > 0) {
      await iam.send(new UntagUserCommand({ UserName: userName, TagKeys: toPrune }));
      ctx.log.success(`Pruned ${toPrune.length} unmanaged tag(s) from user ${userName}: ${toPrune.join(", ")}`);
    }

    return {
      priorTags: JSON.stringify(currentTags),
      prunedThisRun: JSON.stringify(toPrune),
    };
  },

  async rollback(ctx) {
    if (ctx.outputs.priorTags === undefined) return; // untouched this run

    const desired = parsedTags(ctx.params);
    if (desired === undefined) return;

    const userName = ctx.params.IAM_USER_NAME;
    const priorTags = JSON.parse(ctx.outputs.priorTags as string) as Record<string, string>;
    const pruned = ctx.outputs.prunedThisRun
      ? (JSON.parse(ctx.outputs.prunedThisRun as string) as string[])
      : [];
    const { iam } = awsClients(ctx);

    // Strip keys this run introduced that did not exist before.
    const introducedKeys = Object.keys(desired).filter((k) => !(k in priorTags));
    if (introducedKeys.length > 0) {
      await iam.send(new UntagUserCommand({ UserName: userName, TagKeys: introducedKeys }));
    }

    // Restore the prior value for keys this run overwrote.
    const overwritten: Tag[] = Object.entries(desired)
      .filter(([k, v]) => k in priorTags && priorTags[k] !== v)
      .map(([k]) => ({ Key: k, Value: priorTags[k] }));
    if (overwritten.length > 0) {
      await iam.send(new TagUserCommand({ UserName: userName, Tags: overwritten }));
    }

    // Restore any keys this run pruned.
    if (pruned.length > 0) {
      const restored: Tag[] = pruned.map((k) => ({ Key: k, Value: priorTags[k] }));
      await iam.send(new TagUserCommand({ UserName: userName, Tags: restored }));
    }
  },

  resource(ctx) {
    const desired = parsedTags(ctx.params);
    return {
      type: "aws_iam_user_tags",
      name: ctx.params.IAM_USER_NAME,
      attributes: {
        user: ctx.params.IAM_USER_NAME,
        tagCount: String(desired ? Object.keys(desired).length : 0),
      },
    };
  },
};
