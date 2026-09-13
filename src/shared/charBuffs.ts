/**
 * src/shared/charBuffs.ts — **캐릭터 버프** (2026-09-12, 사용자 결정). 설계: `docs/plans/char-buffs.md`.
 *
 * 한 캐릭터에 지금 걸린 것 — 먹어 둔 요리 · 실어 둔 준비물 · 운동 디버프 · 환경 노출 · 휴식 중 · 운동 중 — 을 **한 목록**으로
 * 모은다. 목록은 **표시와 동기화용**이다 (사용자 결정: 버프 자체에는 게임 효과가 없다). 효과의 원본은 여전히 제자리다 —
 * 요리 버프는 `progression` 의 `derived`, 준비물은 `hasEnvPrep`, 디버프는 `applyGymSession`, 자세는 `player`.
 *
 *   owner   `player`  — `PlayerRef.buffs` / `buffsRevision` / `player:buffsChanged` (progression · housing · 자기 자세 · 환경을 모은다)
 *   wire    `net`     — `cbuf state` + 스냅샷 `bfr` (리비전) → `RemotePlayerRef.buffs` / `net:remoteBuffsChanged`
 *   view    `ui`      — 내 체력바 아래 · 좌하단 분대 목록의 분대원 체력바 아래 썸네일 줄 (아이콘 + 시간 게이지)
 *
 * 이 파일은 **모양 · 이름 · 순서 · 검증**만 갖는다. 목록을 어떻게 채우는지는 player, 어떻게 그리는지는 ui 의 몫이다.
 */
import type { EnvKind, FurniturePoseKind, ItemDef } from './types';
import type { GymStat } from './progression';
import type { GymMinigame } from './housing';
import { ENV_LABEL_KO } from './labels';
import { GYM_FATIGUE_LABEL_KO, GYM_STATS } from './progression';
import { GYM_MINIGAME_LABEL_KO } from './housing';
import { FURNITURE_POSE_WIRE } from './net';
import { CHAR_BUFF_WIRE_MAX } from './constants';
import { mealQualityStars, normalizeMealQuality } from './cooking';

/** 버프 종류. 추가만 한다 (옛 클라이언트는 모르는 종류를 `sanitizeCharBuffs` 에서 버린다). */
export type CharBuffKind =
  | 'meal'          // 요리 — 함선: 다음 레이드에 실린 것(pending) · 레이드: 이번에 먹은 것(active)
  | 'prep'          // 준비물 — 환경당 하나, 같은 pending / active 규칙
  | 'env_exposed'   // 디버프: 상시 환경 행성에서 맞는 준비물 없이 노출돼 체력이 깎이고 있다 (레이드)
  | 'gym_fatigue'   // 디버프: 근육통 · 심폐 피로 (현실 시간 타이머)
  | 'rest'          // 휴식 중 — 흔들의자에 앉아 있다
  | 'exercise'      // 운동 중 — 운동 기구 세션
  /* appended (2026-09-12, 소모품 3종 — docs/plans/consumables-keys-favorites.md §1) */
  | 'adrenaline'    // 아드레날린 주사 — 레이드 시간제 (sim 시간), 아이템 썸네일 + 시간 게이지
  | 'stimulant'     // 각성제 — 같다
  /* appended (2026-09-13, 요리 미니게임 — docs/plans/cooking-minigames.md) */
  | 'cooking';      // 조리 중 — 조리대 앞 자세 (`defId` = 만드는 요리)

export const CHAR_BUFF_KINDS: readonly CharBuffKind[] = ['meal', 'prep', 'env_exposed', 'gym_fatigue', 'rest', 'exercise', 'adrenaline', 'stimulant', 'cooking'];

/** `pending` = 함선에서 다음 레이드에 실어 둔 것 (썸네일이 흐리다) · `active` = 지금 몸에 걸려 있는 것. */
export type CharBuffState = 'pending' | 'active';

