import type { StepContext } from "../../../src/core/define";
import { requireOutput } from "../../../src/core/define";
import { descUser, snowflakeClients } from "../../../src/providers/snowflake";
import type { KeySlot } from "./steps/key-slots";
import type { Params } from "./params";

const FP_PROPERTY: Record<KeySlot, string> = {
  "1": "RSA_PUBLIC_KEY_FP",
  "2": "RSA_PUBLIC_KEY_2_FP",
};

/**
 * Live functional proof, phased to match the two-phase design:
 *
 * - Phase A (mint) always ran: the new key's slot fingerprint must be
 *   populated.
 * - Phase B (cutover) only ran if `CONFIRM_CUTOVER=true` produced an
 *   `oldKeySlot` output: that slot's fingerprint must now be empty.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const props = await descUser(conn, ctx.params.USER_NAME);

  const newKeySlot = requireOutput<KeySlot>(ctx, "newKeySlot");
  const newFingerprint = props.get(FP_PROPERTY[newKeySlot]) ?? "";
  if (!newFingerprint.trim()) {
    throw new Error(
      `${FP_PROPERTY[newKeySlot]} is still empty on ${ctx.params.USER_NAME} after minting the new key`,
    );
  }
  ctx.log.success(`Confirmed ${FP_PROPERTY[newKeySlot]} is populated on ${ctx.params.USER_NAME}`);

  const oldKeySlot = ctx.outputs.oldKeySlot as KeySlot | undefined;
  if (oldKeySlot === undefined) {
    ctx.log.info("CONFIRM_CUTOVER was not set — old key retained, cutover not verified this run");
    return;
  }

  const oldFingerprint = props.get(FP_PROPERTY[oldKeySlot]) ?? "";
  if (oldFingerprint.trim()) {
    throw new Error(
      `${FP_PROPERTY[oldKeySlot]} is still populated on ${ctx.params.USER_NAME} after cutover`,
    );
  }
  ctx.log.success(`Confirmed ${FP_PROPERTY[oldKeySlot]} is empty on ${ctx.params.USER_NAME}`);
}
