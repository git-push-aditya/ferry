import path from "node:path";
import { z } from "zod";
import type { Integration, ProviderClients, Step, StepContext, StepState } from "./define";
import type { DiscoveredIntegration } from "./discover";
import { FerryError } from "./errors";
import { loadEnvLayers, readEnvFile } from "./env";
import { info, logger, section, setStepTotal, step as banner, success, warn } from "./logger";
import { allCredentialKeys, type ProviderRegistry } from "./provider";
import { createRunRegistry, recordChange, type RunRegistry } from "./registry";
import { writeReport } from "./report";
import {
  createRollbackStack,
  disarmRollback,
  installRollbackSignalHandlers,
  registerRollback,
  runRollback,
} from "./rollback";

export interface RunOptions {
  found: DiscoveredIntegration;
  providers: ProviderRegistry;
  dryRun?: boolean;
  /** Where root credentials are read from. Defaults to process.env (bun loads the root .env). */
  credentialSource?: Record<string, string | undefined>;
  /** Overrides the folder .env location. Tests use it; the CLI does not. */
  folderEnvPath?: string;
  /** Skips writing the markdown report. Tests use it. */
  skipReport?: boolean;
}

export interface PlanEntry {
  stepId: string;
  title: string;
  state: StepState;
  /** What the apply phase will do with this step. */
  action: "create" | "reconcile" | "skip" | "conflict";
}

export interface RunResult {
  integrationId: string;
  dryRun: boolean;
  plan: PlanEntry[];
  registry: RunRegistry;
  outputs: Record<string, unknown>;
  reportPath?: string;
}

/** What the apply phase would do, given what check() found. */
export function plannedAction<P>(step: Step<P>, state: StepState): PlanEntry["action"] {
  if (state === "conflict") return "conflict";
  if (state === "missing" && step.create) return "create";
  if (step.reconcile) return "reconcile";
  return "skip";
}

function composeCredentialSchema(kinds: string[], providers: ProviderRegistry): z.ZodTypeAny {
  const schemas = kinds.map((kind) => {
    const provider = providers[kind];
    if (!provider) {
      throw new FerryError(`Unknown credential kind "${kind}"`, [
        `Known kinds: ${Object.keys(providers).join(", ") || "(none registered)"}`,
      ]);
    }
    return provider.credentialSchema;
  });
  if (!schemas.length) return z.object({});
  return schemas.reduce((a, b) => z.intersection(a, b));
}

/**
 * plan → apply → verify → rollback.
 *
 * The phase split is the safety property: every check() runs before any
 * create() does, so a run that cannot succeed (a bucket owned by another
 * account, say) aborts having mutated nothing at all. Once apply starts, every
 * change is registered for LIFO undo and any throw — including SIGINT — unwinds
 * exactly what this run made and nothing else.
 */
