import type { Logger } from "./logger";
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

export interface RetryOptions {
  /** Delay before each retry, in order. Length is also the max retry count. */
  backoffsMs: number[];
  label: string;
  /** Only errors this returns true for are retried; anything else throws immediately. */
  retryable(err: unknown): boolean;
  log?: Pick<Logger, "warn">;
}

/**
 * Retries `attempt` while `retryable(err)` holds, sleeping `backoffsMs[i]`
 * between tries. For AWS eventual-consistency: a freshly attached policy or a
 * freshly minted access key both read as "denied" for a few seconds, so the
 * first live call through them needs to ride that out — but a genuine
 * permission error must still fail on the first try, which is what
 * `retryable` gates on.
 *
 * This is the third occurrence of this exact shape (create-backend-s3-user's
 * verify.ts had its own copy first), promoted here per the project's own rule
 * of thumb: two bespoke copies are fine, a third gets promoted.
 */
export async function retryWithBackoff<T>(
  attempt: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  for (let i = 0; i <= opts.backoffsMs.length; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!opts.retryable(err) || i === opts.backoffsMs.length) throw err;
      (opts.log ?? { warn }).warn(
        `${opts.label} failed (attempt ${i + 1}), retrying in ${opts.backoffsMs[i]}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, opts.backoffsMs[i]!));
    }
  }
  throw new Error("unreachable");
}
