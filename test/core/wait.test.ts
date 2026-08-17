import { describe, expect, mock, test } from "bun:test";
import { pollUntil, retryWithBackoff } from "../../src/core/wait";

const FAST = { intervalMs: 5, timeoutMs: 200, label: "thing" };

describe("pollUntil", () => {
  test("returns true immediately when the first check already passes", async () => {
    const checkFn = mock(async () => true);

    expect(await pollUntil(checkFn, FAST)).toBe(true);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  test("keeps polling until the check flips to true", async () => {
    let calls = 0;
    const checkFn = async () => {
      calls += 1;
      return calls >= 3;
    };

    expect(await pollUntil(checkFn, FAST)).toBe(true);
    expect(calls).toBe(3);
  });

  test("gives up and returns false once the timeout elapses", async () => {
    const checkFn = mock(async () => false);

    expect(await pollUntil(checkFn, { intervalMs: 5, timeoutMs: 30, label: "never" })).toBe(false);
  });

  test("does not throw on timeout — the caller's own retry is the safety net", async () => {
    await expect(
      pollUntil(async () => false, { intervalMs: 5, timeoutMs: 20, label: "never" }),
    ).resolves.toBe(false);
  });

  test("propagates a checkFn rejection instead of treating it as 'not ready'", async () => {
    const checkFn = async () => {
      throw new Error("AccessDenied");
    };

    await expect(pollUntil(checkFn, FAST)).rejects.toThrow("AccessDenied");
  });
});

describe("retryWithBackoff", () => {
  const NO_LOG = { warn() {} };

  test("returns the first successful attempt without retrying", async () => {
    const attempt = mock(async () => "ok");

    expect(
      await retryWithBackoff(attempt, {
        backoffsMs: [1, 2, 3],
        label: "thing",
        retryable: () => true,
        log: NO_LOG,
      }),
    ).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("retries a retryable error until it succeeds", async () => {
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      if (calls < 3) throw new Error("NotYetActive");
      return "ok";
    };

    expect(
      await retryWithBackoff(attempt, {
        backoffsMs: [1, 1, 1],
        label: "thing",
        retryable: () => true,
        log: NO_LOG,
      }),
    ).toBe("ok");
    expect(calls).toBe(3);
  });

  test("throws immediately on a non-retryable error, without waiting out any backoff", async () => {
    const attempt = mock(async () => {
      throw new Error("AccessDenied — genuinely not allowed");
    });

    await expect(
      retryWithBackoff(attempt, {
        backoffsMs: [1, 1, 1],
        label: "thing",
        retryable: () => false,
        log: NO_LOG,
      }),
    ).rejects.toThrow("AccessDenied");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("gives up and throws once every backoff is exhausted", async () => {
    const attempt = mock(async () => {
      throw new Error("still not active");
    });

    await expect(
      retryWithBackoff(attempt, {
        backoffsMs: [1, 1],
        label: "thing",
        retryable: () => true,
        log: NO_LOG,
      }),
    ).rejects.toThrow("still not active");
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
