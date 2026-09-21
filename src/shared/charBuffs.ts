/**
 * src/shared/charBuffs.ts — **character buffs** (2026-09-12, user's decision). The decision: `src/player/README.md` Decisions.
 *
 * Collects what is on one character right now — the meal eaten · the preparation loaded · the gym debuff · environment exposure ·
 * resting · exercising — into **one list**. The list is **for display and sync** (user's decision: a buff itself has no game
 * effect). The source of each effect stays where it was — the meal buff is `derived` in `progression`, a preparation is
 * `hasEnvPrep`, a debuff is `applyGymSession`, a pose is `player`.
 *
 *   owner   `player`  — `PlayerRef.buffs` / `buffsRevision` / `player:buffsChanged` (collects progression · housing · its own pose · the environment)
 *   wire    `net`     — `cbuf state` + the snapshot's `bfr` (revision) → `RemotePlayerRef.buffs` / `net:remoteBuffsChanged`
 *   view    `ui`      — the thumbnail row under my hp bar and under a squadmate's hp bar in the bottom-left squad list (icon + time gauge)
 *
 * This file holds **the shape · the names · the order · the validation** only. How the list is filled is player's job, how it is drawn is ui's.
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

/** Buff kinds. Append only (an older client drops a kind it does not know in `sanitizeCharBuffs`). */
export type CharBuffKind =
  | 'meal'          // a meal — ship: what is loaded for the next raid (pending) · raid: what was eaten this time (active)
  | 'prep'          // a preparation — one per environment, the same pending / active rules
  | 'env_exposed'   // debuff: exposed on a permanent-environment planet without the matching preparation, hp draining (raid)
  | 'gym_fatigue'   // debuff: `근육통` (sore muscles) · `심폐 피로` (cardio fatigue) (a real-time timer)
  | 'rest'          // resting — sitting in the rocking chair
  | 'exercise'      // exercising — a gym equipment session
  /* appended (2026-09-12, the 3 consumables) */
  | 'adrenaline'    // an adrenaline shot — timed inside the raid (sim time), item thumbnail + time gauge
  | 'stimulant'     // a stimulant — the same
  /* appended (2026-09-13, the cooking minigame — `src/housing/README.md` Decisions) */
  | 'cooking'       // cooking — the pose in front of the cook bench (`defId` = the meal being made)
  /* appended (2026-09-13, video games — `src/housing/README.md` Decisions, user's decision 「visible to squadmates as a temporary buff, like the gym」) */
  | 'gaming';       // gaming — a game session seated in front of the TV (`defId` = the game disc · `stat` · `minigame`)

export const CHAR_BUFF_KINDS: readonly CharBuffKind[] = ['meal', 'prep', 'env_exposed', 'gym_fatigue', 'rest', 'exercise', 'adrenaline', 'stimulant', 'cooking', 'gaming'];

/** `pending` = loaded in the ship for the next raid (the thumbnail is dimmed) · `active` = on the body right now. */
export type CharBuffState = 'pending' | 'active';

export interface CharBuff {
  kind: CharBuffKind;
  /**
   * A key unique within one character's list — `meal` · `prep:<env>` · `env` · `fatigue:<stat>` · `pose`. ui reuses the
   * thumbnail DOM by this key, and the list comparison (`sameCharBuffs`) also runs in this key's order.
   */
  key: string;
  /** Is this a debuff (`env_exposed` · `gym_fatigue`). Off the wire it is not trusted but decided again from `kind`. */
  debuff: boolean;
  state: CharBuffState;
  /** `meal` · `prep` · `adrenaline` · `stimulant`: the item def id (thumbnail glyph · colour · name). The key of both consumables is `boost`. */
  defId?: string;
  /** `prep` · `env_exposed`: the planet environment. */
  env?: EnvKind;
  /** `gym_fatigue` · `exercise`: the stat. */
  stat?: GymStat;
  /** `exercise`: the minigame. */
  minigame?: GymMinigame;
  /** `rest` · `exercise`: the pose kind. */
  pose?: FurniturePoseKind;
  /** `rest` · `exercise`: the uid of the furniture piece the body was handed to. */
  furnitureUid?: string;
  /** Timer start (epoch ms, `ctx.net.serverNow() ?? Date.now()`) — the full end of the time gauge. Absent = no timer. */
  startedAt?: number;
  /** Timer end (epoch ms) — where the gauge empties. Absent = no timer (meals · preparations · poses). */
  endsAt?: number;
  /** appended (2026-09-13, meal quality): the `meal`'s quality 1 … `MEAL_QUALITY_MAX` (omitted at 0). It hangs on the thumbnail · name as stars. */
  quality?: number;
}

/** Thumbnail order — debuffs first, then what is being done right now, then what is loaded. */
export const CHAR_BUFF_ORDER: readonly CharBuffKind[] = ['env_exposed', 'gym_fatigue', 'adrenaline', 'stimulant', 'exercise', 'gaming', 'cooking', 'rest', 'meal', 'prep'];

