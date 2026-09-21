/**
 * src/enemies/parts/RemoteFx.ts — **the visuals a replica plays**.
 *
 * A non-host client runs no AI. It takes the `ee` events the host sends (hit · acid · shell · charge · corpse ·
 * grenade) and builds **only the picture and the sound** here. Changing no game state is this file's contract.
 */
import * as THREE from 'three';
import {
  ENEMY_DEATH_DIRS, TOXIC_RADIUS, type EnemyType,
} from '@/shared';
import { Enemy } from '../Enemy';
import { CombatTarget } from '../Targets';
import { tuple } from '../net/HostSync';
import { type CorpseWireOpts } from '../Corpses';
import { _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero } from '../model';
import type { EnemySystem } from '../EnemySystem';
import type { EnemyGrenadeKind } from '@/shared';

/** `kind` (2026-09-13): an android is `'spark'` (`model.goreKindOf`). */
export function bloodBurst(sys: EnemySystem, point: THREE.Vector3, count: number, dir: THREE.Vector3 | null, kind: 'blood' | 'spark' = 'blood'): void {
  if (!sys.fx) return;
  if (dir) sys.fx.burst(point, count, kind, 4.5, dir, 0.9);
  else sys.fx.burst(point, count, kind, 4);
  }

export function acidVisual(sys: EnemySystem, from: THREE.Vector3, target: CombatTarget, shooterId: number): void {
  sys.acid?.fireAt(from, target.position, shooterId, sys.byId.get(shooterId)?.faction);
  }

/** 2026-09-11 (C-48): `ee acidAt` — a glob the host aimed at a drone / enemy / point; the replica flies the same arc (visual). */
export function acidVisualAt(sys: EnemySystem, from: THREE.Vector3, to: THREE.Vector3, shooterId: number): void {
  sys.acid?.fireAt(from, to, shooterId, sys.byId.get(shooterId)?.faction);
  }

export function rogueShotVisual(sys: EnemySystem, id: number, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void {
  const e = sys.byId.get(id);
  sys.shotFx(from, to, hit ? 1 : 0);
  sys.ctx.bus.emit('enemy:shot', { id, type: e?.type ?? 'rogue', from: from.clone(), to: to.clone(), hit });
  }

export function shellVisual(sys: EnemySystem, sid: number, from: THREE.Vector3, target: THREE.Vector3, flight: number): void {
  sys.shells?.fire(sid, from, target, flight);
  sys.playAudio('bug_attack', from, 1, 0.45);
  sys.ctx.bus.emit('enemy:shellFired', { sid, from: from.clone(), target: target.clone(), flightTime: flight });
  }

export function shellInterceptedRemote(sys: EnemySystem, sid: number, p: THREE.Vector3): void {
  // pop it if it still flies here (local = false: nothing to send back)
  if (!sys.shells?.interceptById(sid, p, false)) sys.onShellIntercepted(sid, p, false);
  }

export function shellLandedRemote(sys: EnemySystem, sid: number, p: THREE.Vector3): void {
  if (!sys.shells) return;
  if (sys.shells.find(sid)) { sys.shells.landById(sid, p); sys.onShellLanded(sid, p); }
  // else: it already landed locally (own simulation) — FX and event were played then
  }

export function chargeVisual(sys: EnemySystem, id: number, target: THREE.Vector3): void {
  const e = sys.byId.get(id);
  if (e) sys.playAudio('bug_attack', e.position, 1.0, 0.4);
  sys.ctx.bus.emit('enemy:chargeStarted', { id, position: e ? e.position : target.clone(), target: target.clone() });
  }

export function toxicVisual(sys: EnemySystem, id: number, p: THREE.Vector3): void {
  sys.toxicFx(p);
  sys.ctx.bus.emit('enemy:toxicBurst', { id, position: p.clone(), radius: TOXIC_RADIUS });
  }

export function corpseSpawnedRemote(sys: EnemySystem, id: number, type: EnemyType, p: THREE.Vector3, weaponId: string | undefined, opts?: CorpseWireOpts): void {
  // Phase 10: the host's `lt` / `dd` win over the local seeded roll (identical seeds agree anyway — this just makes
  // the authority explicit) and the body's own fall direction is corrected to match.
  const e = sys.byId.get(id);
  if (e) {
    if (opts?.lootable !== undefined) e.lootable = opts.lootable;
    if (opts?.deathDir) { e.deathDir = opts.deathDir; e.anim.deathDir = Math.max(0, ENEMY_DEATH_DIRS.indexOf(opts.deathDir)); }
    e.corpsePending = false;
  }
  sys.corpses.add(id, type, p, weaponId, sys.ctx.world?.seed ?? 0, opts);
  }

export function corpseGoneRemote(sys: EnemySystem, id: number): void { sys.corpses.remove(id); }

/** 2026-09-13: `kind` from `ee grenade.k` (the body / blast / fire zone the copy shows), the thrower's faction if we know it. */
export function grenadeVisual(sys: EnemySystem, id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number, kind: EnemyGrenadeKind = 'frag'): void {
  if (!sys.grenades) return;
  const e = sys.byId.get(id);
  sys.grenades.throw(id, p, v, fuse, false, kind, e?.faction ?? 'rogue');
  sys.grenadesThrown++;
  sys.playAudio('grenade_throw', e ? e.position : p, 0.7, 0.95);
  }

/** 2026-09-13: `kind` from `ee grenadeHit.k` (undefined = keep the flying copy's, frag when there is none). */
export function grenadeHitRemote(sys: EnemySystem, p: THREE.Vector3, kind?: EnemyGrenadeKind): void { sys.grenades?.explodeNear(p, kind); }

export function onChargeStarted(sys: EnemySystem, e: Enemy, target: THREE.Vector3): void {
  const ctx = sys.ctx;
  ctx.bus.emit('enemy:chargeStarted', { id: e.id, position: e.position, target: target.clone() });
  if (sys.hosting) ctx.net!.send({ t: 'ee', ev: 'charge', id: e.id, target: tuple(target, 2) }, 'others');
  }

export function playAudio(sys: EnemySystem, id: string, position: THREE.Vector3, volume = 1, pitch = 1): void {
  const now = sys.ctx.time;
  const gap = id === 'bug_step' ? 0.05 : id === 'bug_hit' || id === 'hit_flesh' ? 0.04 : id === 'shot_rifle' ? 0.03 : 0.12;
  const last = sys.lastAudio.get(id);
  if (last !== undefined && now - last < gap) return;
  sys.lastAudio.set(id, now);
  sys.ctx.bus.emit('audio:play', { id, position, volume, pitch });
  }
