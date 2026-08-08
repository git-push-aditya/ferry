import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineIntegration, type Step, type StepState } from "../../src/core/define";
import type { DiscoveredIntegration } from "../../src/core/discover";
import { plannedAction, runIntegration } from "../../src/core/engine";
import { FerryError } from "../../src/core/errors";
import type { ProviderDef, ProviderRegistry } from "../../src/core/provider";

type Params = Record<string, never>;

/** Every call every step made, in order, so phase separation can be asserted. */
let trace: string[];

const testProvider: ProviderDef<{ ok: true }> = {
  id: "test",
  credentialKeys: ["TEST_TOKEN"],
  credentialSchema: z.object({ TEST_TOKEN: z.string().min(1) }),
  createClients: () => ({ ok: true }),
  resolveIdentity: async () => ({ accountId: "111122223333", description: "test identity" }),
  dispose: async () => {
    trace.push("dispose");
  },
};

const providers: ProviderRegistry = { test: testProvider };

interface FakeStepOptions {
  id: string;
  state?: StepState;
  createOutputs?: Record<string, unknown>;
  createThrows?: string;
  reconcile?: boolean;
  withResource?: boolean;
}

function fakeStep(opts: FakeStepOptions): Step<Params> {
  const step: Step<Params> = {
    id: opts.id,
    title: `step ${opts.id}`,
    async check() {
      trace.push(`check:${opts.id}`);
      return opts.state ?? "missing";
    },
    async rollback() {
      trace.push(`rollback:${opts.id}`);
    },
  };

  if (!opts.reconcile) {
    step.create = async () => {
      trace.push(`create:${opts.id}`);
      if (opts.createThrows) throw new Error(opts.createThrows);
      return opts.createOutputs ?? {};
    };
  } else {
    step.reconcile = async () => {
      trace.push(`reconcile:${opts.id}`);
      return opts.createOutputs ?? {};
    };
  }

  if (opts.withResource) {
    step.resource = () => ({ type: "test_thing", name: opts.id, attributes: { id: opts.id } });
    step.handoff = {
      terraform: {
        type: "test_thing",
        address: `test_thing.${opts.id}`,
        importId: () => `import-${opts.id}`,
      },
      ansibleVar: `thing_${opts.id}`,
    };
  }

  return step;
}

function makeFound(
  steps: Step<Params>[],
  overrides: { verifyThrows?: string } = {},
): DiscoveredIntegration {
  return {
    id: "test/fake",
    dir: "/nonexistent-integration-dir",
    manifestPath: "/nonexistent-integration-dir/integration.ts",
    integration: defineIntegration<Params>({
      id: "test/fake",
      schemaVersion: 1,
      summary: "a fake integration used by the engine tests",
      params: z.object({}) as unknown as z.ZodType<Params>,
      credentials: ["test"],
      steps,
      async verify() {
        trace.push("verify");
        if (overrides.verifyThrows) throw new Error(overrides.verifyThrows);
      },
      report() {
        trace.push("report");
        return "# fake\n";
      },
    }),
  };
}

function run(found: DiscoveredIntegration, dryRun = false) {
  return runIntegration({
    found,
    providers,
    dryRun,
    // The folder .env path does not exist, so params come from an empty object —
    // which the fake integration's empty params schema accepts.
    folderEnvPath: "/nonexistent-integration-dir/.env",
    credentialSource: { TEST_TOKEN: "t" },
    skipReport: true,
  });
}

let silenced: { log: typeof console.log; warn: typeof console.warn };

beforeEach(() => {
  trace = [];
  silenced = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  console.log = silenced.log;
  console.warn = silenced.warn;
  // installRollbackSignalHandlers adds a listener per run.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
});

