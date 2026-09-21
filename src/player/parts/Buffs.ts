/**
 * src/player/parts/Buffs.ts — **what is on this character right now**
 * (2026-09-12, character buffs).
 *
 * The implementation of `PlayerRef.buffs` / `buffsRevision` / `player:buffsChanged`. The list is **for display and
 * sync** and has no effect — each effect stays at its own source (the meal's `derived` · the prep's `hasEnvPrep` ·
 * the debuff's `applyGymSession` · the pose's `parts/FurniturePose`), and this file only reads them.
 *
 * | kind | key | source | state |
 * |---|---|---|---|
 * | `meal` | `meal` | ship `progression.getMeal()` · raid `getActiveMeal()` | ship `pending` · raid `active` |
 * | `prep` | `prep:<env>` | ship `getPreps()` · raid `getActivePreps()`, env `loot.getItemDef(id).prep.env` | same |
 * | `env_exposed` | `env` | env test (`envKind !== null && !envProtected`, `parts/Statuses.updateEnv`) | `active` |
 * | `gym_fatigue` | `fatigue:<stat>` | `getGymFatigueUntil(stat) > now` | `active`, `startedAt = until − GYM_FATIGUE_HOURS h` · `endsAt = until` |
 * | `rest` | `pose` | pose `sit` | `active` |
 * | `exercise` | `pose` | pose `bench` · `run` · `cycle` (+ `housing.gymSession`'s `stat` · `minigame`) | `active` |
 * | `cooking` | `pose` | pose `cook` (+ `housing.cookSession.mealDefId` → `defId`) — 2026-09-13 | `active` |
 * | `gaming` | `pose` | `housing.gameSession` on the held seat, or standing with `seatUid` null — 2026-09-17 | `active` |
 * | `adrenaline` · `stimulant` | `boost` | `parts/Boosts` (`boostKind` · `boostDefId` · start/end times) | `active` |
 *
 * 2026-09-13 (meal quality): `quality` on `meal` — ship `getMealQuality()` · raid `getActiveMealQuality()`,
 * not carried when 0.
 *
 * Ship / raid is split by `ctx.isRaidActive()` (the same test progression uses to refuse a prep). The time is
 * `ctx.net.serverNow() ?? Date.now()`. Every optional method is called through duck typing.
 *
 * **When it is collected**: events (`progress:mealChanged` · `progress:prepChanged` · `progress:gymFatigue` ·
 * `player:envChanged` · `housing:gymSession` · `game:newMission` · `game:abort` · `game:phaseChanged` ·
 * `hub:entered`) and a pose starting / ending only raise `buffsDirty`, and `updateBuffs` at the end of `update`
 * collects once per frame — changes in the same frame fold into one. On top of that a **1 s tick** (`BUFF_TICK_S`)
 * catches changes that have no event, such as a debuff expiring.
 *
 * **Revision**: the collected list is sorted by `CHAR_BUFF_ORDER` and compared with the current list through
 * `sameCharBuffs`; only when they differ is it swapped for a new array (a clean copy), the revision raised by 1 and
 * `player:buffsChanged` emitted. It starts empty at revision 0, so the first non-empty list is revision 1.
 * While collecting, objects from the pool are reused — nothing is allocated per tick (a copy is made only on change).
 */
import {
  GYM_FATIGUE_HOURS, GYM_STATS, isDebuffKind, sameCharBuffs, sortCharBuffs,
  type CharBuff, type CharBuffKind, type CharBuffState, type GameContext,
} from '@/shared';
import { BUFF_TICK_S } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

/**
 * progression's optional methods — duck typing (when an older implementation or a test double lacks one, the list
 * simply comes out empty).
 */
interface ProgressionView {
  getMeal?(): string | null;
  getActiveMeal?(): string | null;
  getMealQuality?(): number;
  getActiveMealQuality?(): number;
  getPreps?(): readonly string[];
  getActivePreps?(): readonly string[];
  getGymFatigueUntil?(id: string): number;
}

const HOUR_MS = 3600e3;

/** Once in `init`: the events that require the list to be collected again raise `buffsDirty`. */
export function bindBuffs(sys: PlayerSystem, ctx: GameContext): void {
  const dirty = (): void => { sys.buffsDirty = true; };
  const bus = ctx.bus;
  bus.on('progress:mealChanged', dirty);
  bus.on('progress:prepChanged', dirty);
  bus.on('progress:gymFatigue', dirty);
  bus.on('player:envChanged', dirty);
  bus.on('housing:gymSession', dirty);
  bus.on('housing:cookSession', dirty);   // 2026-09-13: the meal for the `cooking` buff (`cookSession.mealDefId`)
  bus.on('housing:gameSession', dirty);   // 2026-09-13: the `gaming` buff (seat pose `sit` + `housing.gameSession`)
  bus.on('game:newMission', dirty);
  bus.on('game:abort', dirty);
  bus.on('game:phaseChanged', dirty);
  bus.on('hub:entered', dirty);
}

