import { describe, expect, mock, test } from "bun:test";
import { createRollbackStack, disarmRollback, registerRollback, runRollback } from "../../src/core/rollback";

describe("rollback stack", () => {
  test("does nothing when no actions were registered", async () => {
    const stack = createRollbackStack();
    await expect(runRollback(stack)).resolves.toBeUndefined();
  });

  test("undoes registered actions in reverse (LIFO) order", async () => {
    const order: string[] = [];
    const stack = createRollbackStack();
    registerRollback(stack, "first created", async () => {
      order.push("first");
    });
    registerRollback(stack, "second created", async () => {
      order.push("second");
    });
    registerRollback(stack, "third created", async () => {
      order.push("third");
    });

    await runRollback(stack);

    expect(order).toEqual(["third", "second", "first"]);
  });

  test("continues past a failing undo instead of aborting the rest", async () => {
    const stack = createRollbackStack();
    const first = mock(async () => {});
    const failing = mock(async () => {
      throw new Error("AWS still has a dependency on this");
    });
    const last = mock(async () => {});
    registerRollback(stack, "a", first);
    registerRollback(stack, "b", failing);
    registerRollback(stack, "c", last);

    await runRollback(stack);

    expect(last).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  test("a disarmed stack undoes nothing — a successful run must not be torn down", async () => {
    const stack = createRollbackStack();
    const undo = mock(async () => {});
    registerRollback(stack, "created thing", undo);

    disarmRollback(stack);
    await runRollback(stack);

    expect(undo).not.toHaveBeenCalled();
  });

  test("does not unwind twice when rollback is triggered again mid-run", async () => {
    const stack = createRollbackStack();
    const undo = mock(async () => {});
    registerRollback(stack, "created thing", undo);

    await runRollback(stack);
    await runRollback(stack);

    expect(undo).toHaveBeenCalledTimes(1);
  });
});
