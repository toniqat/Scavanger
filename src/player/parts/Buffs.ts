/**
 * src/player/parts/Buffs.ts — **이 캐릭터에 지금 무엇이 걸려 있는가** (2026-09-12, 캐릭터 버프 — `docs/plans/char-buffs.md` §4).
 *
 * `PlayerRef.buffs` / `buffsRevision` / `player:buffsChanged` 의 구현. 목록은 **표시 · 동기화용**이고 효과가 없다 — 효과의 원본은
 * 제자리(요리 `derived` · 준비물 `hasEnvPrep` · 디버프 `applyGymSession` · 자세 `parts/FurniturePose`)이고 여기는 읽기만 한다.
 *
 * | kind | key | 원본 | state |
 * |---|---|---|---|
 * | `meal` | `meal` | 함선 `progression.getMeal()` · 레이드 `getActiveMeal()` | 함선 `pending` · 레이드 `active` |
 * | `prep` | `prep:<env>` | 함선 `getPreps()` · 레이드 `getActivePreps()` 각각, env = `loot.getItemDef(id).prep.env` | 같다 |
 * | `env_exposed` | `env` | 이 폴더의 환경 판정(`envKind !== null && !envProtected`, `parts/Statuses.updateEnv`) | `active` |
 * | `gym_fatigue` | `fatigue:<stat>` | `getGymFatigueUntil(stat) > now` | `active`, `startedAt = until − GYM_FATIGUE_HOURS h` · `endsAt = until` |
 * | `rest` | `pose` | 가구 자세 `sit` | `active` |
 * | `exercise` | `pose` | 가구 자세 `bench` · `run` · `cycle` (+ `housing.gymSession` 의 `stat` · `minigame`) | `active` |
 *
 * 함선 / 레이드는 `ctx.isRaidActive()` 가 가른다 (progression 이 준비물 사용을 거절하는 기준과 같다). 시각은
 * `ctx.net.serverNow() ?? Date.now()`. 모든 선택 메서드는 덕 타이핑으로 부른다.
 *
 * **언제 모으나**: 이벤트(`progress:mealChanged` · `progress:prepChanged` · `progress:gymFatigue` · `player:envChanged` ·
 * `housing:gymSession` · `game:newMission` · `game:abort` · `game:phaseChanged` · `hub:entered`)와 자세 시작/끝이 `buffsDirty` 만
 * 세우고, `update` 끝의 `updateBuffs` 가 프레임당 한 번 모은다 — 같은 프레임의 변경은 하나로 합쳐진다. 거기에 **1 초 틱**
 * (`BUFF_TICK_S`)이 디버프 만료처럼 이벤트가 없는 변화를 잡는다.
 *
 * **리비전**: 모은 목록을 `CHAR_BUFF_ORDER` 로 정렬해 `sameCharBuffs` 로 지금 목록과 비교하고, 다를 때만 새 배열(깨끗한 복사본)로
 * 갈아 끼우고 리비전 +1 · `player:buffsChanged`. 처음은 빈 배열 · 리비전 0 이라 첫 비지 않은 목록이 리비전 1 이다.
 * 모으는 동안에는 풀의 객체를 다시 쓴다 — 틱마다 할당하지 않는다(바뀔 때만 복사본을 만든다).
 */
import {
  GYM_FATIGUE_HOURS, GYM_STATS, isDebuffKind, sameCharBuffs, sortCharBuffs,
  type CharBuff, type CharBuffKind, type CharBuffState, type GameContext,
} from '@/shared';
import { BUFF_TICK_S } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

/** progression 의 선택 메서드 — 덕 타이핑 (옛 구현 · 테스트 대역에서 빠져 있어도 목록이 비는 것으로 끝난다). */
interface ProgressionView {
  getMeal?(): string | null;
  getActiveMeal?(): string | null;
  getPreps?(): readonly string[];
  getActivePreps?(): readonly string[];
  getGymFatigueUntil?(id: string): number;
}

const HOUR_MS = 3600e3;

/** `init` 에서 한 번: 목록을 다시 모아야 하는 사건들이 `buffsDirty` 를 세운다. */
export function bindBuffs(sys: PlayerSystem, ctx: GameContext): void {
  const dirty = (): void => { sys.buffsDirty = true; };
  const bus = ctx.bus;
  bus.on('progress:mealChanged', dirty);
  bus.on('progress:prepChanged', dirty);
  bus.on('progress:gymFatigue', dirty);
  bus.on('player:envChanged', dirty);
  bus.on('housing:gymSession', dirty);
  bus.on('game:newMission', dirty);
  bus.on('game:abort', dirty);
  bus.on('game:phaseChanged', dirty);
  bus.on('hub:entered', dirty);
}