/** Every frame at the end of `update`: the 1 s tick + one collect when dirty. */
export function updateBuffs(sys: PlayerSystem, dt: number): void {
  if (dt > 0) sys.buffsTick += dt;
  if (sys.buffsTick >= BUFF_TICK_S) { sys.buffsTick %= BUFF_TICK_S; sys.buffsDirty = true; }
  if (sys.buffsDirty) recomputeBuffs(sys);
}

/** The buff clock (epoch ms) — server time when a relay is there, `Date.now()` otherwise. */
export function buffNow(ctx: GameContext): number {
  const net = ctx.net as { serverNow?(): number } | null;
  if (net && typeof net.serverNow === 'function') {
    const t = net.serverNow();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/**
 * Collects the current list and publishes it if it changed. true when it published (the revision went up). Smokes ·
 * the console call it too (`window.__game.getSystem('player').recomputeBuffs()`).
 */
export function recomputeBuffs(sys: PlayerSystem): boolean {
  sys.buffsDirty = false;
  const ctx = sys.ctx;
  if (!ctx) return false;
  const list = sys.buffScratch;
  list.length = 0;

  const raid = ctx.isRaidActive();
  const state: CharBuffState = raid ? 'active' : 'pending';
  const prog = ctx.progression as unknown as ProgressionView | null;

  // ── Meal · preps (ship = what is loaded for the next raid, raid = what is loaded for this one)
  if (prog) {
    const meal = raid
      ? (typeof prog.getActiveMeal === 'function' ? prog.getActiveMeal() : null)
      : (typeof prog.getMeal === 'function' ? prog.getMeal() : null);
    if (typeof meal === 'string' && meal) {
      const b = take(sys, 'meal', 'meal', state);
      b.defId = meal;
      // 2026-09-13 meal quality — the pending one and this raid's one each carry their own quality (0 = omitted)
      const qf = raid ? prog.getActiveMealQuality : prog.getMealQuality;
      const q = typeof qf === 'function' ? qf.call(prog) : 0;
      if (typeof q === 'number' && Number.isFinite(q) && q >= 1) b.quality = Math.floor(q);
    }

    const preps = raid
      ? (typeof prog.getActivePreps === 'function' ? prog.getActivePreps() : null)
      : (typeof prog.getPreps === 'function' ? prog.getPreps() : null);
    if (preps) {
      for (let i = 0; i < preps.length; i++) {
        const id = preps[i];
        if (typeof id !== 'string' || !id) continue;
        const env = ctx.loot?.getItemDef(id)?.prep?.env ?? null;
        const key = env ? `prep:${env}` : `prep:${id}`;
        // one per env (progression already blocks it, but a duplicate key would break the list)
        if (hasKey(list, key)) continue;
        const b = take(sys, 'prep', key, state);
        b.defId = id;
        if (env) b.env = env;
      }
    }
  }

  // ── Env exposure (the test only stands in a raid — `updateEnv`)
  if (sys.envKind !== null && !sys.envProtected) take(sys, 'env_exposed', 'env', 'active').env = sys.envKind;

  // ── The gym debuff (anywhere, ship or raid, on real time)
  if (prog && typeof prog.getGymFatigueUntil === 'function') {
    const now = buffNow(ctx);
    for (let i = 0; i < GYM_STATS.length; i++) {
      const stat = GYM_STATS[i];
      const until = prog.getGymFatigueUntil(stat);
      if (typeof until !== 'number' || !Number.isFinite(until) || !(until > now)) continue;
      const b = take(sys, 'gym_fatigue', `fatigue:${stat}`, 'active');
      b.stat = stat;
      b.startedAt = Math.max(0, until - GYM_FATIGUE_HOURS * HOUR_MS);
      b.endsAt = until;
    }
  }

  // ── Combat consumables (2026-09-12 — timed inside the raid, `parts/Boosts`): the times are the values Boosts
  //    stamped on the buff clock (whole ms)
  if (sys.boostKind !== null) {
    const b = take(sys, sys.boostKind, 'boost', 'active');
    if (sys.boostDefId) b.defId = sys.boostDefId;
    const s = Math.max(0, Math.round(sys.boostStartedAt)), e = Math.max(0, Math.round(sys.boostEndsAt));
    if (e >= s) { b.startedAt = s; b.endsAt = e; }
  }

  // ── Furniture pose (`rest` · `exercise` · 2026-09-13 `cooking`)
  const f = sys.furn;
  if (f.kind !== null) {
    // 2026-09-13 (user's decision): a game session in the seat in front of the TV is 「게임 중」 rather than rest even
    //   on `sit` — when the seat uid matches, or the pose carries no uid
    const game = f.kind === 'sit' ? (ctx.housing?.gameSession ?? null) : null;
    const gaming = !!game && (!f.furnitureUid || game.seatUid === f.furnitureUid);
    const b = take(sys, gaming ? 'gaming' : f.kind === 'sit' ? 'rest' : f.kind === 'cook' ? 'cooking' : 'exercise', 'pose', 'active');
    b.pose = f.kind;
    if (f.furnitureUid) b.furnitureUid = f.furnitureUid;
    if (gaming && game) {
      b.defId = game.discDefId;
      b.stat = game.stat;
      b.minigame = game.minigame;
    } else if (f.kind === 'cook') {
      // The meal being made — when a cook bench session exists and the uid matches, or the pose carries no uid (the
      //   same rule as the gym session). There is no timer.
      const cook = ctx.housing?.cookSession ?? null;
      if (cook && (!f.furnitureUid || cook.uid === f.furnitureUid) && typeof cook.mealDefId === 'string' && cook.mealDefId) b.defId = cook.mealDefId;
    } else if (f.kind !== 'sit') {
      const session = ctx.housing?.gymSession ?? null;
      if (session && (!f.furnitureUid || session.uid === f.furnitureUid)) {
        b.stat = session.stat;
        b.minigame = session.minigame;
      }
    }
  } else {
    // 2026-09-17 (user's decision): a game session played **standing**, with no seat (`seatUid` null), is 「게임 중」
    //   too — with no pose held it never reaches the clause above
    const game = ctx.housing?.gameSession ?? null;
    if (game && !game.seatUid) {
      const b = take(sys, 'gaming', 'pose', 'active');
      b.defId = game.discDefId;
      b.stat = game.stat;
      b.minigame = game.minigame;
    }
  }

  sortCharBuffs(list);
  if (sameCharBuffs(list, sys._buffs)) return false;
  const out: CharBuff[] = new Array(list.length);
  for (let i = 0; i < list.length; i++) out[i] = cleanCopy(list[i]);
  sys._buffs = out;
  sys._buffsRevision++;
  ctx.bus.emit('player:buffsChanged', { buffs: out, revision: sys._buffsRevision });
  return true;
}

/** Takes one object out of the pool, resets it and puts it on the list. */
function take(sys: PlayerSystem, kind: CharBuffKind, key: string, state: CharBuffState): CharBuff {
  const list = sys.buffScratch, pool = sys.buffPool;
  const i = list.length;
  let b = pool[i];
  if (!b) { b = { kind, key, debuff: false, state }; pool.push(b); }
  b.kind = kind; b.key = key; b.debuff = isDebuffKind(kind); b.state = state;
  b.defId = undefined; b.env = undefined; b.stat = undefined; b.minigame = undefined;
  b.pose = undefined; b.furnitureUid = undefined; b.startedAt = undefined; b.endsAt = undefined; b.quality = undefined;
  list.push(b);
  return b;
}

function hasKey(list: readonly CharBuff[], key: string): boolean {
  for (let i = 0; i < list.length; i++) if (list[i].key === key) return true;
  return false;
}

/** The copy that gets published — only the fields that are set ride (no `undefined` key in the wire JSON). */
function cleanCopy(b: CharBuff): CharBuff {
  const o: CharBuff = { kind: b.kind, key: b.key, debuff: b.debuff, state: b.state };
  if (b.defId !== undefined) o.defId = b.defId;
  if (b.env !== undefined) o.env = b.env;
  if (b.stat !== undefined) o.stat = b.stat;
  if (b.minigame !== undefined) o.minigame = b.minigame;
  if (b.pose !== undefined) o.pose = b.pose;
  if (b.furnitureUid !== undefined) o.furnitureUid = b.furnitureUid;
  if (b.startedAt !== undefined) o.startedAt = b.startedAt;
  if (b.endsAt !== undefined) o.endsAt = b.endsAt;
  if (b.quality !== undefined) o.quality = b.quality;
  return o;
}
