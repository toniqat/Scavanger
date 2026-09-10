import { CHARACTER_SLOTS } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * 캐릭터 세이브 슬롯 (2026-09-09).
 *
 * 그전까지 세이브는 `scav.profile` · `scav.stash` · `scav.meta` · `scav.ship` · `scav.loadout` ·
 * `scav.sessionToken` … 처럼 **슬롯 개념이 없는 단일 키**였다. 캐릭터가 하나뿐이라는 뜻이고, 타이틀의
 * `새 캐릭터로 시작` 이 그 하나를 지우는 것 말고는 할 수 있는 게 없었다. 캐릭터 선택창(3칸)이 생기면서
 * 같은 브라우저에 캐릭터 셋이 나란히 살아야 하므로, **키에 슬롯 접두사를 붙인다**:
 *
 *     scav.profile  →  scav.s1.profile · scav.s2.profile · scav.s3.profile
 *
 * `scav.sessionToken` 도 슬롯별이다 — 릴레이는 토큰으로 서버 프로필(크레딧 · 창고 · 로드아웃 · 진행도 ·
 * 함선)을 찾으므로, 토큰을 나눠야 서버 쪽 캐릭터도 갈라진다. 나누지 않으면 슬롯 2로 접속한 순간 슬롯 1의
 * 서버 프로필을 그대로 내려받는다.
 *
 * **공용(캐릭터가 아닌) 저장**은 접두사를 받지 않는다: 키 바인딩 · 오디오 볼륨 · 화면 설정 · 콘솔 기록.
 * 목록은 `SHARED_KEYS` 다. 이 집합에 없는 `scav.*` 는 전부 캐릭터 데이터로 본다 — 손으로 쓴 목록 대신
 * 접두사 훑기를 쓰는 이유는 `ui/menus/newCharacter` 와 같다: 나중에 추가된 세이브를 빼먹으면 반쪽짜리
 * 캐릭터가 남는다.
 *
 * **시스템은 부팅 때 한 번 저장소를 읽는다.** 그래서 슬롯 전환은 언제나 `window.location.reload()` 를 낀다
 * (`markAutoStart` 로 새로고침 뒤 곧장 함선으로 들어가게 표시해 둔다). 실행 중에 활성 슬롯이 바뀌는 일은 없다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 슬롯 번호는 1 부터 `CHARACTER_SLOTS` 까지. */
export type SlotId = number;

/** 슬롯 수 (data/constants.csv `CHARACTER_SLOTS`). */
export const SLOT_COUNT: number = Math.max(1, Math.round(CHARACTER_SLOTS));

/** 슬롯 번호 전부, 1..SLOT_COUNT. */
export const SLOT_IDS: readonly SlotId[] = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1);

/** 어떤 슬롯으로 부팅할지 (접두사 없는 공용 키). */
export const ACTIVE_SLOT_KEY = 'scav.slot';

/** 새로고침 직후 타이틀을 건너뛰고 바로 함선으로 들어가라는 표시 (sessionStorage). */
export const AUTOSTART_KEY = 'scav.autostart';

/** 캐릭터가 아닌 것 — 슬롯 접두사를 받지 않고, 슬롯을 지워도 살아남는다. */
export const SHARED_KEYS: ReadonlySet<string> = new Set([
  // 2026-09-10: `scav.relay` (= shared/net `RELAY_STORAGE_KEY`) 는 이 PC 가 어느 서버에 붙는지이지 캐릭터
  // 데이터가 아니다 — 키 바인딩 · 오디오와 같은 자리다. 슬롯을 지워도 서버 주소는 남는다.
  'scav.keybinds', 'scav.audio', 'scav.display', 'scav.console.history', 'scav.relay', ACTIVE_SLOT_KEY,
]);

/** `scav.s3.` 같은 이미 네임스페이스된 키를 알아보는 패턴. */
const SLOTTED_RE = /^scav\.s\d+\./;

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__scav_slot_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function clampSlot(n: unknown): SlotId {
  const v = typeof n === 'number' ? n : Number.parseInt(String(n ?? ''), 10);
  if (!Number.isFinite(v)) return 1;
  return Math.min(SLOT_COUNT, Math.max(1, Math.round(v)));
}

