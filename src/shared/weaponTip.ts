import type { EffectiveWeaponStats, ItemInstance, SocketSlot, WeaponDef } from './types';
import { SOCKET_LABEL_KO } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * 무기 카드의 **본문 한 벌** (2026-09-16).
 *
 * 무기 상세를 그리는 카드는 둘이다 — 가방 격자의 인스턴스 카드(`inventory/ui/Tooltip`, 2×2 게이지 + 소켓 칸 +
 * 내구도 막대)와 어디서나 뜨는 떠다니는 칩 카드(`ui/hud/ItemTip`, 두 칸짜리 표). 둘은 그림이 다르지만 **읽는 숫자와
 * 그 문장은 같아야 한다**: 기업 거래 화면의 타일은 칩 카드를 쓰는데 거기에는 피해량 · 사거리가 아예 없어서, 같은
 * 총을 가방에서 볼 때와 판매대에서 볼 때 카드 내용이 달랐다 (사용자 버그, 2026-09-16).
 *
 * 그래서 **값과 문장은 이 파일 하나**가 만들고, 두 카드는 그것을 자기 마크업으로 칠하기만 한다 (§4.1 — 같은 식이
 * 두 폴더에 있으면 `src/shared` 로 옮긴다). 게이지로 그릴지 표 줄로 그릴지는 카드의 선택이므로 옵션이다.
 *
 * `AMMO_LABEL_KO` 는 `@/items` 에 있고 `@/shared` 는 `@/items` 를 import 하지 않으므로, 탄종 이름은 부르는 쪽이
 * 문자열로 넘긴다 (`ammoLabel`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 무기 카드 줄 이름 — 두 카드가 같은 낱말을 쓴다 (`inventory/ui/labels.TEXT.weaponStats` 의 같은 문구). */
export const WEAPON_TIP_LABEL_KO = {
  damage: '대미지', fireRate: '연사', recoil: '반동', range: '사거리',
  ammo: '탄종', loaded: '장전', mode: '발사 모드', zoom: '배율',
  durability: '내구도', sockets: '소켓',
  auto: '자동', semi: '반자동', scope: '스코프', broken: '파손', socketNone: '없음',
} as const;

/** 유효 사거리 — 피해가 줄기 시작하는 거리, 감쇠가 없는 무기는 최대 사거리. */
export const weaponEffectiveRange = (w: WeaponDef): number => w.falloffStart ?? w.range;

/** 반동 라디안 → `1.20°` (소수 둘째 자리). */
export const weaponRecoilText = (rad: number): string => `${(rad * 180 / Math.PI).toFixed(2)}°`;

/** 게이지 넷의 **값** (`damage` 는 펠릿을 곱한 한 발의 총합, `recoil` 은 라디안, `range` 는 m). */
export interface WeaponGaugeValues { damage: number; fireRate: number; recoil: number; range: number }

export function weaponGaugeValues(weapon: WeaponDef, s: EffectiveWeaponStats): WeaponGaugeValues {
  return {
    damage: s.damage * (weapon.pellets ?? 1),
    fireRate: s.fireRate,
    recoil: s.recoilV,
    range: weaponEffectiveRange(weapon),
  };
}

/** 게이지 넷의 **글자** (산탄총은 `24×8`). 게이지 옆의 작은 수치와 표 줄의 값이 같은 문장이어야 한다. */
export function weaponGaugeTexts(weapon: WeaponDef, s: EffectiveWeaponStats): Record<keyof WeaponGaugeValues, string> {
  const pellets = weapon.pellets ?? 1;
  return {
    damage: pellets > 1 ? `${s.damage}×${pellets}` : `${s.damage}`,
    fireRate: `${s.fireRate} /s`,
    recoil: weaponRecoilText(s.recoilV),
    range: `${weaponEffectiveRange(weapon)} m`,
  };
}

export interface WeaponTipRow { k: string; v: string }

export interface WeaponTipRowOptions {
  /** 호버한 인스턴스 — 장전 수 · 남은 내구도 · 끼운 부착물을 여기서 읽는다. 없으면 def 만 아는 카드다. */
  item?: ItemInstance | null;
  /** 탄종의 한국어 이름 (`@/items` 의 `AMMO_LABEL_KO`). 주지 않으면 탄종 줄이 없다 (격자 카드는 썸네일로 그린다). */
  ammoLabel?: string;
  /** 대미지 · 연사 · 반동 · 사거리도 표 줄로 (격자 카드는 게이지 막대로 그리므로 false). */
  gauges?: boolean;
  /** 내구도 줄 (격자 카드는 전체 폭 게이지로 그리므로 false). */
  durability?: boolean;
  /** 소켓 줄 (격자 카드는 정사각 칸 줄로 그리므로 false). */
  sockets?: boolean;
  /** 부착물 def id → 이름. 없으면 끼운 부착물 이름 대신 소켓 이름만 적는다. */
  attachmentName?: (defId: string) => string | undefined;
}

/**
 * 무기 카드의 표 줄들. 순서는 두 카드에서 같다 — 게이지 넷 → 탄종 → 장전 → 발사 모드 → 배율 → 내구도 → 소켓.
 * 「롱혼」처럼 장전이 없는 유니크는 장전 줄을 뺀다 (지닌 화살을 한 발씩 바로 건다 — `1 / 1` 은 거짓말이다).
 */
export function weaponTipRows(weapon: WeaponDef, stats: EffectiveWeaponStats, opts: WeaponTipRowOptions = {}): WeaponTipRow[] {
  const L = WEAPON_TIP_LABEL_KO;
  const rows: WeaponTipRow[] = [];
  if (opts.gauges) {
    const t = weaponGaugeTexts(weapon, stats);
    rows.push({ k: L.damage, v: t.damage }, { k: L.fireRate, v: t.fireRate }, { k: L.recoil, v: t.recoil }, { k: L.range, v: t.range });
  }
  if (opts.ammoLabel) rows.push({ k: L.ammo, v: opts.ammoLabel });
  const item = opts.item ?? null;
  if (weapon.unique !== 'bow') {
    rows.push({ k: L.loaded, v: item ? `${Math.max(0, item.ammoInMag ?? 0)} / ${stats.magSize}` : `${stats.magSize}` });
  }
  rows.push({ k: L.mode, v: weapon.automatic ? L.auto : L.semi });
  if (stats.adsZoom > 1 || stats.scope) rows.push({ k: L.zoom, v: `${stats.adsZoom}×${stats.scope ? ` · ${L.scope}` : ''}` });
  if (opts.durability) {
    const max = Math.max(1, stats.maxDurability);
    const cur = item ? Math.round(Math.max(0, Math.min(max, item.durability ?? max))) : null;
    rows.push({ k: L.durability, v: cur === null ? `최대 ${max}` : cur <= 0 ? `${L.broken} · 0 / ${max}` : `${cur} / ${max}` });
  }
  if (opts.sockets) {
    const text = weaponSocketText(stats, item, opts.attachmentName);
    if (text) rows.push({ k: L.sockets, v: text });
  }
  return rows;
}

/**
 * 받는 소켓 한 줄 — `총구(소음기) · 조준경 · 개머리판`. 받는 칸은 `stats.sockets` 하나가 정하고(무기표의 `sockets`
 * 열), 낀 것이 있으면 이름을 괄호로 붙인다. 받는 칸이 없는 유니크는 빈 문자열이다.
 */
export function weaponSocketText(
  stats: EffectiveWeaponStats, item?: ItemInstance | null, attachmentName?: (defId: string) => string | undefined,
): string {
  const slots: readonly SocketSlot[] = stats.sockets ?? [];
  if (slots.length === 0) return '';
  return slots.map((s) => {
    const att = item?.sockets?.[s];
    const name = att ? (attachmentName?.(att.defId) ?? att.defId) : '';
    return name ? `${SOCKET_LABEL_KO[s]}(${name})` : SOCKET_LABEL_KO[s];
  }).join(' · ');
}
