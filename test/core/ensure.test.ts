import { describe, expect, mock, test } from "bun:test";
import { ensure } from "../../src/core/ensure";

describe("ensure", () => {
  test("skips createFn when existsFn reports true, and returns false (nothing created)", async () => {
    const existsFn = mock(async () => true);
    const createFn = mock(async () => {});

    const created = await ensure("thing", existsFn, createFn);

    expect(existsFn).toHaveBeenCalledTimes(1);
    expect(createFn).not.toHaveBeenCalled();
    expect(created).toBe(false);
  });

  test("calls createFn when existsFn reports false, and returns true (created)", async () => {
    const existsFn = mock(async () => false);
    const createFn = mock(async () => {});

    const created = await ensure("thing", existsFn, createFn);

    expect(existsFn).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(created).toBe(true);
  });

  test("propagates a createFn rejection instead of swallowing it", async () => {
    const existsFn = mock(async () => false);
    const createFn = mock(async () => {
      throw new Error("AWS said no");
    });

    await expect(ensure("thing", existsFn, createFn)).rejects.toThrow("AWS said no");
  });

  test("propagates an existsFn rejection without calling createFn", async () => {
    const existsFn = mock(async () => {
      throw new Error("network blip");
    });
    const createFn = mock(async () => {});

    await expect(ensure("thing", existsFn, createFn)).rejects.toThrow("network blip");
    expect(createFn).not.toHaveBeenCalled();
  });
});
