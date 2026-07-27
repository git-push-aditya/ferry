import { info, success } from "./logger";

/** Create-or-skip: runs existsFn, and only calls createFn when it reports absent. */
export async function ensure(
  label: string,
  existsFn: () => Promise<boolean>,
  createFn: () => Promise<void>,
): Promise<void> {
  const exists = await existsFn();
  if (exists) {
    info(`${label}: already exists, skipping`);
    return;
  }
  await createFn();
  success(`${label}: created`);
}
