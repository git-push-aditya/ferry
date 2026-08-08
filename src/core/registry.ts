import type { ResourceRef, StepHandoff } from "./define";

export type RunAction = "created" | "reconciled";

export interface RegistryEntry {
  stepId: string;
  stepTitle: string;
  action: RunAction;
  resource?: ResourceRef;
  /** The step's declared handoff metadata, resolved to plain values. */
  handoff?: {
    terraform?: { type: string; address: string; importId: string };
    ansibleVar?: string;
  };
}

/**
 * The ledger of what THIS run changed — nothing more.
 *
 * It is not a state file and must never become one: ferry re-reads live cloud
 * state on every run and holds no stored belief about what exists. This lives
 * only for the duration of a process, feeding the report and (later) the
 * Terraform/Ansible handoff.
 */
export interface RunRegistry {
  integrationId: string;
  entries: RegistryEntry[];
}

export function createRunRegistry(integrationId: string): RunRegistry {
  return { integrationId, entries: [] };
}

export function recordChange(registry: RunRegistry, entry: RegistryEntry): void {
  registry.entries.push(entry);
}

export function createdResources(registry: RunRegistry): RegistryEntry[] {
  return registry.entries.filter((e) => e.action === "created");
}
