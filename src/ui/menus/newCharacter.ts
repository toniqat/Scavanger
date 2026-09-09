import { activeSlot, deleteSlot } from '@/shared';
/**
 * 새 캐릭터로 시작 (2026-09-07): throw away every **character** save so the next boot starts from nothing.
 *
 * Typing a new callsign on the title screen only renames the player (`scav.playerName`) — the 함선 창고, loadout,
 * ship, progression, meta and the session token all survive, which is why "a new character" used to open onto an
 * empty 창고 with no 기본 지급품 (that grant is once per profile). This is the explicit way to start over.
 *
 * Everything under the `scav.` prefix is cleared except the client **settings** below, which are not part of a
 * character: key bindings, audio volumes, 화면 설정 and the dev-console history. The prefix sweep (rather than a hand-written
 * key list) means a save added later is wiped too — the failure mode of forgetting one is a half-reset character.
 *
 * The session token goes with it: the relay hands the new token a fresh PeerId, so the server-side profile
 * (credits, stash / loadout / ship / progression documents, 소셜 아이디 · 친구) is a new one as well. Without that,
 * the old server profile would simply be downloaded again on the next connection.
 */
/**
 * 2026-09-09 (세이브 슬롯): 캐릭터가 셋이 되면서 이 함수는 **활성 슬롯 하나만** 지운다. 접두사 훑기는
 * `shared/saveSlot.deleteSlot` 으로 옮겨 갔고(같은 이유 — 나중에 추가된 세이브도 따라온다), 공용 설정
 * (키 바인딩 · 오디오 · 화면 · 콘솔 기록)은 그쪽 `SHARED_KEYS` 가 지킨다.
 */

/** Clears the active slot's character saves. Returns the keys removed (empty when localStorage is unavailable). */
export function resetCharacterSaves(): string[] {
  return deleteSlot(activeSlot());
}

export const NEW_CHARACTER_LABEL = '새 캐릭터로 시작';
