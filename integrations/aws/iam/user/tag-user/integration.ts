import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { iamUserExistsGuardStep } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { tagsStep } from "./steps/tags";
import { verify } from "./verify";

/**
 * Sets an IAM user's tags on a user that already exists. Does not create the
 * user; run `aws/iam/user/create-user` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/iam/user/tag-user",
  schemaVersion: 1,
  summary: "Sets an existing IAM user's tags to an exact desired set, proven with a live read-back.",

  // .default("")/.default("false") make the .env-facing inputs optional even
  // though the parsed outputs are always defined — same ZodEffects shape
  // tag-role and create-bucket's boolean flags hit.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [iamUserExistsGuardStep<Params>({ userName: (p) => p.IAM_USER_NAME }), tagsStep],

  verify,

  reportName: (ctx) => ctx.params.IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# User Tags — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/tag-user\`.

## Setting

- User: \`${p.IAM_USER_NAME}\`
- Tags: ${p.TAGS_JSON ? `\`${p.TAGS_JSON}\`` : "not managed by ferry"}
- Prune unmanaged tags: \`${p.PRUNE_UNMANAGED_TAGS}\`

## Verification

Verified — read the user's tags back and confirmed every desired tag is
present${p.PRUNE_UNMANAGED_TAGS ? ", and that unmanaged tags are gone" : ""}.
`;
  },
});
