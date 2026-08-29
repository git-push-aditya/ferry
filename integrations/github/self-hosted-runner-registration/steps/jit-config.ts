import type { Step } from "../../../../src/core/define";
import {
  deleteRunner,
  findRunnerByName,
  generateJitConfig,
  githubClients,
  runnerScopeLabel,
} from "../../../../src/providers/github";
import { runnerScope, type Params } from "../params";

/**
 * Registers the runner with GitHub and captures its JIT config.
 *
 * **`check()` must never call `generate-jitconfig`.** That endpoint is
 * mutating and single-use -- it registers a runner as a side effect and
 * returns a credential that cannot be reissued. The engine treats `check()`
 * as a safe, repeatable read and calls it during `--dry-run`, so calling it
 * there would register a real runner during a plan. `check()` lists runners
 * and matches on RUNNER_NAME instead.
 *
 * **No `reconcile()`, deliberately.** A JIT config, once issued, cannot be
 * reissued for an already-registered runner, so drift correction here is
 * structurally terminate-and-recreate, not document-replace. This does not
 * attempt that automatically: deregister the runner and re-run, the same
 * human-gated honesty as rotate-user-key-pair's cutover.
 */
export const jitConfigStep: Step<Params> = {
  id: "runner-registration",
  title: "Register the runner and generate its JIT config",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const scope = runnerScope(ctx.params);
    const existing = await findRunnerByName(rest, scope, ctx.params.RUNNER_NAME);

    if (existing) {
      ctx.log.info(
        `Runner "${ctx.params.RUNNER_NAME}" is already registered on ` +
          `${runnerScopeLabel(scope)} (id ${existing.id}, status ${existing.status})`,
      );
      return "exists";
    }
    return "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const scope = runnerScope(ctx.params);

    const jit = await generateJitConfig(rest, scope, {
      name: ctx.params.RUNNER_NAME,
      runnerGroupId: ctx.params.RUNNER_GROUP_ID,
      labels: ctx.params.RUNNER_LABELS,
    });

    // Captured immediately: this id is the only handle we will ever have for
    // deregistering this runner, and it is not recoverable from anywhere else.
    ctx.log.success(
      `Registered runner "${ctx.params.RUNNER_NAME}" on ${runnerScopeLabel(scope)} (id ${jit.runner.id})`,
    );

    return {
      runnerId: jit.runner.id,
      // Never logged and never written to resource() or the report -- it is a
      // live credential for the runner's lifetime.
      runnerJitConfig: jit.encodedJitConfig,
    };
  },

  async rollback(ctx) {
    const runnerId = ctx.outputs.runnerId as number | undefined;
    if (runnerId === undefined) return;

    const { rest } = githubClients(ctx);
    await deleteRunner(rest, runnerScope(ctx.params), runnerId);
    ctx.log.warn(`Rolled back — deregistered runner ${runnerId}`);
  },

  resource(ctx) {
    const scope = runnerScope(ctx.params);
    return {
      type: "github_self_hosted_runner",
      name: `${runnerScopeLabel(scope)}:${ctx.params.RUNNER_NAME}`,
      attributes: {
        scope: ctx.params.SCOPE,
        target: runnerScopeLabel(scope),
        runnerName: ctx.params.RUNNER_NAME,
        runnerId: String(ctx.outputs.runnerId ?? ""),
        labels: ctx.params.RUNNER_LABELS.join(","),
      },
    };
  },
};