/** 한 슬롯이 갖는 키 전부 (그 슬롯 안에서만 훑는다). */
function keysOfSlot(s: Storage, id: SlotId): string[] {
  const prefix = `scav.s${id}.`;
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

/* ── 활성 슬롯 ────────────────────────────────────────────────────────────── */

let cached: SlotId | null = null;

/**
 * 이번 부팅이 쓰는 슬롯. 저장소를 못 읽으면 1 이다. 값은 **부팅 때 한 번** 읽고 캐시한다 — 실행 중에
 * 바뀌면 이미 메모리에 올라온 시스템들과 어긋나기 때문이다.
 */
export function activeSlot(): SlotId {
  if (cached !== null) return cached;
  ensureMigrated();
  const s = storage();
  let id: SlotId = 1;
  if (s) {
    try { id = clampSlot(s.getItem(ACTIVE_SLOT_KEY)); } catch { id = 1; }
  }
  cached = id;
  return id;
}

/**
 * 다음 부팅이 쓸 슬롯을 적는다. **지금 실행 중인 게임에는 영향이 없다** — 부르는 쪽이 곧바로
 * `window.location.reload()` 해야 한다.
 */
export function setActiveSlot(id: SlotId): void {
  const s = storage();
  if (!s) return;
  try { s.setItem(ACTIVE_SLOT_KEY, String(clampSlot(id))); } catch { /* quota / private mode */ }
}

/** 새로고침 뒤 타이틀을 건너뛰라는 표시를 남긴다 (탭 안에서만 산다). */
export function markAutoStart(): void {
  try { window.sessionStorage.setItem(AUTOSTART_KEY, '1'); } catch { /* storage off */ }
}

/** 그 표시를 **한 번** 읽고 지운다. 두 번째 호출은 false. */
export function takeAutoStart(): boolean {
  try {
    const on = window.sessionStorage.getItem(AUTOSTART_KEY) === '1';
    if (on) window.sessionStorage.removeItem(AUTOSTART_KEY);
    return on;
  } catch {
    return false;
  }
}

/* ── 키 ──────────────────────────────────────────────────────────────────── */

/**
 * 세이브 키를 활성 슬롯의 것으로 옮긴다: `scav.profile` → `scav.s2.profile`.
 * 공용 키(`SHARED_KEYS`)와 이미 슬롯이 붙은 키는 그대로 돌려준다 — 두 번 감싸도 안전하다.
 */
export function slotKey(base: string): string {
  return slotKeyFor(activeSlot(), base);
}

/** `slotKey` 와 같지만 슬롯을 지정한다 (캐릭터 선택창이 남의 슬롯을 들여다볼 때). */
export function slotKeyFor(id: SlotId, base: string): string {
  if (SHARED_KEYS.has(base) || SLOTTED_RE.test(base)) return base;
  const rest = base.startsWith('scav.') ? base.slice('scav.'.length) : base;
  return `scav.s${clampSlot(id)}.${rest}`;
}

/* ── 이전 세이브 이관 ─────────────────────────────────────────────────────── */

let migrated = false;

/**
 * 슬롯이 없던 시절의 `scav.*` 세이브를 **슬롯 1** 로 한 번 옮긴다. 접두사 훑기라서 나중에 추가된 세이브도
 * 같이 따라온다. 이미 슬롯이 붙은 키 · 공용 키는 건드리지 않으므로 여러 번 불러도 같다.
 *
 * `slotKey` 가 스스로 부르지만, 부팅 맨 앞(`main.ts`)에서 한 번 명시적으로 부르는 편이 읽기 좋다.
 */
export function ensureMigrated(): void {
  if (migrated) return;
  migrated = true;
  const s = storage();
  if (!s) return;
  const moves: Array<[string, string]> = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith('scav.')) continue;
      if (SHARED_KEYS.has(k) || SLOTTED_RE.test(k)) continue;
      moves.push([k, `scav.s1.${k.slice('scav.'.length)}`]);
    }
    for (const [from, to] of moves) {
      // 슬롯 1에 이미 값이 있으면 그쪽이 최신이다 — 낡은 키는 버린다.
      const v = s.getItem(from);
      if (v !== null && s.getItem(to) === null) s.setItem(to, v);
      s.removeItem(from);
    }
  } catch { /* quota / private mode — 이관 못 해도 새 캐릭터로 계속 갈 수 있다 */ }
}

