import {
  CHAR_NAME_RANDOM_MAX, CHAR_STAT_MAX, CHAR_STAT_MIN, CHAR_STAT_TOTAL, PROFILE_VERSION,
} from './constants';
import { IMPLANT_IDS, type ImplantId } from './implants';
import { SKILL_IDS, STAT_IDS, type PlayerProfile, type SkillId, type StatId } from './progression';
import { type SlotId, writeSlotSave } from './saveSlot';

/* ────────────────────────────────────────────────────────────────────────────
 * 캐릭터 생성 (2026-09-09).
 *
 * 캐릭터 선택창의 빈 칸에서 열리는 생성창의 **규칙**과, 그 결과를 슬롯에 심는 함수가 여기 있다.
 * `ui/` 가 그리고 `progression/` 이 나중에 읽으므로, 둘 다 의존하는 `shared/` 가 자리다.
 *
 * **능력치**: 다섯 능력치가 전부 `CHAR_STAT_MIN`(1) 에서 시작하고 합이 `CHAR_STAT_TOTAL`(15) 이 될 때까지
 * 배분한다 — 즉 남는 점수는 15 − 5 = **10** 점. 한 능력치의 상한은 `CHAR_STAT_MAX`(5) 다. 이것은 **생성
 * 시점의** 상한일 뿐이고, 게임 안에서 자라는 상한은 그대로 `STAT_MAX`(20) 다.
 *
 * 기존 세이브는 손대지 않는다 (2026-09-09 결정): `progression/Profile.freshProfile` 의 `STAT_BASE`(5) 는
 * 그대로 남아 생성창을 거치지 않고 만들어지는 프로필의 기본값으로 계속 쓰인다. 생성창을 거친 캐릭터만
 * 여기 규칙을 따른다.
 *
 * **부팅 전에 쓴다.** 생성이 끝나면 이 모듈이 슬롯의 `scav.s<n>.profile` 을 직접 쓰고, 부르는 쪽이
 * `setActiveSlot` + `markAutoStart` + `location.reload()` 한다. 이미 메모리에 올라온 `ProgressionSystem` 에
 * 새 프로필을 밀어 넣는 길은 두지 않는다 — 창고 · 메타 · 함선까지 전부 다시 읽어야 하고, 그건 부팅이다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 생성창의 능력치 하한 · 상한 · 합 (data/constants.csv). */
export const CREATE_STAT_MIN: number = Math.round(CHAR_STAT_MIN);
export const CREATE_STAT_MAX: number = Math.round(CHAR_STAT_MAX);
export const CREATE_STAT_TOTAL: number = Math.round(CHAR_STAT_TOTAL);

/** 전부 하한에서 시작할 때 남는 배분 점수 (기본 규칙에서 10). */
export const CREATE_STAT_POINTS: number = Math.max(0, CREATE_STAT_TOTAL - CREATE_STAT_MIN * STAT_IDS.length);

/** 이름 주사위가 쓰는 앞말. */
export const DEFAULT_CALLSIGN = '스캐빈저';

/** 캐릭터 이름 최대 길이 (`sanitizePlayerName` 과 같은 값). */
export const CHARACTER_NAME_MAX = 16;

/** 생성창이 모아 넘기는 것. */
export interface NewCharacter {
  name: string;
  stats: Record<StatId, number>;
  /** 병사 모델 악센트 색 `#rrggbb`. */
  accent: string;
  /** 시작 전술 임플란트. */
  implant: ImplantId;
}

/** 능력치 전부 하한인 배분 (생성창의 시작 상태). */
export function baseCreateStats(): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) out[id] = CREATE_STAT_MIN;
  return out;
}

/** 배분의 합. */
export function statTotal(stats: Record<StatId, number>): number {
  let n = 0;
  for (const id of STAT_IDS) n += stats[id] ?? 0;
  return n;
}

/** 아직 쓰지 않은 점수 (음수가 나올 수 없게 배분 쪽에서 막는다). */
export function statPointsLeft(stats: Record<StatId, number>): number {
  return CREATE_STAT_TOTAL - statTotal(stats);
}

/**
 * 한 능력치를 `delta` 만큼 옮길 수 있는가. 하한 · 상한 · 남은 점수를 전부 본다.
 * 올릴 때는 남은 점수가 있어야 하고, 내릴 때는 하한 위여야 한다.
 */
export function canAdjustStat(stats: Record<StatId, number>, id: StatId, delta: number): boolean {
  const cur = stats[id] ?? CREATE_STAT_MIN;
  const next = cur + delta;
  if (next < CREATE_STAT_MIN || next > CREATE_STAT_MAX) return false;
  if (delta > 0 && statPointsLeft(stats) < delta) return false;
  return true;
}

