import type { StepContext } from "../../../src/core/define";
import { githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

/**
 * If WAIT_FOR_COMPLETION=true, re-confirms the correlated run's conclusion
 * live. If false, verify can only confirm the dispatch call itself
 * succeeded (already true by the time create() returned) — it cannot
 * confirm the run succeeded, or ran at all, since GitHub gives no
 * synchronous confirmation of run creation.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { OWNER, REPO, WAIT_FOR_COMPLETION, EXPECTED_CONCLUSION } = ctx.params;
  const correlatedRunId = ctx.outputs.correlatedRunId as number | null | undefined;

  if (!WAIT_FOR_COMPLETION) {
    ctx.log.success(
      `Dispatch call confirmed accepted for ${OWNER}/${REPO} — WAIT_FOR_COMPLETION=false, so run outcome is unverified`,
    );
    return;
  }

  if (correlatedRunId === undefined || correlatedRunId === null) {
    throw new Error("WAIT_FOR_COMPLETION=true but no run was correlated to this dispatch");
  }

  const { rest } = githubClients(ctx);
  const res = await rest.request<{ status: string; conclusion: string | null }>(
    "GET",
    `/repos/${OWNER}/${REPO}/actions/runs/${correlatedRunId}`,
  );
  if (res.data.conclusion !== EXPECTED_CONCLUSION) {
    throw new Error(`Run ${correlatedRunId} concluded "${res.data.conclusion}", expected "${EXPECTED_CONCLUSION}"`);
  }

  ctx.log.success(`Confirmed run ${correlatedRunId} concluded "${EXPECTED_CONCLUSION}"`);
}
