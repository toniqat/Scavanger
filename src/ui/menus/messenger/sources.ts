import type { GameContext, NpcQuestRef, RoomsRef } from '@/shared';

/**
 * 메신저가 읽는 두 창구 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」) — `menus/social/socialSource` 와 같은 자리.
 *
 *   - `npcOf(ctx)`   = `ctx.meta.npc` (NPC 연락 · 대화 · 퀘스트, owner: meta/) — 없으면 null.
 *   - `roomsOf(ctx)` = `ctx.net.rooms` (단체방, owner: net/) — 없으면 null.
 *
 * 둘 다 선택 속성이라 메신저의 모든 칸은 **없는 경우를 먼저 그린다** (NPC 목록 없음 · 단체방 칸 숨김). 헤드리스 스모크는
 * 릴레이 · 퀘스트 데이터 없이도 화면을 몰아 볼 수 있게 `setDebugNpc` / `setDebugRooms` 로 아무 ref 나 꽂는다
 * (`HudSystem.debugNpc` · `debugRooms`). null 을 넘기면 진짜 창구로 돌아간다.
 */

let debugNpc: NpcQuestRef | null = null;
let debugRooms: RoomsRef | null = null;

export function npcOf(ctx: GameContext): NpcQuestRef | null {
  return debugNpc ?? ctx.meta?.npc ?? null;
}

export function roomsOf(ctx: GameContext): RoomsRef | null {
  return debugRooms ?? ctx.net?.rooms ?? null;
}

/** 스모크 훅: NPC 창구를 갈아 끼운다 (null = `ctx.meta.npc` 로 되돌림). */
export function setDebugNpc(ref: NpcQuestRef | null): void { debugNpc = ref; }
/** 스모크 훅: 단체방 창구를 갈아 끼운다 (null = `ctx.net.rooms` 로 되돌림). */
export function setDebugRooms(ref: RoomsRef | null): void { debugRooms = ref; }