/** 배분을 규칙 안으로 눌러 담는다 (밖에서 들어온 값을 믿지 않는다). */
export function clampCreateStats(raw: Partial<Record<StatId, number>>): Record<StatId, number> {
  const out = baseCreateStats();
  for (const id of STAT_IDS) {
    const v = raw[id];
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : CREATE_STAT_MIN;
    out[id] = Math.min(CREATE_STAT_MAX, Math.max(CREATE_STAT_MIN, n));
  }
  // 합이 넘치면 뒤에서부터 깎는다 — 넘칠 일은 UI 가 먼저 막지만 계약은 스스로 지킨다.
  let over = statTotal(out) - CREATE_STAT_TOTAL;
  for (let i = STAT_IDS.length - 1; i >= 0 && over > 0; i--) {
    const id = STAT_IDS[i];
    const room = out[id] - CREATE_STAT_MIN;
    const cut = Math.min(room, over);
    out[id] -= cut;
    over -= cut;
  }
  return out;
}

/**
 * 주사위: 남은 점수를 무작위로 흩뿌린다. 한 능력치가 상한에 닿으면 그 자리는 빠지므로 합은 언제나
 * `CREATE_STAT_TOTAL` 이다. `rand` 는 0..1 (테스트가 주입할 수 있게 열어 둔다).
 */
export function rollCreateStats(rand: () => number = Math.random): Record<StatId, number> {
  const out = baseCreateStats();
  let left = CREATE_STAT_POINTS;
  const open: StatId[] = [...STAT_IDS];
  while (left > 0 && open.length > 0) {
    const i = Math.min(open.length - 1, Math.floor(rand() * open.length));
    const id = open[i];
    out[id] += 1;
    left -= 1;
    if (out[id] >= CREATE_STAT_MAX) open.splice(i, 1);
  }
  return out;
}

/** 이름 주사위: `스캐빈저1234`. */
export function rollCallsign(rand: () => number = Math.random): string {
  const n = Math.floor(rand() * (Math.max(1, Math.round(CHAR_NAME_RANDOM_MAX)) + 1));
  return `${DEFAULT_CALLSIGN}${n}`;
}

/** 이름을 쓸 수 있게 다듬는다 (앞뒤 공백 제거 · 길이 제한 · 빈 이름은 기본값). */
export function sanitizeCharacterName(raw: string): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, CHARACTER_NAME_MAX);
  return t || DEFAULT_CALLSIGN;
}

/** 고를 수 있는 시작 임플란트 (전부 처음부터 소유하므로 목록이 곧 전부다). */
export const CREATE_IMPLANT_IDS: readonly ImplantId[] = IMPLANT_IDS;

/**
 * 악센트 팔레트 (2026-09-09). 절차 생성 병사 모델의 천 · 바이저 · 견장에 들어가는 색이라 어두운 함선
 * 조명에서도 실루엣이 읽히는 채도만 고른다. 값을 늘려도 UI 는 그대로 흐른다.
 */
export const ACCENT_COLORS: readonly string[] = [
  '#ff8a5c', '#7fb4ff', '#6ee7a8', '#d9b96a', '#c98cff', '#ff6b8a', '#5fd8e0', '#b6c2cf',
];

export const DEFAULT_ACCENT = ACCENT_COLORS[0];

function zeroSkills(): Record<SkillId, number> {
  const out = {} as Record<SkillId, number>;
  for (const id of SKILL_IDS) out[id] = 0;
  return out;
}

function zeroStats(): Record<StatId, number> {
  const out = {} as Record<StatId, number>;
  for (const id of STAT_IDS) out[id] = 0;
  return out;
}

/**
 * 생성창의 선택을 그대로 담은 새 프로필. `progression/Profile.freshProfile` 과 모양은 같지만 능력치가
 * 생성창의 배분이고 악센트 · 만든 시각이 붙는다. `migrate` 가 읽을 수 있는 현재 버전으로 쓴다.
 */
export function makeCharacterProfile(c: NewCharacter): PlayerProfile {
  const now = Date.now();
  return {
    version: PROFILE_VERSION,
    name: sanitizeCharacterName(c.name),
    level: 1,
    xp: 0,
    statPoints: 0,
    stats: clampCreateStats(c.stats),
    skills: zeroSkills(),
    skillProgress: zeroSkills(),
    implant: (IMPLANT_IDS as readonly string[]).includes(c.implant) ? c.implant : IMPLANT_IDS[0],
    raids: 0,
    extractions: 0,
    statProgress: zeroStats(),
    implants: [],
    accent: /^#[0-9a-fA-F]{6}$/.test(c.accent) ? c.accent : DEFAULT_ACCENT,
    createdAt: now,
    playedAt: now,
  };
}

/**
 * 새 캐릭터를 슬롯에 심는다. 그 슬롯에 남아 있던 세이브는 부르는 쪽이 미리 `deleteSlot` 으로 치운다
 * (빈 칸에서만 생성창이 열리므로 보통은 이미 비어 있다). 쓰기에 실패하면 false — 저장소가 막힌 브라우저다.
 */
export function createCharacterInSlot(slot: SlotId, c: NewCharacter): PlayerProfile | null {
  const profile = makeCharacterProfile(c);
  return writeSlotSave(slot, 'scav.profile', profile) ? profile : null;
}
