import type { Step } from "../../../../src/core/define";
import { snowflakeClients, sqlLiteral, userState } from "../../../../src/providers/snowflake";
import { cleanPublicKey, keySlotOccupancy, slotProperty, type KeySlot } from "./key-slots";
import type { Params } from "../params";

/**
 * Phase A of the two-phase, zero-downtime rotation: put the NEW key into
 * whichever slot is currently unoccupied. By convention slot 1 holds the
 * current/old key and slot 2 receives the new one; if — unusually — both
 * slots are already occupied, the new key goes into slot 2 anyway (treating
 * slot 1 as the current primary that phase B will retire).
 *
 * The old key in slot 1 is never touched here, so any client still
 * authenticating with it keeps working uninterrupted while this run proceeds.
 */
function targetSlot(slot1Occupied: boolean, slot2Occupied: boolean): KeySlot {
  if (!slot1Occupied && !slot2Occupied) return "1"; // first key ever for this user
  if (!slot2Occupied) return "2"; // normal case: slot 1 is the current key
  if (!slot1Occupied) return "1"; // slot 2 already holds something, slot 1 is free
  return "2"; // both occupied — convention: slot 2 is the new-key slot
}

export const mintNewKeyStep: Step<Params> = {
  id: "mint-new-key",
  title: "Mint new key into the unused slot",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();

    if ((await userState(conn, ctx.params.USER_NAME)) !== "exists") {
      ctx.log.error(`User ${ctx.params.USER_NAME} does not exist — cannot rotate its keys`);
      return "conflict";
    }

    const { slot1Occupied, slot2Occupied } = await keySlotOccupancy(conn, ctx.params.USER_NAME);
    const slot = targetSlot(slot1Occupied, slot2Occupied);
    ctx.outputs.newKeySlot = slot;

    const occupied = slot === "1" ? slot1Occupied : slot2Occupied;
    if (occupied) {
      // Comparing fingerprints against the new key isn't reliable without
      // hashing it the same way Snowflake does, so the simplest correct check
      // is occupancy of the target slot: if something is already there, treat
      // it as already-minted and skip re-setting it.
      ctx.log.info(`Slot ${slot} is already occupied; treating the new key as already minted`);
      return "exists";
    }

    ctx.log.info(`Targeting slot ${slot} for the new key`);
    return "missing";
  },

  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const slot = ctx.outputs.newKeySlot as KeySlot;
    const cleaned = cleanPublicKey(ctx.params.NEW_PUBLIC_KEY);

    await conn.runQuery(
      `ALTER USER ${ctx.params.USER_NAME} SET ${slotProperty(slot)} = ${sqlLiteral(cleaned)};`,
    );

    ctx.log.success(
      `New key set in slot ${slot}. Update all configured Snowflake connections for ` +
        `${ctx.params.USER_NAME} to use the new key, confirm they work, then re-run with ` +
        `CONFIRM_CUTOVER=true to clear the old key from slot 1.`,
    );

    return { newKeySlot: slot, mintedThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.mintedThisRun !== true) return;
    const conn = await snowflakeClients(ctx).connection();
    const slot = ctx.outputs.newKeySlot as KeySlot;
    await conn.runQuery(`ALTER USER ${ctx.params.USER_NAME} UNSET ${slotProperty(slot)};`);
  },

  resource(ctx) {
    const slot = ctx.outputs.newKeySlot as KeySlot;
    return {
      type: "snowflake_user_public_key",
      name: `${ctx.params.USER_NAME}:slot${slot}`,
      attributes: { user: ctx.params.USER_NAME, slot, phase: "mint" },
    };
  },
};
