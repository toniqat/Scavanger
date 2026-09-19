/**
 * src/gadgets/parts/Remote.ts — **when and how a remote mine (C4) goes off** (2026-09-11).
 *
 * - It **never** goes off on proximity. The only path to a detonation is the owner's own
 *   (`detonateRemoteMines`); broken (`GADGET_REMOTE_MINE_HP`) it disappears as a **dud**
 *   (`Simulate.onDeployableDamage`).
 * - The detonation is the **host's authority**. Single-player / the host fires straight away, a client sends
 *   `gadq detonate`, and the host fires only the armed ones owned by the relay `from` (`onDetonateRequest`).
 * - **Stacked damage**: one detonation gathers, per target, what each C4 would deal (centre
 *   `GADGET_REMOTE_MINE_DAMAGE`, radius `GADGET_REMOTE_MINE_RADIUS`, the shared two-step falloff
 *   `shared/explosion`), keeps the strongest hit as it is, adds the rest **each** ×
 *   `GADGET_REMOTE_MINE_STACK_MUL` and applies the total **once** (not compounded). Targets = enemies · the
 *   local player · remote players (`dmg`) · drones (`ctx.drones.damageDrone` — `applyExplosion` is not
 *   called, it would apply twice) · other deployables (`takeDamage`). The blast FX · shake · `explosion`
 *   sound fire once per C4.
 * - **A per-owner live cap** `GADGET_REMOTE_MINE_MAX_LIVE` — over it, that owner's oldest go first (the host).
 */
import * as THREE from 'three';
import {
  GADGET_REMOTE_MINE_DAMAGE, GADGET_REMOTE_MINE_MAX_LIVE, GADGET_REMOTE_MINE_RADIUS, GADGET_REMOTE_MINE_STACK_MUL,
  PLAYER_HEIGHT, PLAYER_RADIUS, blastReachesBody, explosionDamage,
  type DroneRef, type EnemyRef, type PeerId,
} from '@/shared';
import type { DamageSourceWire, PlayerDamageSource } from '@/shared';
import type { Deployable } from '../Deployable';
import { PLAYER_HALF_H } from '../model';
import type { GadgetSystem } from '../GadgetSystem';

/* ── presentation-only values (not gameplay numbers) ────────────────────────── */
/** Seconds between the `c4_beep` an armed C4 gives off. */
const BEEP_INTERVAL = 4.5;
/** Beep volume — a positional sound, so it is only heard nearby. */
const BEEP_VOLUME = 0.22;
/**
 * Enemy area-query margin (m): `queryNear` filters by the distance to the capsule centre, so the query is
 * widened to catch a big enemy whose surface reaches into the radius.
 */
const ENEMY_QUERY_PAD = 4;

/** Target kind — which path the gathered damage is applied through. */
const TargetKind = { Enemy: 0, LocalPlayer: 1, RemotePlayer: 2, Drone: 3, Deployable: 4 } as const;
type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];

interface Acc {
  kind: TargetKind;
  ref: unknown;
  /** The strongest single hit. */
  max: number;
  /** The sum of every hit. */
  sum: number;
  /** The C4 that dealt the strongest hit (for the hit direction). */
  from: Deployable | null;
}

/* A detonation is a rare event, but the buffers are reused all the same. */
const _mines: Deployable[] = [];
const _accs = new Map<unknown, Acc>();
const _accPool: Acc[] = [];
let _accUsed = 0;
const _v = new THREE.Vector3();
const _from = new THREE.Vector3();

/** Is `owner` this client's player (single-player = `'local'`, multiplayer = my peer id)? */
export function isLocalOwner(sys: GadgetSystem, owner: PeerId | 'local'): boolean {
  if (owner === 'local') return true;
  const me = sys.ctx.net?.localId;
  return me != null && owner === me;
}

/* ══ 2026-09-15 (the results screen rework): the source of damage a deployable · gadget did to a player ══
 * It is judged from the victim's side — `self` for my own deployable, `ally` for a squadmate's. One object
 * each is reused (the fire zone asks every frame). */
export const SELF_DAMAGE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'self' });
export const ALLY_DAMAGE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'ally' });
const SELF_DAMAGE_WIRE: DamageSourceWire = Object.freeze({ k: 'self' });
const ALLY_DAMAGE_WIRE: DamageSourceWire = Object.freeze({ k: 'ally' });

