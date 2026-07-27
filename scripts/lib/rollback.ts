import { info, warn, error as logError } from "./logger";

export interface RollbackStack {
  actions: { label: string; undo: () => Promise<void> }[];
  /** Set once the run has succeeded — a late signal must not undo a good run. */
  disarmed: boolean;
  /** Guards against a signal firing rollback while it is already unwinding. */
  running: boolean;
}

export function createRollbackStack(): RollbackStack {
  return { actions: [], disarmed: false, running: false };
}

/** Registers cleanup for a resource actually created this run. Do not call for resources that already existed. */
export function registerRollback(
  stack: RollbackStack,
  label: string,
  undo: () => Promise<void>,
): void {
  stack.actions.push({ label, undo });
}

/** Marks the run successful so nothing is torn down afterwards. */
export function disarmRollback(stack: RollbackStack): void {
  stack.disarmed = true;
}

/**
 * Best-effort cleanup: undoes every registered action in reverse (LIFO) order
 * so dependent resources (e.g. a role's policy attachment) unwind before the
 * resource they depend on. One action failing does not stop the rest from
 * being attempted — a stuck resource shouldn't block cleanup of everything else.
 */
export async function runRollback(stack: RollbackStack): Promise<void> {
  if (stack.disarmed || stack.running) return;
  stack.running = true;
  if (!stack.actions.length) return;

  warn(`Rolling back ${stack.actions.length} resource(s) created this run...`);
  const failures: string[] = [];
  for (const { label, undo } of [...stack.actions].reverse()) {
    try {
      await undo();
      info(`Rolled back: ${label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Rollback FAILED for ${label}: ${message} — manual cleanup required`);
      failures.push(label);
    }
  }
  if (failures.length) {
    logError(`Rollback incomplete — manually check: ${failures.join(", ")}`);
  } else {
    info("Rollback complete — no resources from this run were left behind");
  }
}

/**
 * Rolls back on Ctrl-C / SIGTERM. Without this, interrupting the script during
 * one of the IAM propagation waits would strand every resource created so far.
 */
export function installRollbackSignalHandlers(stack: RollbackStack): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        warn(`Received ${signal} — rolling back before exiting`);
        await runRollback(stack);
        process.exit(130);
      })();
    });
  }
}
