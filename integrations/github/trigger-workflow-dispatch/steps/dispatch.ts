import type { Step, StepOutputs } from "../../../../src/core/define";
import { pollUntil } from "../../../../src/core/wait";
import { githubClients } from "../../../../src/providers/github";
import type { Params } from "../params";

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
}

async function findCorrelatedRun(
  clients: ReturnType<typeof githubClients>,
  owner: string,
  repo: string,
  workflowId: string,
  dispatchedAtMs: number,
): Promise<WorkflowRun | undefined> {
  const res = await clients.rest.request<{ workflow_runs: WorkflowRun[] }>(
    "GET",
    `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=10`,
  );
  // A small buffer before dispatchedAtMs tolerates clock skew between this
  // process and GitHub's own run-creation timestamps.
  const candidates = res.data.workflow_runs
    .filter((r) => new Date(r.created_at).getTime() >= dispatchedAtMs - 5_000)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return candidates[0];
}

/**
 * Read-only action-trigger, not a state convergence — closest analogue in
 * this project is audit-unused-roles: check() always returns "missing"
 * (every invocation is a fresh dispatch; workflow_dispatch events aren't
 * idempotent or deduplicated by GitHub in any way this API exposes).
 *
 * The dispatch call itself returns 204 with no run id — GitHub gives no
 * synchronous confirmation of which run it triggered — so this polls the
 * runs list for a best-effort correlation by timestamp, a real limitation
 * (a second, unrelated dispatch racing this one within the same poll window
 * could be ambiguous), not a shortcut this task is taking.
 */
export const dispatchStep: Step<Params> = {
  id: "workflow-dispatch",
  title: "Dispatch a workflow_dispatch event",

  async check() {
    return "missing";
  },

  async create(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, WORKFLOW_ID, REF, INPUTS_JSON, WAIT_FOR_COMPLETION, POLL_TIMEOUT_MS, EXPECTED_CONCLUSION } =
      ctx.params;

    const dispatchedAtMs = Date.now();
    await clients.rest.request(
      "POST",
      `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`,
      { body: { ref: REF, inputs: INPUTS_JSON }, okStatuses: [204] },
    );
    ctx.log.success(`Dispatched workflow "${WORKFLOW_ID}" on ${OWNER}/${REPO}@${REF}`);

    let correlatedRunId: number | undefined;
    await pollUntil(
      async () => {
        const run = await findCorrelatedRun(clients, OWNER, REPO, WORKFLOW_ID, dispatchedAtMs);
        if (!run) return false;
        correlatedRunId = run.id;
        return true;
      },
      { intervalMs: 2_000, timeoutMs: 20_000, label: "Correlating the dispatched run" },
    );

    const outputs: StepOutputs = {
      workflowDispatchedThisRun: true,
      correlatedRunId: correlatedRunId ?? null,
    };
    if (correlatedRunId === undefined) {
      ctx.log.warn("Could not correlate a run to this dispatch within the poll window — best-effort only");
      return outputs;
    }

    if (WAIT_FOR_COMPLETION) {
      let conclusion: string | null = null;
      const completed = await pollUntil(
        async () => {
          const res = await clients.rest.request<{ status: string; conclusion: string | null }>(
            "GET",
            `/repos/${OWNER}/${REPO}/actions/runs/${correlatedRunId}`,
          );
          conclusion = res.data.conclusion;
          return res.data.status === "completed";
        },
        { intervalMs: 5_000, timeoutMs: POLL_TIMEOUT_MS, label: `Run ${correlatedRunId} completion` },
      );

      if (!completed) {
        throw new Error(`Run ${correlatedRunId} did not complete within ${POLL_TIMEOUT_MS}ms`);
      }
      if (conclusion !== EXPECTED_CONCLUSION) {
        throw new Error(`Run ${correlatedRunId} concluded "${conclusion}", expected "${EXPECTED_CONCLUSION}"`);
      }
      outputs.runConclusion = conclusion;
    }

    return outputs;
  },

  /**
   * A workflow run, once dispatched, cannot be un-dispatched — the best this
   * can do is cancel it if it's still in-flight, which is a real action but
   * not an undo, same honesty class as terminate-instance.
   */
  async rollback(ctx) {
    const correlatedRunId = ctx.outputs.correlatedRunId as number | null | undefined;
    if (correlatedRunId === undefined || correlatedRunId === null) return;

    const { rest } = githubClients(ctx);
    const { OWNER, REPO } = ctx.params;
    const res = await rest.raw("POST", `/repos/${OWNER}/${REPO}/actions/runs/${correlatedRunId}/cancel`);
    if (res.status === 202) {
      ctx.log.warn(`Cancelled in-flight run ${correlatedRunId} — this is a cancellation, not an undo.`);
    } else {
      ctx.log.warn(
        `Run ${correlatedRunId} was already finished or could not be cancelled (HTTP ${res.status}) — ` +
          `a dispatched workflow run cannot be un-dispatched.`,
      );
    }
  },

  resource(ctx) {
    const { OWNER, REPO, WORKFLOW_ID, REF } = ctx.params;
    return {
      type: "github_workflow_dispatch",
      name: `${OWNER}/${REPO}:${WORKFLOW_ID}@${REF}`,
      attributes: {
        owner: OWNER,
        repo: REPO,
        workflowId: WORKFLOW_ID,
        ref: REF,
        correlatedRunId: String(ctx.outputs.correlatedRunId ?? ""),
      },
    };
  },
};
