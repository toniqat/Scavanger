/**
 * src/gadgets/parts/Remote.ts — **원격 지뢰(C4)는 언제 · 어떻게 터지는가** (2026-09-11).
 *
 * - 근접 감지로는 **절대** 터지지 않는다. 터지는 길은 소유자의 기폭(`detonateRemoteMines`) 하나뿐이고,
 *   부서지면(`GADGET_REMOTE_MINE_HP`) **불발로** 사라진다 (`Simulate.onDeployableDamage`).
 * - 기폭은 **호스트 권한**이다. 싱글 / 호스트는 바로 터뜨리고, 클라이언트는 `gadq detonate` 를 보내며
 *   호스트는 relay `from` 소유의 무장된 것만 터뜨린다 (`onDetonateRequest`).
 * - **중첩 피해**: 한 번의 기폭에서 대상마다 각 C4 가 줄 피해(중심 `GADGET_REMOTE_MINE_DAMAGE`, 반경
 *   `GADGET_REMOTE_MINE_RADIUS` 선형 감쇠)를 모아, 가장 큰 한 발은 그대로 · 나머지는 **각각**
 *   `× GADGET_REMOTE_MINE_STACK_MUL` 로 더해 **한 번에** 적용한다 (복리 아님). 대상 = 적 · 로컬 플레이어 ·
 *   원격 플레이어(`dmg`) · 드론(`ctx.drones.damageDrone` — `applyExplosion` 은 부르지 않는다, 이중 적용) ·
 *   다른 설치물(`takeDamage`). 폭발 FX · 흔들림 · `explosion` 소리는 C4 마다 따로 난다.
 * - **소유자당 상한** `GADGET_REMOTE_MINE_MAX_LIVE` — 넘으면 그 소유자의 가장 오래된 것부터 사라진다(호스트).
 */
import * as THREE from 'three';
import {
  GADGET_REMOTE_MINE_DAMAGE, GADGET_REMOTE_MINE_MAX_LIVE, GADGET_REMOTE_MINE_RADIUS, GADGET_REMOTE_MINE_STACK_MUL,
  PLAYER_RADIUS,
  type DroneRef, type EnemyRef, type PeerId,
} from '@/shared';
import type { Deployable } from '../Deployable';
import { PLAYER_HALF_H } from '../model';
import type { GadgetSystem } from '../GadgetSystem';

/* ── 표현 전용 값 (게임플레이 수치 아님) ─────────────────────────────────────── */
/** 무장된 C4 가 `c4_beep` 을 내는 간격(초). */
const BEEP_INTERVAL = 4.5;
/** 삑 소리 크기 — 위치 소리라 가까이서만 들린다. */
const BEEP_VOLUME = 0.22;
/** 적 광역 질의 여유(m): `queryNear` 는 캡슐 중심 거리로 거르므로, 몸집이 큰 적의 표면이 반경에 걸리는 경우를 넣으려고 넓혀 묻는다. */
const ENEMY_QUERY_PAD = 4;

/** 대상 종류 — 모은 피해를 어느 경로로 적용하는가. */
const TargetKind = { Enemy: 0, LocalPlayer: 1, RemotePlayer: 2, Drone: 3, Deployable: 4 } as const;
type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];

interface Acc {
  kind: TargetKind;
  ref: unknown;
  /** 가장 센 한 발. */
  max: number;
  /** 모든 발의 합. */
  sum: number;
  /** 가장 센 한 발을 준 C4 (피격 방향 표시용). */
  from: Deployable | null;
}

/* 기폭은 드문 이벤트지만 그래도 버퍼는 재사용한다. */
const _mines: Deployable[] = [];
const _accs = new Map<unknown, Acc>();
const _accPool: Acc[] = [];
let _accUsed = 0;
const _v = new THREE.Vector3();
const _from = new THREE.Vector3();

/** `owner` 가 이 클라이언트의 플레이어인가 (싱글 = `'local'`, 멀티 = 내 peer id). */
export function isLocalOwner(sys: GadgetSystem, owner: PeerId | 'local'): boolean {
  if (owner === 'local') return true;
  const me = sys.ctx.net?.localId;
  return me != null && owner === me;
}

/** 로컬 플레이어 소유로 월드에 남아 있는 원격 지뢰 수 (무장 여부 무관, 제거 중 제외). 매 프레임 불려도 싸다. */
export function liveRemoteMineCount(sys: GadgetSystem): number {
  let n = 0;
  const list = sys.deployables;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.kind === 'remoteMine' && !d.removing && isLocalOwner(sys, d.owner)) n++;
  }
  return n;
}

/**
 * 로컬 플레이어의 무장된 원격 지뢰를 전부 기폭한다. 기폭기 딸깍 소리는 여기서 즉시 난다.
 * 반환 = 터뜨린(클라이언트는 요청한 — 로컬이 아는 무장된 내 것) 개수.
 */
