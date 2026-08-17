import type { StepContext } from "../../../src/core/define";
import { githubClients, repoState } from "../../../src/providers/github";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const state = await repoState(rest, ctx.params.OWNER, ctx.params.REPO);
  if (state !== "missing") {
    throw new Error(`"${ctx.params.OWNER}/${ctx.params.REPO}" still exists after delete-repo ran`);
  }
  ctx.log.success(`Confirmed "${ctx.params.OWNER}/${ctx.params.REPO}" no longer exists`);
}
