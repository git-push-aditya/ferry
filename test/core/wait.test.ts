import { describe, expect, mock, test } from "bun:test";
import { pollUntil } from "../../src/core/wait";

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