export function detonateRemoteMines(sys: GadgetSystem): number {
  const ctx = sys.ctx;
  if (!ctx.isGameplayPhase()) return 0;
  let live = 0, armed = 0;
  for (const d of sys.deployables) {
    if (d.kind !== 'remoteMine' || d.removing || !isLocalOwner(sys, d.owner)) continue;
    live++;
    if (d.armed) armed++;
  }
  ctx.bus.emit('audio:play', { id: 'c4_detonator_click', volume: 0.8 });
  if (live === 0) return 0;

  if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
    // 클라의 무장 타이머는 호스트보다 늦게 시작하므로, 로컬에서 아직 무장 전이어도 요청은 보낸다
    ctx.net.send({ t: 'gadq', ev: 'detonate' }, 'host');
    if (armed === 0) notArmedYet(sys);
    return armed;
  }
  const n = detonateWhere(sys, null);
  if (n === 0) notArmedYet(sys);
  return n;
}

/** 호스트: `gadq detonate` — 보낸 사람(relay `from`) 소유의 무장된 원격 지뢰만. */
export function onDetonateRequest(sys: GadgetSystem, from: PeerId): void {
  if (!sys.ctx.isAuthority) return;
  detonateWhere(sys, from);
}

function notArmedYet(sys: GadgetSystem): void {
  sys.ctx.bus.emit('ui:notify', { text: '원격 지뢰 무장 중', kind: 'warning', duration: 1.2 });
}

/**
 * 첫 프레임(모든 클라이언트): 설치음 · 삑 위상, 호스트는 소유자당 상한을 건다.
 * 늦게 합류해 `gad sync` 로 받은 것은 이미 무장돼 있으므로 설치음을 내지 않는다.
 */
export function initRemoteMine(sys: GadgetSystem, d: Deployable): void {
  d.remoteInit = true;
  d.beepTimer = BEEP_INTERVAL * (0.35 + Math.random() * 0.65);
  if (!d.armed) sys.ctx.bus.emit('audio:play', { id: 'c4_place', position: d.position, volume: 0.8 });
  if (sys.ctx.isAuthority) enforceCap(sys, d.owner);
}

/** 무장된 C4 의 드문 삑 (모든 클라이언트, 위치 소리). */
export function updateBeep(sys: GadgetSystem, d: Deployable, dt: number): void {
  if (!d.armed || dt <= 0) return;
  d.beepTimer -= dt;
  if (d.beepTimer > 0) return;
  d.beepTimer = BEEP_INTERVAL;
  sys.ctx.bus.emit('audio:play', { id: 'c4_beep', position: d.position, volume: BEEP_VOLUME });
}

/** 소유자당 `GADGET_REMOTE_MINE_MAX_LIVE` — `deployables` 는 설치 순서이므로 앞쪽이 오래된 것이다. */
function enforceCap(sys: GadgetSystem, owner: PeerId | 'local'): void {
  const max = Math.max(1, Math.floor(GADGET_REMOTE_MINE_MAX_LIVE));
  let count = 0;
  for (const d of sys.deployables) if (d.kind === 'remoteMine' && !d.removing && d.owner === owner) count++;
  if (count <= max) return;
  let evicted = 0;
  for (let i = 0; i < sys.deployables.length && count > max; i++) {
    const d = sys.deployables[i];
    if (d.kind !== 'remoteMine' || d.removing || d.owner !== owner) continue;
    sys.remove(d, 'expired');
    count--; evicted++;
    i--;   // remove() splices the array
  }
  if (evicted > 0 && isLocalOwner(sys, owner)) {
    sys.ctx.bus.emit('ui:notify', { text: `원격 지뢰는 ${max}개까지 — 가장 오래된 것이 사라졌다`, kind: 'warning', duration: 1.8 });
  }
}

/* ═══════════════════════════ detonation (authority) ═══════════════════════════ */