/* ── 슬롯 카드 ────────────────────────────────────────────────────────────── */

/**
 * 캐릭터 선택창의 칸 하나가 그리는 요약. 별도 색인 파일을 두지 않고 **그 슬롯의 세이브에서 바로 읽는다** —
 * 색인은 언젠가 본체와 어긋나고, 어긋난 색인은 "없는 캐릭터" 나 "빈 칸에 뜬 레벨" 로 보인다.
 */
export interface SlotCard {
  id: SlotId;
  /** 세이브가 없으면 null — 빈 칸이다. */
  name: string | null;
  level: number;
  /** 능력치 다섯. 세이브를 못 읽으면 빈 객체. */
  stats: Record<string, number>;
  /** 병사 모델 악센트 색 (`PlayerProfile.accent`), 없으면 null. */
  accent: string | null;
  implant: string | null;
  credits: number;
  raids: number;
  extractions: number;
  /** epoch ms, 없으면 0. */
  createdAt: number;
  playedAt: number;
}

function readJson(s: Storage, key: string): Record<string, unknown> | null {
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const numOf = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** 한 칸의 요약. 세이브가 없으면 `name: null` 인 빈 칸이 나온다 (throw 하지 않는다). */
export function readSlotCard(id: SlotId): SlotCard {
  const slot = clampSlot(id);
  const empty: SlotCard = {
    id: slot, name: null, level: 1, stats: {}, accent: null, implant: null,
    credits: 0, raids: 0, extractions: 0, createdAt: 0, playedAt: 0,
  };
  ensureMigrated();
  const s = storage();
  if (!s) return empty;
  const p = readJson(s, slotKeyFor(slot, 'scav.profile'));
  if (!p) return empty;
  const stats: Record<string, number> = {};
  const rawStats = p.stats;
  if (rawStats && typeof rawStats === 'object') {
    for (const [k, v] of Object.entries(rawStats as Record<string, unknown>)) stats[k] = numOf(v);
  }
  const meta = readJson(s, slotKeyFor(slot, 'scav.meta'));
  return {
    id: slot,
    name: strOf(p.name) ?? '스캐빈저',
    level: Math.max(1, Math.round(numOf(p.level, 1))),
    stats,
    accent: strOf(p.accent),
    implant: strOf(p.implant),
    credits: Math.max(0, Math.round(numOf(meta?.credits))),
    raids: Math.max(0, Math.round(numOf(p.raids))),
    extractions: Math.max(0, Math.round(numOf(p.extractions))),
    createdAt: Math.max(0, numOf(p.createdAt)),
    playedAt: Math.max(0, numOf(p.playedAt)),
  };
}

/** 세 칸 전부, 1번부터. */
export function readSlotCards(): SlotCard[] {
  return SLOT_IDS.map(readSlotCard);
}

/** 그 칸에 캐릭터가 있는가. */
export function slotOccupied(id: SlotId): boolean {
  return readSlotCard(id).name !== null;
}

/**
 * 한 슬롯의 세이브를 전부 지운다 (`scav.s<id>.*`). 공용 설정은 남는다. 지운 키 목록을 돌려준다.
 * 활성 슬롯을 지웠다면 부르는 쪽이 새로고침해야 이미 메모리에 올라온 시스템들이 따라온다.
 */
export function deleteSlot(id: SlotId): string[] {
  ensureMigrated();
  const s = storage();
  if (!s) return [];
  const slot = clampSlot(id);
  const removed: string[] = [];
  try {
    for (const k of keysOfSlot(s, slot)) { s.removeItem(k); removed.push(k); }
  } catch { /* storage unavailable */ }
  return removed;
}

/** 한 슬롯의 세이브 파일 하나를 직접 쓴다 (캐릭터 생성이 **부팅 전에** 프로필을 심을 때). */
export function writeSlotSave(id: SlotId, base: string, value: unknown): boolean {
  ensureMigrated();
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(slotKeyFor(id, base), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