export interface CharBuff {
  kind: CharBuffKind;
  /**
   * 한 캐릭터의 목록 안에서 유일한 키 — `meal` · `prep:<env>` · `env` · `fatigue:<stat>` · `pose`. ui 가 썸네일 DOM 을 이 키로
   * 재사용하고, 목록 비교(`sameCharBuffs`)도 이 키 순서로 한다.
   */
  key: string;
  /** 디버프인가 (`env_exposed` · `gym_fatigue`). 와이어에서는 믿지 않고 `kind` 에서 다시 정한다. */
  debuff: boolean;
  state: CharBuffState;
  /** `meal` · `prep` · `adrenaline` · `stimulant`: 아이템 def id (썸네일 글리프 · 색 · 이름). 소모품 둘의 key 는 `boost`. */
  defId?: string;
  /** `prep` · `env_exposed`: 행성 환경. */
  env?: EnvKind;
  /** `gym_fatigue` · `exercise`: 능력치. */
  stat?: GymStat;
  /** `exercise`: 미니게임. */
  minigame?: GymMinigame;
  /** `rest` · `exercise`: 자세 종류. */
  pose?: FurniturePoseKind;
  /** `rest` · `exercise`: 몸을 맡긴 가구 조각 uid. */
  furnitureUid?: string;
  /** 타이머 시작 (epoch ms, `ctx.net.serverNow() ?? Date.now()`) — 시간 게이지의 가득 찬 쪽. 없으면 타이머가 없다. */
  startedAt?: number;
  /** 타이머 끝 (epoch ms) — 게이지가 빈다. 없으면 타이머가 없다 (식사 · 준비물 · 자세). */
  endsAt?: number;
  /** appended (2026-09-13, 요리 품질): `meal` 의 품질 1 … `MEAL_QUALITY_MAX` (0 이면 생략). 썸네일 · 이름에 별로 붙는다. */
  quality?: number;
}

/** 썸네일 순서 — 디버프가 먼저, 그다음 지금 하고 있는 것, 그다음 실어 둔 것. */
export const CHAR_BUFF_ORDER: readonly CharBuffKind[] = ['env_exposed', 'gym_fatigue', 'adrenaline', 'stimulant', 'exercise', 'cooking', 'rest', 'meal', 'prep'];

export const CHAR_BUFF_LABEL_KO: Readonly<Record<CharBuffKind, string>> = {
  meal: '식사', prep: '준비물', env_exposed: '환경 노출', gym_fatigue: '운동 피로', rest: '휴식 중', exercise: '운동 중',
  adrenaline: '아드레날린', stimulant: '각성제', cooking: '조리 중',
};

/**
 * 종류별 기본 글리프 · 색. `meal` · `prep` 은 아이템 def 의 `icon` · `color` 가, `env_exposed` 는 `ENV_ICON` · `ENV_COLOR` 가
 * 먼저다 — 이 표는 그것을 못 찾았을 때의 자리다. 외부 에셋 금지 규약대로 유니코드 한 글자.
 */
export const CHAR_BUFF_GLYPH: Readonly<Record<CharBuffKind, string>> = {
  meal: '♨', prep: '⌾', env_exposed: '☣', gym_fatigue: '✱', rest: '☕', exercise: '⚖',
  adrenaline: '↯', stimulant: '◎', cooking: '⊛',
};
export const CHAR_BUFF_COLOR: Readonly<Record<CharBuffKind, string>> = {
  meal: '#ffb0a0', prep: '#ffd08a', env_exposed: '#ff6b6b', gym_fatigue: '#ff8a6b', rest: '#e8a0d0', exercise: '#ff9f7a',
  adrenaline: '#ffd24a', stimulant: '#7ad7ff', cooking: '#ffc890',
};

export const isDebuffKind = (kind: CharBuffKind): boolean => kind === 'env_exposed' || kind === 'gym_fatigue';

/** 한 줄 이름 (썸네일 `title` · 스모크). `defOf` 로 요리 · 준비물의 아이템 이름을 찾는다. */
export function charBuffTitle(b: CharBuff, defOf?: (defId: string) => ItemDef | null | undefined): string {
  switch (b.kind) {
    case 'meal':
    case 'prep': {
      let name: string = CHAR_BUFF_LABEL_KO[b.kind];
      if (b.defId && defOf) { try { name = defOf(b.defId)?.name ?? name; } catch { /* keep the label */ } }
      if (b.kind === 'meal' && (b.quality ?? 0) > 0) name = `${name} ${mealQualityStars(b.quality ?? 0)}`;   // 2026-09-13 요리 품질
      return b.state === 'pending' ? `${name} · 다음 레이드` : name;
    }
    case 'cooking': {
      if (b.defId && defOf) { try { const n = defOf(b.defId)?.name; if (n) return `${CHAR_BUFF_LABEL_KO.cooking} · ${n}`; } catch { /* keep the label */ } }
      return CHAR_BUFF_LABEL_KO.cooking;
    }
    case 'env_exposed': return b.env ? `${ENV_LABEL_KO[b.env]} 노출` : CHAR_BUFF_LABEL_KO.env_exposed;
    case 'gym_fatigue': return b.stat ? GYM_FATIGUE_LABEL_KO[b.stat] : CHAR_BUFF_LABEL_KO.gym_fatigue;
    case 'rest': return CHAR_BUFF_LABEL_KO.rest;
    case 'exercise': return b.minigame ? `${CHAR_BUFF_LABEL_KO.exercise} · ${GYM_MINIGAME_LABEL_KO[b.minigame]}` : CHAR_BUFF_LABEL_KO.exercise;
    case 'adrenaline':
    case 'stimulant': {
      if (b.defId && defOf) { try { return defOf(b.defId)?.name ?? CHAR_BUFF_LABEL_KO[b.kind]; } catch { /* keep the label */ } }
      return CHAR_BUFF_LABEL_KO[b.kind];
    }
  }
}

