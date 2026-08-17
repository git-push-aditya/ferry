import type { StepContext } from "../../../src/core/define";
import { githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

interface RepoRead {
  private?: boolean;
  visibility?: string;
}

/** GitHub's repo-create is synchronous (unlike IAM's eventual-consistency reads), so a single read-back suffices. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, VISIBILITY } = ctx.params;

  const res = await rest.request<RepoRead>("GET", `/repos/${OWNER}/${REPO}`);

  if (VISIBILITY && res.data.visibility && res.data.visibility !== VISIBILITY) {
    throw new Error(
      `Repo "${OWNER}/${REPO}" visibility is "${res.data.visibility}", expected "${VISIBILITY}"`,
    );
  }
  if (VISIBILITY === "private" && res.data.private !== true) {
    throw new Error(`Repo "${OWNER}/${REPO}" is not private as requested`);
  }
  if (VISIBILITY === "public" && res.data.private !== false) {
    throw new Error(`Repo "${OWNER}/${REPO}" is not public as requested`);
  }

  ctx.log.success(`Confirmed "${OWNER}/${REPO}" exists with the requested visibility`);
}