export const CHAR_BUFF_LABEL_KO: Readonly<Record<CharBuffKind, string>> = {
  meal: '식사', prep: '준비물', env_exposed: '환경 노출', gym_fatigue: '운동 피로', rest: '휴식 중', exercise: '운동 중',
  adrenaline: '아드레날린', stimulant: '각성제', cooking: '조리 중', gaming: '게임 중',
};

/**
 * Default glyph · colour per kind. For `meal` · `prep` the item def's `icon` · `color` comes first and for `env_exposed`
 * `ENV_ICON` · `ENV_COLOR` does — this table is the place for when neither is found. One Unicode character, as the
 * no-external-asset rule requires.
 */
export const CHAR_BUFF_GLYPH: Readonly<Record<CharBuffKind, string>> = {
  meal: '♨', prep: '⌾', env_exposed: '☣', gym_fatigue: '✱', rest: '☕', exercise: '⚖',
  adrenaline: '↯', stimulant: '◎', cooking: '⊛',
  gaming: '⎚',   // 2026-09-13: the same as the game-console category glyph (`CATEGORY_ICON.console`) — it does not clash with cooking's `⊛` or rest's `☕`
};
export const CHAR_BUFF_COLOR: Readonly<Record<CharBuffKind, string>> = {
  meal: '#ffb0a0', prep: '#ffd08a', env_exposed: '#ff6b6b', gym_fatigue: '#ff8a6b', rest: '#e8a0d0', exercise: '#ff9f7a',
  adrenaline: '#ffd24a', stimulant: '#7ad7ff', cooking: '#ffc890', gaming: '#9ff0c8',
};

export const isDebuffKind = (kind: CharBuffKind): boolean => kind === 'env_exposed' || kind === 'gym_fatigue';

/** A one-line name (the thumbnail's `title` · smokes). `defOf` finds the item name of a meal or a preparation. */
export function charBuffTitle(b: CharBuff, defOf?: (defId: string) => ItemDef | null | undefined): string {
  switch (b.kind) {
    case 'meal':
    case 'prep': {
      let name: string = CHAR_BUFF_LABEL_KO[b.kind];
      if (b.defId && defOf) { try { name = defOf(b.defId)?.name ?? name; } catch { /* keep the label */ } }
      if (b.kind === 'meal' && (b.quality ?? 0) > 0) name = `${name} ${mealQualityStars(b.quality ?? 0)}`;   // 2026-09-13 meal quality
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
    case 'gaming': {
      // 2026-09-13: the game disc's name (the minigame kind when there is none)
      if (b.defId && defOf) { try { const n = defOf(b.defId)?.name; if (n) return `${CHAR_BUFF_LABEL_KO.gaming} · ${n}`; } catch { /* keep the label */ } }
      return b.minigame ? `${CHAR_BUFF_LABEL_KO.gaming} · ${GYM_MINIGAME_LABEL_KO[b.minigame]}` : CHAR_BUFF_LABEL_KO.gaming;
    }
    case 'adrenaline':
    case 'stimulant': {
      if (b.defId && defOf) { try { return defOf(b.defId)?.name ?? CHAR_BUFF_LABEL_KO[b.kind]; } catch { /* keep the label */ } }
      return CHAR_BUFF_LABEL_KO[b.kind];
    }
  }
}

/** Seconds left (null with no timer, 0 once it is over). */
export function charBuffRemainingS(b: CharBuff, nowMs: number): number | null {
  if (typeof b.endsAt !== 'number') return null;
  return Math.max(0, (b.endsAt - nowMs) / 1000);
}

/** The time gauge — the fraction left, 1 (just started) → 0 (over). null with no timer. */
export function charBuffRemainingRatio(b: CharBuff, nowMs: number): number | null {
  if (typeof b.endsAt !== 'number' || typeof b.startedAt !== 'number') return null;
  const span = b.endsAt - b.startedAt;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (b.endsAt - nowMs) / span));
}

/** Sorts in place by `CHAR_BUFF_ORDER` → key and returns the same array. */
export function sortCharBuffs(list: CharBuff[]): CharBuff[] {
  list.sort((a, b) => (CHAR_BUFF_ORDER.indexOf(a.kind) - CHAR_BUFF_ORDER.indexOf(b.kind)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return list;
}

/** Are the two lists the same for display and sync (length · order · every field). Used to decide whether to bump the revision. */
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
 * A **new array** validated out of a list received off the wire — unknown kinds · odd fields · duplicate keys are dropped,
 * `debuff` is decided again from the kind, the list is cut at `CHAR_BUFF_WIRE_MAX` and sorted by `CHAR_BUFF_ORDER`.
 * An empty array when the input is not an array. It never throws.
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
    if (kind === 'meal') { const q = normalizeMealQuality(o.quality); if (q > 0) b.quality = q; }   // 2026-09-13 meal quality
    keys.add(b.key);
    out.push(b);
  }
  return sortCharBuffs(out);
}