/** 남은 초 (타이머가 없으면 null, 끝났으면 0). */
export function charBuffRemainingS(b: CharBuff, nowMs: number): number | null {
  if (typeof b.endsAt !== 'number') return null;
  return Math.max(0, (b.endsAt - nowMs) / 1000);
}

/** 시간 게이지 — 남은 비율 1(막 시작) → 0(끝). 타이머가 없으면 null. */
export function charBuffRemainingRatio(b: CharBuff, nowMs: number): number | null {
  if (typeof b.endsAt !== 'number' || typeof b.startedAt !== 'number') return null;
  const span = b.endsAt - b.startedAt;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (b.endsAt - nowMs) / span));
}

/** `CHAR_BUFF_ORDER` → 키 순으로 제자리 정렬하고 같은 배열을 돌려준다. */
export function sortCharBuffs(list: CharBuff[]): CharBuff[] {
  list.sort((a, b) => (CHAR_BUFF_ORDER.indexOf(a.kind) - CHAR_BUFF_ORDER.indexOf(b.kind)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return list;
}

/** 두 목록이 표시 · 동기화상 같은가 (길이 · 순서 · 모든 필드). 리비전을 올릴지 정하는 데 쓴다. */
export function sameCharBuffs(a: readonly CharBuff[], b: readonly CharBuff[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.kind !== y.kind || x.key !== y.key || x.debuff !== y.debuff || x.state !== y.state || x.defId !== y.defId
      || x.env !== y.env || x.stat !== y.stat || x.minigame !== y.minigame || x.pose !== y.pose
      || x.furnitureUid !== y.furnitureUid || x.startedAt !== y.startedAt || x.endsAt !== y.endsAt
      || x.quality !== y.quality) return false;
  }
  return true;
}

const ID_RE = /^[A-Za-z0-9_:\-.]{1,64}$/;
const isStr = (v: unknown, re: RegExp = ID_RE): v is string => typeof v === 'string' && re.test(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * 와이어에서 받은 목록을 검증한 **새 배열** — 모르는 종류 · 이상한 필드 · 중복 키를 버리고, `debuff` 는 종류에서 다시 정하고,
 * `CHAR_BUFF_WIRE_MAX` 로 자르고, `CHAR_BUFF_ORDER` 로 정렬한다. 배열이 아니면 빈 배열. 던지지 않는다.
 */
export function sanitizeCharBuffs(raw: unknown): CharBuff[] {
  if (!Array.isArray(raw)) return [];
  const out: CharBuff[] = [];
  const keys = new Set<string>();
  const max = Math.max(0, Math.floor(CHAR_BUFF_WIRE_MAX));
  for (const r of raw) {
    if (out.length >= max) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind as CharBuffKind;
    if (!CHAR_BUFF_KINDS.includes(kind)) continue;
    if (!isStr(o.key) || keys.has(o.key)) continue;
    const b: CharBuff = { kind, key: o.key, debuff: isDebuffKind(kind), state: o.state === 'pending' ? 'pending' : 'active' };
    if (isStr(o.defId)) b.defId = o.defId;
    if (typeof o.env === 'string' && Object.prototype.hasOwnProperty.call(ENV_LABEL_KO, o.env)) b.env = o.env as EnvKind;
    if (typeof o.stat === 'string' && (GYM_STATS as readonly string[]).includes(o.stat)) b.stat = o.stat as GymStat;
    if (typeof o.minigame === 'string' && Object.prototype.hasOwnProperty.call(GYM_MINIGAME_LABEL_KO, o.minigame)) b.minigame = o.minigame as GymMinigame;
    if (typeof o.pose === 'string' && (FURNITURE_POSE_WIRE as readonly string[]).includes(o.pose)) b.pose = o.pose as FurniturePoseKind;
    if (isStr(o.furnitureUid)) b.furnitureUid = o.furnitureUid;
    if (isTime(o.startedAt) && isTime(o.endsAt) && o.endsAt >= o.startedAt) { b.startedAt = o.startedAt; b.endsAt = o.endsAt; }
    if (kind === 'meal') { const q = normalizeMealQuality(o.quality); if (q > 0) b.quality = q; }   // 2026-09-13 요리 품질
    keys.add(b.key);
    out.push(b);
  }
  return sortCharBuffs(out);
}
