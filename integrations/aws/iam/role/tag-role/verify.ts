import { ListRoleTagsCommand } from "@aws-sdk/client-iam";
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
  const roleName = ctx.params.ROLE_NAME;

  const actual: Record<string, string> = {};
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListRoleTagsCommand({ RoleName: roleName, Marker: marker }));
    for (const tag of page.Tags ?? []) {
      if (tag.Key) actual[tag.Key] = tag.Value ?? "";
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);

  // Superset check — other keys this run didn't touch are expected to remain.
  const missing = Object.entries(desired).filter(([k, v]) => actual[k] !== v);
  if (missing.length > 0) {
    throw new Error(
      `Role ${roleName} is missing expected tag(s): ${missing.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }
  ctx.log.success(`Confirmed ${Object.keys(desired).length} tag(s) present on role ${roleName}`);
}