export async function runIntegration(opts: RunOptions): Promise<RunResult> {
  const { found, providers } = opts;
  const integration = found.integration as Integration<unknown>;
  const dryRun = Boolean(opts.dryRun);

  // One counted banner per step, plus the verify and report phases. The env
  // and plan preambles are uncounted headings so the "STEP n/total" numbering
  // still lines up with the manifest.
  setStepTotal(integration.steps.length + 2);

  // ---------------------------------------------------------------- env
  section("Load + validate environment");
  const folderEnvPath = opts.folderEnvPath ?? path.join(found.dir, ".env");
  const folderSource = (await readEnvFile(folderEnvPath)) ?? {};
  const { creds, params } = loadEnvLayers({
    credentialSource: opts.credentialSource ?? process.env,
    folderSource,
    folderEnvPath,
    credentialKeys: allCredentialKeys(providers),
    credentialSchema: composeCredentialSchema(integration.credentials, providers) as z.ZodType<
      Record<string, unknown>
    >,
    paramsSchema: integration.params,
  });
  success(`Environment valid (root credentials + ${path.relative(process.cwd(), folderEnvPath)})`);

  // ------------------------------------------------------------ clients
  const clients: ProviderClients = {};
  for (const kind of integration.credentials) {
    clients[kind] = providers[kind]!.createClients(creds as Record<string, unknown>);
  }

  const outputs: Record<string, unknown> = {};
  const ctx: StepContext<unknown> = {
    params,
    creds: creds as Record<string, unknown>,
    clients,
    accountId: "",
    outputs,
    dryRun,
    log: logger,
  };

  const registry = createRunRegistry(integration.id);
  const result: RunResult = {
    integrationId: integration.id,
    dryRun,
    plan: [],
    registry,
    outputs,
  };

  // Inside the try from here on, so provider teardown runs even if the identity
  // probe is what fails (expired credentials being the usual reason).
  try {
    // ----------------------------------------------------------- identity
    // Resolved once, before any step, so every step shares one account id.
    for (const kind of integration.credentials) {
      const provider = providers[kind]!;
      if (!provider.resolveIdentity) continue;
      const identity = await provider.resolveIdentity(clients[kind]);
      if (identity.accountId && !ctx.accountId) ctx.accountId = identity.accountId;
      info(`${kind}: ${identity.description}`);
    }

    // ------------------------------------------------------------- plan
    // Every check() runs here, before anything is mutated. This is also
    // exactly what --dry-run executes, so a dry-run exercises the same code
    // path a real run does rather than a parallel description of it.
    section("Plan");
    const plan: PlanEntry[] = [];
    for (const step of integration.steps) {
      const state = await step.check(ctx);
      plan.push({ stepId: step.id, title: step.title, state, action: plannedAction(step, state) });
    }
    result.plan = plan;

    const width = Math.max(...plan.map((p) => p.action.length));
    for (const entry of plan) {
      info(`[${entry.action.padEnd(width)}] ${entry.title}`);
    }

    const conflicts = plan.filter((p) => p.action === "conflict");
    if (conflicts.length) {
      throw new FerryError("Aborting before any change — the plan has unresolvable conflicts.", [
        ...conflicts.map((c) => `  - ${c.title}`),
        "Nothing was created or modified.",
      ]);
    }

    if (dryRun) {
      info("--dry-run: checks only, no create() ran. No changes made.");
      return result;
    }

    // ------------------------------------------------------------ apply
    const rollback = createRollbackStack();
    installRollbackSignalHandlers(rollback);

    try {
      for (const [index, step] of integration.steps.entries()) {
        const entry = plan[index]!;
        banner(step.title);

        if (entry.action === "skip") {
          info(`${step.id}: already present, skipping`);
          continue;
        }

        if (entry.action === "create" && !step.create) {
          throw new FerryError(`Step "${step.id}" reported "missing" but declares no create()`);
        }

        const run = entry.action === "create" ? step.create! : step.reconcile!;
        const stepOutputs = await run(ctx);
        Object.assign(outputs, stepOutputs);

        // Registered only now: a step that was skipped created nothing, and
        // rolling back something that already existed is the one thing this
        // tool must never do.
        registerRollback(rollback, step.title, () => step.rollback(ctx));

        // Only steps that describe a resource go in the ledger. A step that
        // merely reads (DESC INTEGRATION) changed nothing there is to hand off.
        if (step.resource) {
          recordChange(registry, {
            stepId: step.id,
            stepTitle: step.title,
            action: entry.action === "create" ? "created" : "reconciled",
            resource: step.resource(ctx),
            handoff: step.handoff
              ? {
                  terraform: step.handoff.terraform
                    ? {
                        type: step.handoff.terraform.type,
                        address: step.handoff.terraform.address,
                        importId: step.handoff.terraform.importId(ctx),
                      }
                    : undefined,
                  ansibleVar: step.handoff.ansibleVar,
                }
              : undefined,
          });
        }

        success(`${step.id}: ${entry.action === "create" ? "created" : "reconciled"}`);
      }

      // ----------------------------------------------------------- verify
      // "Provisioned" means proven working. A throw here is treated exactly
      // like a failed create: the whole run unwinds.
      banner("Verify");
      await integration.verify(ctx);
      success("Verification passed");

      // Past this point the run is a success — nothing may be torn down.
      disarmRollback(rollback);
    } catch (err) {
      // Runs BEFORE provider teardown below, so Snowflake DROPs still have a
      // live connection to run on.
      await runRollback(rollback);
      throw err;
    }

    // ----------------------------------------------------------- report
    banner("Report");
    const markdown = integration.report(ctx);
    if (opts.skipReport) {
      info("Report generation skipped");
    } else {
      const nameHint = integration.reportName?.(ctx) ?? integration.id.replace(/\//g, "-");
      result.reportPath = await writeReport(nameHint, markdown);
      success(`Report written to ${result.reportPath} (chmod 0600)`);
    }

    return result;
  } finally {
    for (const kind of integration.credentials) {
      const provider = providers[kind];
      if (!provider?.dispose) continue;
      try {
        await provider.dispose(clients[kind]);
      } catch (err) {
        warn(`${kind}: teardown failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