/** `peer` null = 로컬 플레이어 소유. 반환 = 터진 개수. */
function detonateWhere(sys: GadgetSystem, peer: PeerId | null): number {
  const ctx = sys.ctx;
  _mines.length = 0;
  for (const d of sys.deployables) {
    if (d.kind !== 'remoteMine' || d.removing || !d.armed) continue;
    if (peer === null ? !isLocalOwner(sys, d.owner) : d.owner !== peer) continue;
    _mines.push(d);
  }
  const count = _mines.length;
  if (count === 0) return 0;
  const owner = _mines[0].owner;
  const localOwned = isLocalOwner(sys, owner);
  /** 킬 크레딧: enemies 의 규약대로 내 것은 'local', 남의 것은 그 peer id. */
  const credit: string = localOwned ? 'local' : String(owner);
  const R = GADGET_REMOTE_MINE_RADIUS;

  // 1) 대상마다 각 C4 의 피해를 모은다 (C4 들이 아직 월드에 있을 때 — 서로를 대상에서 뺀다)
  resetAccs();
  const p = ctx.player;
  const remotes = ctx.net?.getRemotePlayers() ?? [];
  const drones: readonly DroneRef[] = ctx.drones?.getDrones() ?? [];
  for (let m = 0; m < count; m++) {
    const mine = _mines[m];
    const c = mine.position;

    for (const e of sys.enemiesNear(c, R + ENEMY_QUERY_PAD)) {
      if (e.isDead) continue;
      _v.set(e.position.x, e.position.y + e.height * 0.5, e.position.z);
      addHit(TargetKind.Enemy, e, falloff(_v.distanceTo(c) - e.radius), mine);
    }

    if (p && !p.isDead) {
      _v.copy(p.position); _v.y += PLAYER_HALF_H;
      addHit(TargetKind.LocalPlayer, 'local', falloff(_v.distanceTo(c) - PLAYER_RADIUS), mine);
    }
    for (const r of remotes) {
      if (r.isDead || r.stale) continue;
      _v.copy(r.position); _v.y += PLAYER_HALF_H;
      addHit(TargetKind.RemotePlayer, r.id, falloff(_v.distanceTo(c) - PLAYER_RADIUS), mine);
    }

    for (const dr of drones) {
      _v.copy(dr.position);
      if (dr.kind === 'ground') _v.y += dr.height * 0.5;
      addHit(TargetKind.Drone, dr, falloff(_v.distanceTo(c) - dr.radius), mine);
    }

    for (const other of sys.deployables) {
      if (other.removing || !other.destructible) continue;
      if (other.kind === 'remoteMine' && _mines.includes(other)) continue;
      _v.copy(other.position); _v.y += other.centerHeight;
      addHit(TargetKind.Deployable, other, falloff(_v.distanceTo(c)), mine);
    }
  }

  // 2) C4 마다 폭발 FX · 제거 방송 (클라는 `gad remove {destroyed}` 를 받아 같은 폭발 FX 를 그린다)
  for (let m = 0; m < count; m++) {
    const mine = _mines[m];
    sys.blastFx(mine.position, R);
    sys.remove(mine, 'destroyed');
  }

  // 3) 합산 피해를 대상마다 한 번씩. 설치물 피해는 연쇄(바닥 지뢰 폭발)를 부를 수 있어 맨 끝에 둔다.
  const mul = GADGET_REMOTE_MINE_STACK_MUL;
  for (const pass of [0, 1] as const) {
    for (const acc of _accs.values()) {
      if ((acc.kind === TargetKind.Deployable) !== (pass === 1)) continue;
      const total = acc.max + (acc.sum - acc.max) * mul;
      if (!(total > 0) || !acc.from) continue;
      _from.copy(acc.from.position);
      switch (acc.kind) {
        case TargetKind.Enemy: hurtEnemy(acc.ref as EnemyRef, total, credit); break;
        case TargetKind.LocalPlayer: ctx.player?.takeDamage(total, _from.clone()); break;
        case TargetKind.RemotePlayer: sys.hurtRemote(acc.ref as PeerId, total, _from); break;
        case TargetKind.Drone: ctx.drones?.damageDrone((acc.ref as DroneRef).id, total, _from); break;
        case TargetKind.Deployable: {
          const d = acc.ref as Deployable;
          if (!d.removing) d.takeDamage(total, _from);
          break;
        }
      }
    }
  }
  resetAccs();
  _mines.length = 0;

  ctx.bus.emit('gadget:detonated', { count, owner: localOwned ? 'local' : owner });
  return count;
}

/** 거리(표면까지) → 한 발의 피해. 반경 밖이면 0. */
function falloff(dist: number): number {
  const R = GADGET_REMOTE_MINE_RADIUS;
  const d = Math.max(0, dist);
  if (!(R > 0) || d >= R) return 0;
  return GADGET_REMOTE_MINE_DAMAGE * (1 - d / R);
}

function addHit(kind: TargetKind, ref: unknown, dmg: number, mine: Deployable): void {
  if (!(dmg > 0)) return;
  let acc = _accs.get(ref);
  if (!acc) {
    acc = _accUsed < _accPool.length ? _accPool[_accUsed] : (_accPool[_accUsed] = { kind, ref, max: 0, sum: 0, from: null });
    _accUsed++;
    acc.kind = kind; acc.ref = ref; acc.max = 0; acc.sum = 0; acc.from = null;
    _accs.set(ref, acc);
  }
  acc.sum += dmg;
  if (dmg > acc.max) { acc.max = dmg; acc.from = mine; }
}

function resetAccs(): void {
  for (let i = 0; i < _accUsed; i++) { const a = _accPool[i]; a.ref = null; a.from = null; }
  _accUsed = 0;
  _accs.clear();
}

/**
 * 적 피해 + 킬 크레딧. `EnemyRef.takeDamage` 계약에는 공격자 인자가 없지만 enemies 의 구현(`Enemy.takeDamage`)은
 * 4번째 인자로 공격자(`'local'` | PeerId)를 받는다 — 폭발(`explode`)과 같은 호출이다. 인자를 모르는 구현은 그냥 무시한다.
 * 폭발은 부위 배수가 없으므로 맞은 자리 · 방향은 넘기지 않는다.
 */
function hurtEnemy(e: EnemyRef, amount: number, credit: string): void {
  if (e.isDead) return;
  (e as EnemyRef & { takeDamage(a: number, p?: THREE.Vector3, d?: THREE.Vector3, attacker?: string): void })
    .takeDamage(amount, undefined, undefined, credit);
}