/** The local player was hit by `owner`'s deployable. */
export function localVictimSource(sys: GadgetSystem, owner: PeerId | 'local'): PlayerDamageSource {
  return isLocalOwner(sys, owner) ? SELF_DAMAGE_SOURCE : ALLY_DAMAGE_SOURCE;
}

/** The squadmate `victim` was hit by `owner`'s deployable (`dmg.src` — decided here, from the victim's side). */
export function remoteVictimWire(owner: PeerId | 'local', victim: PeerId): DamageSourceWire {
  return owner === victim ? SELF_DAMAGE_WIRE : ALLY_DAMAGE_WIRE;
}

/**
 * Remote mines the local player still owns in the world (armed or not, ones being removed excluded).
 * Cheap enough to call every frame.
 */
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
 * Detonates every armed remote mine of the local player. The detonator click sounds here, immediately.
 * Returns how many went off (on a client, how many were requested — the armed ones of mine it knows about).
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
    // a client's arming timer starts later than the host's, so the request goes out even when nothing is
    // armed locally yet
    ctx.net.send({ t: 'gadq', ev: 'detonate' }, 'host');
    if (armed === 0) notArmedYet(sys);
    return armed;
  }
  const n = detonateWhere(sys, null);
  if (n === 0) notArmedYet(sys);
  return n;
}

/** Host: `gadq detonate` — only the armed remote mines owned by the sender (relay `from`). */
export function onDetonateRequest(sys: GadgetSystem, from: PeerId): void {
  if (!sys.ctx.isAuthority) return;
  detonateWhere(sys, from);
}

function notArmedYet(sys: GadgetSystem): void {
  sys.ctx.bus.emit('ui:notify', { text: '원격 지뢰 무장 중', kind: 'warning', duration: 1.2 });
}

/**
 * The first frame (on every client): the place sound · the beep phase, and on the host the per-owner cap.
 * One a late joiner received through `gad sync` is already armed, so it makes no place sound.
 */
export function initRemoteMine(sys: GadgetSystem, d: Deployable): void {
  d.remoteInit = true;
  d.beepTimer = BEEP_INTERVAL * (0.35 + Math.random() * 0.65);
  if (!d.armed) sys.ctx.bus.emit('audio:play', { id: 'c4_place', position: d.position, volume: 0.8 });
  if (sys.ctx.isAuthority) enforceCap(sys, d.owner);
}

/** The armed C4's occasional beep (every client, a positional sound). */
export function updateBeep(sys: GadgetSystem, d: Deployable, dt: number): void {
  if (!d.armed || dt <= 0) return;
  d.beepTimer -= dt;
  if (d.beepTimer > 0) return;
  d.beepTimer = BEEP_INTERVAL;
  sys.ctx.bus.emit('audio:play', { id: 'c4_beep', position: d.position, volume: BEEP_VOLUME });
}

/** `GADGET_REMOTE_MINE_MAX_LIVE` per owner — `deployables` is in placement order, so the front is oldest. */
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

