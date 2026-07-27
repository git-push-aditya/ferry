import { info, success } from "./logger";

/**
 * Create-or-skip: runs existsFn, and only calls createFn when it reports absent.
 * Returns whether createFn ran, so callers know whether to register rollback
 * cleanup (never clean up a resource that already existed before this run).
 */
export async function ensure(
  label: string,
  existsFn: () => Promise<boolean>,
  createFn: () => Promise<void>,
): Promise<boolean> {
  const exists = await existsFn();
  if (exists) {
    info(`${label}: already exists, skipping`);
    return false;
  }
  await createFn();
  success(`${label}: created`);
  return true;
}