/** `update` 끝에서 매 프레임: 1 초 틱 + 더러우면 한 번 모은다. */
export function updateBuffs(sys: PlayerSystem, dt: number): void {
  if (dt > 0) sys.buffsTick += dt;
  if (sys.buffsTick >= BUFF_TICK_S) { sys.buffsTick %= BUFF_TICK_S; sys.buffsDirty = true; }
  if (sys.buffsDirty) recomputeBuffs(sys);
}

/** 버프 시계 (epoch ms) — 릴레이가 있으면 서버 시각, 없으면 `Date.now()`. */
export function buffNow(ctx: GameContext): number {
  const net = ctx.net as { serverNow?(): number } | null;
  if (net && typeof net.serverNow === 'function') {
    const t = net.serverNow();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/**
 * 지금 목록을 모아 바뀌었으면 게시한다. 게시했으면 true (리비전이 올랐다). 스모크 · 콘솔도 부른다
 * (`window.__game.getSystem('player').recomputeBuffs()`).
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

  // ── 식사 · 준비물 (함선 = 다음 레이드에 실린 것, 레이드 = 이번에 실린 것)
  if (prog) {
    const meal = raid
      ? (typeof prog.getActiveMeal === 'function' ? prog.getActiveMeal() : null)
      : (typeof prog.getMeal === 'function' ? prog.getMeal() : null);
    if (typeof meal === 'string' && meal) take(sys, 'meal', 'meal', state).defId = meal;

    const preps = raid
      ? (typeof prog.getActivePreps === 'function' ? prog.getActivePreps() : null)
      : (typeof prog.getPreps === 'function' ? prog.getPreps() : null);
    if (preps) {
      for (let i = 0; i < preps.length; i++) {
        const id = preps[i];
        if (typeof id !== 'string' || !id) continue;
        const env = ctx.loot?.getItemDef(id)?.prep?.env ?? null;
        const key = env ? `prep:${env}` : `prep:${id}`;
        if (hasKey(list, key)) continue;   // 환경당 하나 (progression 이 이미 막지만 키가 겹치면 목록이 깨진다)
        const b = take(sys, 'prep', key, state);
        b.defId = id;
        if (env) b.env = env;
      }
    }
  }

  // ── 환경 노출 (레이드에서만 판정이 선다 — `updateEnv`)
  if (sys.envKind !== null && !sys.envProtected) take(sys, 'env_exposed', 'env', 'active').env = sys.envKind;

  // ── 운동 디버프 (함선 · 레이드 어디서든, 현실 시간)
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

  // ── 가구 자세 (휴식 중 · 운동 중)
  const f = sys.furn;
  if (f.kind !== null) {
    const b = take(sys, f.kind === 'sit' ? 'rest' : 'exercise', 'pose', 'active');
    b.pose = f.kind;
    if (f.furnitureUid) b.furnitureUid = f.furnitureUid;
    if (f.kind !== 'sit') {
      const session = ctx.housing?.gymSession ?? null;
      if (session && (!f.furnitureUid || session.uid === f.furnitureUid)) {
        b.stat = session.stat;
        b.minigame = session.minigame;
      }
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

/** 풀에서 객체 하나를 꺼내 초기화하고 목록에 넣는다. */
function take(sys: PlayerSystem, kind: CharBuffKind, key: string, state: CharBuffState): CharBuff {
  const list = sys.buffScratch, pool = sys.buffPool;
  const i = list.length;
  let b = pool[i];
  if (!b) { b = { kind, key, debuff: false, state }; pool.push(b); }
  b.kind = kind; b.key = key; b.debuff = isDebuffKind(kind); b.state = state;
  b.defId = undefined; b.env = undefined; b.stat = undefined; b.minigame = undefined;
  b.pose = undefined; b.furnitureUid = undefined; b.startedAt = undefined; b.endsAt = undefined;
  list.push(b);
  return b;
}

function hasKey(list: readonly CharBuff[], key: string): boolean {
  for (let i = 0; i < list.length; i++) if (list[i].key === key) return true;
  return false;
}

/** 게시용 복사본 — 정해진 필드만 싣는다 (와이어 JSON 에 `undefined` 키가 남지 않게). */
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
  return o;
}
