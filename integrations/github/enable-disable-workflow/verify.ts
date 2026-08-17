import type { StepContext } from "../../../src/core/define";
import { githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

interface WorkflowRead {
  state?: string;
}

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, WORKFLOW_ID, ACTION } = ctx.params;

  const res = await rest.request<WorkflowRead>("GET", `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_ID}`);
  const expected = ACTION === "enable" ? "active" : "disabled_manually";
  if (res.data.state !== expected) {
    throw new Error(`Workflow "${WORKFLOW_ID}" state is "${res.data.state}", expected "${expected}"`);
  }

  ctx.log.success(`Confirmed workflow "${WORKFLOW_ID}" on ${OWNER}/${REPO} is ${expected}`);
}
