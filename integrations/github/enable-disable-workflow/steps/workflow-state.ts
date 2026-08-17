import type { Step } from "../../../../src/core/define";
import { githubClients } from "../../../../src/providers/github";
import type { Params } from "../params";

interface WorkflowRead {
  state?: string;
}

async function readState(
  clients: ReturnType<typeof githubClients>,
  owner: string,
  repo: string,
  workflowId: string,
): Promise<string | undefined> {
  const path = `/repos/${owner}/${repo}/actions/workflows/${workflowId}`;
  const res = await clients.rest.raw<WorkflowRead>("GET", path);
  if (res.status === 404) return undefined;
  if (res.status !== 200) throw new Error(`Failed to read workflow ${workflowId} on ${owner}/${repo}: HTTP ${res.status}`);
  return res.data.state;
}

/**
 * Create-or-skip toggle, same shape as aws/ec2/stop-start-instance /
 * iamAccessKeyStatusStep. Never creates a workflow file — that's a git-
 * commit operation, out of scope for this task (same "doesn't reach across
 * into a different concern" discipline as attach-detach-ebs-volume
 * declining to auto-stop an instance). A bad id/path 404s -> "conflict".
 */
export const workflowStateStep: Step<Params> = {
  id: "workflow-state",
  title: "Enable or disable a workflow",

  async check(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, WORKFLOW_ID, ACTION } = ctx.params;

    const state = await readState(clients, OWNER, REPO, WORKFLOW_ID);
    if (state === undefined) {
      ctx.log.warn(
        `Workflow "${WORKFLOW_ID}" not found on ${OWNER}/${REPO} — this task never creates a workflow ` +
          `file (that's a git-commit operation, out of scope here).`,
      );
      return "conflict";
    }

    if (ACTION === "enable") return state === "active" ? "exists" : "missing";
    return state === "disabled_manually" ? "exists" : state === "active" ? "missing" : "exists";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, WORKFLOW_ID, ACTION } = ctx.params;
    await rest.request(
      "PUT",
      `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_ID}/${ACTION}`,
      { okStatuses: [204] },
    );
    ctx.log.success(`Workflow "${WORKFLOW_ID}" on ${OWNER}/${REPO} set to ${ACTION}d`);
    return { workflowToggledThisRun: true };
  },

  /** Reverses the toggle — same reversible-toggle shape as stop-start-instance/iamAccessKeyStatusStep. */
  async rollback(ctx) {
    if (ctx.outputs.workflowToggledThisRun !== true) return;
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, WORKFLOW_ID, ACTION } = ctx.params;
    const reverse = ACTION === "enable" ? "disable" : "enable";
    await rest.request("PUT", `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_ID}/${reverse}`, {
      okStatuses: [204],
    });
  },

  resource(ctx) {
    const { OWNER, REPO, WORKFLOW_ID, ACTION } = ctx.params;
    return {
      type: "github_workflow",
      name: `${OWNER}/${REPO}:${WORKFLOW_ID}`,
      attributes: { owner: OWNER, repo: REPO, workflowId: WORKFLOW_ID, state: ACTION === "enable" ? "active" : "disabled_manually" },
    };
  },
};
