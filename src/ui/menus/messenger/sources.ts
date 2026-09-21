import type { GameContext, NpcQuestRef, RoomsRef } from '@/shared';

/**
 * The two sources the messenger reads (2026-09-14) — the same place as `menus/social/socialSource`.
 *
 *   - `npcOf(ctx)`   = `ctx.meta.npc` (NPC contacts · conversations · quests, owner: meta/) — null with none.
 *   - `roomsOf(ctx)` = `ctx.net.rooms` (group rooms, owner: net/) — null with none.
 *
 * Both are optional properties, so every pane of the messenger **draws the missing case first** (no NPC list · the group
 * room filter hidden). A headless smoke plugs any ref in with `setDebugNpc` / `setDebugRooms` so it can drive the screens without
 * relay or quest data (`HudSystem.debugNpc` · `debugRooms`). Passing null returns to the real source.
 */

let debugNpc: NpcQuestRef | null = null;
let debugRooms: RoomsRef | null = null;

export function npcOf(ctx: GameContext): NpcQuestRef | null {
  return debugNpc ?? ctx.meta?.npc ?? null;
}

export function roomsOf(ctx: GameContext): RoomsRef | null {
  return debugRooms ?? ctx.net?.rooms ?? null;
}

/** Smoke hook: swaps the NPC source (null = back to `ctx.meta.npc`). */
export function setDebugNpc(ref: NpcQuestRef | null): void { debugNpc = ref; }
/** Smoke hook: swaps the group room source (null = back to `ctx.net.rooms`). */
export function setDebugRooms(ref: RoomsRef | null): void { debugRooms = ref; }
