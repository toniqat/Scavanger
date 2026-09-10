import type { WeaponSlot } from '@/shared';
import { Keys, keyLabel } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-10 (레이드 HUD 개편, 사용자 결정): **슬롯 칸 위젯(`.wslots`)은 없어졌다.**
 * 무기 패널 위의 `1 · 2 · T` 줄과 그 아래 주무기 키 · 무기 이름을 한꺼번에 걷어내고, 그 높이를 썸네일과
 * 잔탄 숫자가 가져갔다 (`hud/WeaponPanel`). 남은 것은 "무기 슬롯을 사람이 읽는 문자열로" 바꾸는 순수 헬퍼뿐이라
 * 파일은 그대로 두고 클래스만 지웠다 — DOM · 이벤트 구독 · 스타일은 하나도 없다.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Slot order = key order: 1 주무기 I, 2 주무기 II.
 * 2026-09-10: 보조무기(3번) 칸이 없어졌다 — `WeaponSlot` 에는 남아 있지만 이 목록에 없다.
 */
export const WEAPON_SLOTS: readonly WeaponSlot[] = ['primary', 'primary2'];

/** Live key label of a weapon slot (rebindable — read at use time). */
export function weaponSlotKey(slot: WeaponSlot): string {
  return keyLabel(slot === 'primary' ? Keys.PRIMARY : slot === 'primary2' ? Keys.PRIMARY2 : Keys.SECONDARY);
}

export const WEAPON_SLOT_LABEL_KO: Readonly<Record<WeaponSlot, string>> = { primary: '주무기 I', primary2: '주무기 II', secondary: '보조' };

/**
 * Short display name for a weapon item: model code (`AR-23`) plus the grade numeral when the name ends with one
 * (`AR-23 리버레이터 III` → `AR-23 III`). Falls back to the full name.
 */
export function weaponShortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name;
  const last = parts[parts.length - 1];
  return /^[IVX]+$/.test(last) ? `${parts[0]} ${last}` : parts[0];
}
