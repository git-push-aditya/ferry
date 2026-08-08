let stepCount = 0;
let stepTotal = 0;

export function setStepTotal(total: number): void {
  stepTotal = total;
  stepCount = 0;
}

export function step(label: string): void {
  stepCount += 1;
  const banner = `── STEP ${stepCount}/${stepTotal}: ${label} ──`;
  console.log(`\n${banner}`);
}

/** A heading that is not one of the counted steps (env load, plan). */
export function section(label: string): void {
  console.log(`\n── ${label} ──`);
}

export function info(message: string): void {
  console.log(`  ${message}`);
}

// Plain ASCII tags rather than glyphs: this output gets piped into CI logs and
// pasted into tickets, where a symbol either renders inconsistently or gets
// stripped. A word survives both, and greps cleanly.
export function warn(message: string): void {
  console.warn(`  WARN  ${message}`);
}

export function error(message: string): void {
  console.error(`  ERROR ${message}`);
}

export function success(message: string): void {
  console.log(`  OK    ${message}`);
}

/**
 * The slice of the logger handed to steps. Steps get the line-level writers
 * only — the step banner is the engine's to emit, so a step can't desynchronise
 * the "STEP n/total" counter.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
}

export const logger: Logger = { info, warn, error, success };