describe("plannedAction", () => {
  test("missing + create() → create", () => {
    expect(plannedAction(fakeStep({ id: "a" }), "missing")).toBe("create");
  });

  test("exists + no reconcile() → skip", () => {
    expect(plannedAction(fakeStep({ id: "a" }), "exists")).toBe("skip");
  });

  test("exists + reconcile() → reconcile", () => {
    expect(plannedAction(fakeStep({ id: "a", reconcile: true }), "exists")).toBe("reconcile");
  });

  test("missing + reconcile-only step → reconcile", () => {
    expect(plannedAction(fakeStep({ id: "a", reconcile: true }), "missing")).toBe("reconcile");
  });

  test("conflict always wins, whatever the step declares", () => {
    expect(plannedAction(fakeStep({ id: "a" }), "conflict")).toBe("conflict");
  });
});

describe("plan phase", () => {
  test("runs EVERY check() before ANY create()", async () => {
    await run(makeFound([fakeStep({ id: "a" }), fakeStep({ id: "b" }), fakeStep({ id: "c" })]));

    expect(trace.slice(0, 3)).toEqual(["check:a", "check:b", "check:c"]);
    expect(trace.indexOf("create:a")).toBeGreaterThan(trace.indexOf("check:c"));
  });

  test("reports the action the apply phase will take for each step", async () => {
    const result = await run(
      makeFound([
        fakeStep({ id: "new" }),
        fakeStep({ id: "old", state: "exists" }),
        fakeStep({ id: "patch", state: "exists", reconcile: true }),
      ]),
    );

    expect(result.plan).toEqual([
      { stepId: "new", title: "step new", state: "missing", action: "create" },
      { stepId: "old", title: "step old", state: "exists", action: "skip" },
      { stepId: "patch", title: "step patch", state: "exists", action: "reconcile" },
    ]);
  });

  test("a conflict aborts before any mutation, with nothing to roll back", async () => {
    const found = makeFound([
      fakeStep({ id: "a" }),
      fakeStep({ id: "boom", state: "conflict" }),
      fakeStep({ id: "c" }),
    ]);

    await expect(run(found)).rejects.toThrow(FerryError);

    expect(trace).toEqual(["check:a", "check:boom", "check:c", "dispose"]);
    expect(trace.some((t) => t.startsWith("create:"))).toBe(false);
    expect(trace.some((t) => t.startsWith("rollback:"))).toBe(false);
  });
});

describe("--dry-run", () => {
  test("runs every check() and zero create()", async () => {
    const result = await run(
      makeFound([fakeStep({ id: "a" }), fakeStep({ id: "b", reconcile: true })]),
      true,
    );

    expect(trace).toEqual(["check:a", "check:b", "dispose"]);
    expect(result.dryRun).toBe(true);
    expect(result.plan.map((p) => p.action)).toEqual(["create", "reconcile"]);
  });

  test("does not verify or report", async () => {
    await run(makeFound([fakeStep({ id: "a" })]), true);
    expect(trace).not.toContain("verify");
    expect(trace).not.toContain("report");
  });

  test("records nothing in the run registry", async () => {
    const result = await run(makeFound([fakeStep({ id: "a", withResource: true })]), true);
    expect(result.registry.entries).toEqual([]);
  });
});

