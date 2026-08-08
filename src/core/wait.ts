import { info, warn } from "./logger";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  label: string;
}

/**
 * Polls checkFn until it resolves true, or timeoutMs elapses. Used for AWS
 * eventual-consistency waits — confirms a read-your-write is actually visible
 * instead of guessing a fixed sleep. Gives up and proceeds (with a warning,
 * not a throw) if the timeout is hit, since the caller's own retry logic is
 * the final safety net.
 */
export async function pollUntil(checkFn: () => Promise<boolean>, opts: PollOptions): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await checkFn()) {
      info(`${opts.label}: confirmed`);
      return true;
    }
    if (Date.now() - start >= opts.timeoutMs) {
      warn(`${opts.label}: not confirmed after ${opts.timeoutMs / 1000}s — proceeding anyway`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}
