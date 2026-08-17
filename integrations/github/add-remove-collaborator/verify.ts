import type { StepContext } from "../../../src/core/define";
import { collaboratorState, githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, USERNAME, ACTION } = ctx.params;

  const state = await collaboratorState(rest, OWNER, REPO, USERNAME);
  const isMember = state === "member";

  if (ACTION === "add" && !isMember) {
    throw new Error(`${USERNAME} is still not a direct collaborator on ${OWNER}/${REPO} after add`);
  }
  if (ACTION === "remove" && isMember) {
    throw new Error(`${USERNAME} is still a direct collaborator on ${OWNER}/${REPO} after remove`);
  }

  ctx.log.success(`Confirmed ${USERNAME}'s collaborator status on ${OWNER}/${REPO} matches ACTION=${ACTION}`);
}