describe("apply phase", () => {
  test("skips create() for a step whose check() said 'exists'", async () => {
    await run(makeFound([fakeStep({ id: "a", state: "exists" }), fakeStep({ id: "b" })]));

    expect(trace).not.toContain("create:a");
    expect(trace).toContain("create:b");
  });

  test("registers rollback ONLY for steps that actually ran", async () => {
    const found = makeFound(
      [
        fakeStep({ id: "preexisting", state: "exists" }),
        fakeStep({ id: "created" }),
        fakeStep({ id: "patched", state: "exists", reconcile: true }),
      ],
      { verifyThrows: "verification failed" },
    );

    await expect(run(found)).rejects.toThrow("verification failed");

    expect(trace).toContain("rollback:created");
    expect(trace).toContain("rollback:patched");
    expect(trace).not.toContain("rollback:preexisting");
  });

  test("unwinds in LIFO order", async () => {
    const found = makeFound(
      [fakeStep({ id: "first" }), fakeStep({ id: "second" }), fakeStep({ id: "third" })],
      { verifyThrows: "nope" },
    );

    await expect(run(found)).rejects.toThrow("nope");

    const undone = trace.filter((t) => t.startsWith("rollback:"));
    expect(undone).toEqual(["rollback:third", "rollback:second", "rollback:first"]);
  });

  test("a create() throwing rolls back the earlier steps and stops", async () => {
    const found = makeFound([
      fakeStep({ id: "a" }),
      fakeStep({ id: "b", createThrows: "AWS said no" }),
      fakeStep({ id: "c" }),
    ]);

    await expect(run(found)).rejects.toThrow("AWS said no");

    expect(trace).not.toContain("create:c");
    // b's create threw, so b registered nothing — only a is undone.
    expect(trace.filter((t) => t.startsWith("rollback:"))).toEqual(["rollback:a"]);
  });

  test("merges each step's outputs into the shared context", async () => {
    const result = await run(
      makeFound([
        fakeStep({ id: "a", createOutputs: { alpha: 1 } }),
        fakeStep({ id: "b", createOutputs: { beta: 2 } }),
      ]),
    );

    expect(result.outputs).toEqual({ alpha: 1, beta: 2 });
  });

  test("a successful run is never torn down", async () => {
    await run(makeFound([fakeStep({ id: "a" })]));
    expect(trace).toEqual(["check:a", "create:a", "verify", "report", "dispose"]);
  });
});

describe("provider teardown", () => {
  test("disposes AFTER rollback, so rollback still has live clients", async () => {
    const found = makeFound([fakeStep({ id: "a" })], { verifyThrows: "nope" });

    await expect(run(found)).rejects.toThrow("nope");

    expect(trace.indexOf("rollback:a")).toBeLessThan(trace.indexOf("dispose"));
  });
});

describe("run registry", () => {
  test("records what changed, with the declared handoff metadata resolved", async () => {
    const result = await run(
      makeFound([
        fakeStep({ id: "made", withResource: true }),
        fakeStep({ id: "patched", state: "exists", reconcile: true, withResource: true }),
      ]),
    );

    expect(result.registry.integrationId).toBe("test/fake");
    expect(result.registry.entries).toEqual([
      {
        stepId: "made",
        stepTitle: "step made",
        action: "created",
        resource: { type: "test_thing", name: "made", attributes: { id: "made" } },
        handoff: {
          terraform: { type: "test_thing", address: "test_thing.made", importId: "import-made" },
          ansibleVar: "thing_made",
        },
      },
      {
        stepId: "patched",
        stepTitle: "step patched",
        action: "reconciled",
        resource: { type: "test_thing", name: "patched", attributes: { id: "patched" } },
        handoff: {
          terraform: {
            type: "test_thing",
            address: "test_thing.patched",
            importId: "import-patched",
          },
          ansibleVar: "thing_patched",
        },
      },
    ]);
  });

  test("skips steps that describe no resource — a read changes nothing to hand off", async () => {
    const result = await run(
      makeFound([fakeStep({ id: "reads", reconcile: true }), fakeStep({ id: "makes", withResource: true })]),
    );

    expect(result.registry.entries.map((e) => e.stepId)).toEqual(["makes"]);
  });

  test("records nothing for a step that was skipped", async () => {
    const result = await run(
      makeFound([fakeStep({ id: "already-there", state: "exists", withResource: true })]),
    );

    expect(result.registry.entries).toEqual([]);
  });
});

describe("credential kinds", () => {
  test("an unknown credential kind fails before anything runs", async () => {
    const found = makeFound([fakeStep({ id: "a" })]);
    found.integration.credentials = ["nope"];

    await expect(run(found)).rejects.toThrow(/Unknown credential kind/);
    expect(trace).toEqual([]);
  });
});
