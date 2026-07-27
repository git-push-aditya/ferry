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

export function info(message: string): void {
  console.log(`  ${message}`);
}

export function warn(message: string): void {
  console.warn(`  ⚠ ${message}`);
}

export function error(message: string): void {
  console.error(`  ✗ ${message}`);
}

export function success(message: string): void {
  console.log(`  ✓ ${message}`);
}
