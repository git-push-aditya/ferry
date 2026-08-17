import { ListUserTagsCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import { parsedTags, type Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const desired = parsedTags(ctx.params);
  if (desired === undefined) {
    ctx.log.warn("TAGS_JSON not set this run — nothing to verify");
    return;
  }

  const { iam } = awsClients(ctx);
  const userName = ctx.params.IAM_USER_NAME;

  const actual: Record<string, string> = {};
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListUserTagsCommand({ UserName: userName, Marker: marker }));
    for (const tag of page.Tags ?? []) {
      if (tag.Key) actual[tag.Key] = tag.Value ?? "";
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);

  // Superset check — other keys this run didn't touch are expected to remain
  // (unless pruning was requested, in which case they must be gone).
  const missing = Object.entries(desired).filter(([k, v]) => actual[k] !== v);
  if (missing.length > 0) {
    throw new Error(
      `User ${userName} is missing expected tag(s): ${missing.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }

  if (ctx.params.PRUNE_UNMANAGED_TAGS) {
    const unexpected = Object.keys(actual).filter((k) => !(k in desired));
    if (unexpected.length > 0) {
      throw new Error(
        `PRUNE_UNMANAGED_TAGS was set but unmanaged tag(s) remain on ${userName}: ${unexpected.join(", ")}`,
      );
    }
  }

  ctx.log.success(`Confirmed ${Object.keys(desired).length} tag(s) present on user ${userName}`);
}
