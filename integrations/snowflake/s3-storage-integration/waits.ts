/**
 * AWS IAM is eventually consistent: a newly created role/policy, or a role
 * whose trust policy was just patched, isn't reliably usable everywhere for a
 * few seconds. Rather than guess a fixed sleep, poll a read-your-write check
 * until it's actually confirmed (bounded by a timeout), then add a smaller
 * fixed buffer for the parts (STS AssumeRole evaluation) that can lag behind
 * even a confirmed GetRole/GetPolicy read. This avoids tripping the
 * (rollback-triggering) failure path on a fresh account.
 */
export const IAM_CREATE_POLL_INTERVAL_MS = 3_000;
export const IAM_CREATE_POLL_TIMEOUT_MS = 20_000;
export const IAM_CREATE_BUFFER_WAIT_MS = 15_000;
export const TRUST_POLICY_POLL_INTERVAL_MS = 3_000;
export const TRUST_POLICY_POLL_TIMEOUT_MS = 30_000;
export const TRUST_POLICY_BUFFER_WAIT_MS = 20_000;

/** Backoff for the verification COPY while the trust policy propagates. */
export const COPY_RETRY_BACKOFFS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
