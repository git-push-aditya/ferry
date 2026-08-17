import type { Step } from "../../../../src/core/define";
import { requireOutput } from "../../../../src/core/define";
import { snowflakeClients } from "../../../../src/providers/snowflake";
import { isSlotOccupied, slotProperty, type KeySlot } from "./key-slots";
import type { Params } from "../params";

/** The slot NOT used for the new key — where the old key still lives. */
function oldSlotOf(newKeySlot: KeySlot): KeySlot {
  return newKeySlot === "1" ? "2" : "1";
}

/**
 * Phase B of the two-phase rotation: clears the OLD key from its slot, only
 * once the operator has confirmed the new key (minted in phase A) is
 * actually in use — gated on `CONFIRM_CUTOVER=true` so this run never
 * silently does the irreversible half.
 *
 * There is no way to restore the exact old key material on rollback — Ferry
 * never captured it, and `DESC USER` only ever exposes its fingerprint, not
 * the raw key — matching this project's established honesty about
 * irreversible-secret-clearing operations elsewhere (AWS access-key rotation,
 * IAM-user teardown).
 */
export const cutoverOldKeyStep: Step<Params> = {
  id: "cutover-old-key",
  title: "Retire the old key (human-gated)",

  async check(ctx) {
    if (!ctx.params.CONFIRM_CUTOVER) {
      ctx.log.info(
        "CONFIRM_CUTOVER is false — waiting for the operator to confirm the new key is in " +
          "use before retiring the old one. Nothing to do this run.",
      );
      return "exists";
    }

    const conn = await snowflakeClients(ctx).connection();
    const newKeySlot = requireOutput<KeySlot>(ctx, "newKeySlot");
    const oldSlot = oldSlotOf(newKeySlot);
    ctx.outputs.oldKeySlot = oldSlot;

    if (!(await isSlotOccupied(conn, ctx.params.USER_NAME, oldSlot))) {
      ctx.log.info(`Slot ${oldSlot} is already empty — cutover already complete`);
      return "exists";
    }

    ctx.log.info(`CONFIRM_CUTOVER=true and slot ${oldSlot} still holds the old key — retiring it`);
    return "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const oldSlot = ctx.outputs.oldKeySlot as KeySlot;

    await conn.runQuery(`ALTER USER ${ctx.params.USER_NAME} UNSET ${slotProperty(oldSlot)};`);
    ctx.log.success(
      `Cleared ${slotProperty(oldSlot)} on ${ctx.params.USER_NAME}. The new key is now the ` +
        `only key on this user.`,
    );

    return { oldKeySlot: oldSlot, cutoverThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.cutoverThisRun !== true) return;
    ctx.log.warn(
      `Cannot restore the old key that was just cleared from slot ${String(ctx.outputs.oldKeySlot)} ` +
        `on ${ctx.params.USER_NAME} — Ferry never captured the raw key material (DESC USER only ` +
        `ever exposes its fingerprint, not the key itself). A new key pair must be generated and ` +
        `set manually if the old one is still needed.`,
    );
  },

  resource(ctx) {
    const oldSlot = ctx.outputs.oldKeySlot as KeySlot;
    return {
      type: "snowflake_user_public_key",
      name: `${ctx.params.USER_NAME}:slot${oldSlot}`,
      attributes: { user: ctx.params.USER_NAME, slot: oldSlot, phase: "cutover", action: "unset" },
    };
  },
};