/** `peer` null = owned by the local player. Returns how many went off. */
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
  /** Kill credit: by the enemies contract, mine is 'local' and someone else's is their peer id. */
  const credit: string = localOwned ? 'local' : String(owner);
  const R = GADGET_REMOTE_MINE_RADIUS;

  // 1) gather each C4's damage per target (while the C4s are still in the world — they exclude each other)
  resetAccs();
  const p = ctx.player;
  const remotes = ctx.net?.getRemotePlayers() ?? [];
  const drones: readonly DroneRef[] = ctx.drones?.getDrones() ?? [];
  for (let m = 0; m < count; m++) {
    const mine = _mines[m];
    const c = mine.position;

    // 2026-09-18: a place that deals damage, so nest eggs count too (`includeProps` true) — the same
    // treatment as a mine blast. This is not picking a target.
    for (const e of sys.enemiesNear(c, R + ENEMY_QUERY_PAD, true)) {
      if (e.isDead) continue;
      // 2026-09-18 (user's decision): a target behind a wall · roof · floor gets no share from this C4
      // (three points on the body; deployables are exempt — their body is the collider)
      if (!blastReachesBody(ctx.world, c, e.position.x, e.position.y, e.position.z, e.height)) continue;
      _v.set(e.position.x, e.position.y + e.height * 0.5, e.position.z);
      addHit(TargetKind.Enemy, e, falloff(_v.distanceTo(c) - e.radius), mine);
    }

    if (p && !p.isDead && blastReachesBody(ctx.world, c, p.position.x, p.position.y, p.position.z, PLAYER_HEIGHT)) {
      _v.copy(p.position); _v.y += PLAYER_HALF_H;
      addHit(TargetKind.LocalPlayer, 'local', falloff(_v.distanceTo(c) - PLAYER_RADIUS), mine);
    }
    for (const r of remotes) {
      if (r.isDead || r.stale) continue;
      if (!blastReachesBody(ctx.world, c, r.position.x, r.position.y, r.position.z, PLAYER_HEIGHT)) continue;
      _v.copy(r.position); _v.y += PLAYER_HALF_H;
      addHit(TargetKind.RemotePlayer, r.id, falloff(_v.distanceTo(c) - PLAYER_RADIUS), mine);
    }

    for (const dr of drones) {
      _v.copy(dr.position);
      if (dr.kind === 'ground') _v.y += dr.height * 0.5;
      if (!blastReachesBody(ctx.world, c, dr.position.x, dr.position.y, dr.position.z, dr.kind === 'ground' ? dr.height : 0)) continue;
      addHit(TargetKind.Drone, dr, falloff(_v.distanceTo(c) - dr.radius), mine);
    }

    for (const other of sys.deployables) {
      if (other.removing || !other.destructible) continue;
      if (other.kind === 'remoteMine' && _mines.includes(other)) continue;
      _v.copy(other.position); _v.y += other.centerHeight;
      addHit(TargetKind.Deployable, other, falloff(_v.distanceTo(c)), mine);
    }
  }

  // 2) the blast FX · removal broadcast per C4 (a client draws the same blast FX from `gad remove {destroyed}`)
  for (let m = 0; m < count; m++) {
    const mine = _mines[m];
    sys.blastFx(mine.position, R);
    sys.remove(mine, 'destroyed');
  }

  // 3) the totalled damage, once per target. Deployable damage can chain (a ground mine going off), so last.
  const mul = GADGET_REMOTE_MINE_STACK_MUL;
  for (const pass of [0, 1] as const) {
    for (const acc of _accs.values()) {
      if ((acc.kind === TargetKind.Deployable) !== (pass === 1)) continue;
      const total = acc.max + (acc.sum - acc.max) * mul;
      if (!(total > 0) || !acc.from) continue;
      _from.copy(acc.from.position);
      switch (acc.kind) {
        case TargetKind.Enemy: hurtEnemy(acc.ref as EnemyRef, total, credit); break;
        case TargetKind.LocalPlayer: ctx.player?.takeDamage(total, _from.clone(), localOwned ? SELF_DAMAGE_SOURCE : ALLY_DAMAGE_SOURCE); break;
        case TargetKind.RemotePlayer: sys.hurtRemote(acc.ref as PeerId, total, _from, remoteVictimWire(owner, acc.ref as PeerId)); break;
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

/**
 * Distance (to the surface) → the damage of one hit. 0 outside the radius.
 * 2026-09-15 (user's decision): the shared two-step falloff (`shared/explosion`) — 100 % over the inner half,
 * a fixed multiplier over the outer band.
 * The stacking is unchanged (the strongest hit + the rest × `GADGET_REMOTE_MINE_STACK_MUL`, not compounded).
 */
function falloff(dist: number): number {
  return explosionDamage(GADGET_REMOTE_MINE_DAMAGE, dist, GADGET_REMOTE_MINE_RADIUS);
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
 * Enemy damage + kill credit. The `EnemyRef.takeDamage` contract has no attacker argument, but the enemies
 * implementation (`Enemy.takeDamage`) takes one as its 4th argument (`'local'` | PeerId) — the same call the
 * explosion (`explode`) makes. An implementation that does not know the argument simply ignores it.
 * An explosion has no hit-location multiplier, so the hit point · direction are not passed.
 */
function hurtEnemy(e: EnemyRef, amount: number, credit: string): void {
  if (e.isDead) return;
  (e as EnemyRef & { takeDamage(a: number, p?: THREE.Vector3, d?: THREE.Vector3, attacker?: string): void })
    .takeDamage(amount, undefined, undefined, credit);
}
