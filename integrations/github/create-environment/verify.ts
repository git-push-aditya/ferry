import type { StepContext } from "../../../src/core/define";
import { githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

interface EnvironmentRead {
  wait_timer?: number;
  reviewers?: unknown[];
}

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, ENVIRONMENT_NAME, WAIT_TIMER, REVIEWERS } = ctx.params;

  const res = await rest.request<EnvironmentRead>("GET", `/repos/${OWNER}/${REPO}/environments/${ENVIRONMENT_NAME}`);
  if ((res.data.wait_timer ?? 0) !== WAIT_TIMER) {
    throw new Error(`Environment "${ENVIRONMENT_NAME}" wait_timer is ${res.data.wait_timer}, expected ${WAIT_TIMER}`);
  }
  if ((res.data.reviewers ?? []).length !== REVIEWERS.length) {
    throw new Error(`Environment "${ENVIRONMENT_NAME}" reviewer count does not match requested`);
  }

  ctx.log.success(`Confirmed environment "${ENVIRONMENT_NAME}" on ${OWNER}/${REPO} matches requested settings`);
}
