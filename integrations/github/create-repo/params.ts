import { z } from "zod";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  // "org" posts to /orgs/{OWNER}/repos; "user" posts to /user/repos (the
  // authenticated account) — GitHub has no single "create under this owner"
  // endpoint that works for both account kinds.
  OWNER_TYPE: z.enum(["user", "org"]),

  DESCRIPTION: z.string().optional(),
  VISIBILITY: z.enum(["public", "private"]).optional(),

  // Defaults true: several downstream tasks (branch-protection) 404 against
  // a fully-empty repo with no default branch yet, so a bare `create-repo`
  // run should leave a repo those tasks can immediately compose with.
  AUTO_INIT: boolFlag("true"),
  GITIGNORE_TEMPLATE: z.string().optional(),
  LICENSE_TEMPLATE: z.string().optional(),

  // Hard human-confirmation gate: rollback normally deletes what create()
  // made, but a repo can accumulate commits/issues/PRs between creation and
  // rollback that a delete would destroy for good. Defaults false so a .env
  // copied without reading it cannot silently destroy repo contents.
  ALLOW_DESTRUCTIVE_ROLLBACK: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
