import {
  ListRoleTagsCommand,
  TagRoleCommand,
  UntagRoleCommand,
  type Tag,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients } from "../../../../../../src/providers/aws";
import { parsedTags, type Params } from "../params";

/**
 * Reads every current tag on the role, paginated via Marker/IsTruncated —
 * mirrors `listAttachedRolePolicyArns` in src/providers/aws/iam.ts.
 */
async function readCurrentTags(
  iam: ReturnType<typeof awsClients>["iam"],
  roleName: string,
): Promise<Record<string, string>> {
  const tags: Record<string, string> = {};
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListRoleTagsCommand({ RoleName: roleName, Marker: marker }));
    for (const tag of page.Tags ?? []) {
      if (tag.Key) tags[tag.Key] = tag.Value ?? "";
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return tags;
}

/**
 * TagRole is a merge, not a replace — AWS's own docs: "if a tag with the same
 * key name already exists, then that tag is overwritten with the new value";
 * existing keys not mentioned are left alone. So the prior full tag set is
 * captured for rollback (not just the changed keys), same shape as
 * `aws/s3/tag-bucket`'s `tagsStep`, transposed from Get/PutBucketTagging to
 * List/TagRole.
 *
 * Always reconciles (no create()): the desired set depends on params, not
 * knowable as a plan-time missing/exists split.
 */
export const tagsStep: Step<Params> = {
  id: "role-tags",
  title: "Reconcile role tags",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const roleName = ctx.params.ROLE_NAME;
    const desired = parsedTags(ctx.params);

    if (desired === undefined) {
      ctx.log.info("TAGS_JSON not set — leaving the role's tags untouched");
      return {};
    }

    const { iam } = awsClients(ctx);
    const currentTags = await readCurrentTags(iam, roleName);

    const changed = Object.entries(desired).some(([k, v]) => currentTags[k] !== v);
    if (!changed) {
      ctx.log.info(`All ${Object.keys(desired).length} desired tag(s) already match — no-op`);
      return { priorTags: JSON.stringify(currentTags) };
    }

    const tags: Tag[] = Object.entries(desired).map(([Key, Value]) => ({ Key, Value }));
    await iam.send(new TagRoleCommand({ RoleName: roleName, Tags: tags }));
    ctx.log.success(`Set ${tags.length} tag(s) on role ${roleName}`);

    return { priorTags: JSON.stringify(currentTags) };
  },

  async rollback(ctx) {
    if (ctx.outputs.priorTags === undefined) return; // untouched this run

    const desired = parsedTags(ctx.params);
    if (desired === undefined) return;

    const roleName = ctx.params.ROLE_NAME;
    const priorTags = JSON.parse(ctx.outputs.priorTags as string) as Record<string, string>;
    const { iam } = awsClients(ctx);

    // Strip keys this run introduced that did not exist before.
    const introducedKeys = Object.keys(desired).filter((k) => !(k in priorTags));
    if (introducedKeys.length > 0) {
      await iam.send(new UntagRoleCommand({ RoleName: roleName, TagKeys: introducedKeys }));
    }

    // Restore the prior value for keys this run overwrote.
    const overwritten: Tag[] = Object.entries(desired)
      .filter(([k, v]) => k in priorTags && priorTags[k] !== v)
      .map(([k]) => ({ Key: k, Value: priorTags[k] }));
    if (overwritten.length > 0) {
      await iam.send(new TagRoleCommand({ RoleName: roleName, Tags: overwritten }));
    }
  },

  resource(ctx) {
    const desired = parsedTags(ctx.params);
    return {
      type: "aws_iam_role_tags",
      name: ctx.params.ROLE_NAME,
      attributes: {
        role: ctx.params.ROLE_NAME,
        tagCount: String(desired ? Object.keys(desired).length : 0),
      },
    };
  },
};
