/**
 * src/enemies/named/SniperShot.ts — **Roden's shot · scope glint FX** (2026-09-11).
 *
 * The host (`ai/named/Sniper.fire`) and a replica (`ai/named/Sniper.onSniperEvent`) draw it with the **same function**
 * — fixing one side alone makes the two screens hear different shots. It changes no game state at all (damage is the
 * host's `fireGun` → `dmg`).
 *
 * - Three tracer layers: a thick bright core · a wide faint smoke trail (additive blending, so a dark colour = a thin
 *   haze) · a running flash.
 * - The muzzle flash uses `FlashPool` sprites only — **light intensity 0** (the scene point-light count rule).
 * - Sounds go out through `playSniperAudio` at the **real position**. The distance curve that carries them far is held
 *   by `RANGED_SOUNDS` in `audio/AudioSystem` (`sniper_shot` 900 m · `sniper_glint` 260 m, `floor` for the telegraph).
 */
import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { TargetList } from '../Targets';

/** The minimal shape both `EnemyHost` and `ReplicaHost` satisfy. */
export interface SniperFxHost {
  readonly ctx: GameContext;
  readonly targets: TargetList;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
}

/** An impact point within this distance (m) of the local player shakes the screen (a round that grazed past). */
const NEAR_MISS_SHAKE_M = 8;

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _back = new THREE.Vector3();
const _g = new THREE.Vector3();

/**
 * A sound that carries. **Played at the real position only** — the distance curve of `sniper_shot` / `sniper_glint`
 * (900 m · 260 m, the `floor` that keeps the telegraph audible) is held by `RANGED_SOUNDS` in `audio/AudioSystem`.
 * Pulling the position toward the listener breaks that curve. (It stays a function so the call sites sit in one place.)
 */
export function playSniperAudio(host: SniperFxHost, id: string, at: THREE.Vector3, volume: number, pitch = 1): void {
  host.playAudio(id, at, volume, pitch);
}

/** One anti-materiel round: tracer · muzzle flash · muzzle-brake smoke · dust at the prone spot · impact · report · near-miss shake. */
export function sniperShotFx(host: SniperFxHost, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void {
  const fx = FxManager.get();
  _dir.subVectors(to, from);
  const dist = _dir.length();
  if (dist > 1e-4) _dir.multiplyScalar(1 / dist); else _dir.set(0, 0, 1);
  if (fx) {
    fx.tracers.add(from, to, 0xfff2d6, 0.075, 0.28, 0);                    // core
    fx.tracers.add(from, to, 0x5a5448, 0.26, 0.75, 0);                     // smoke trail
    fx.tracers.add(from, to, 0xffe0a0, 0.13, Math.min(0.6, dist / 900 + 0.06), 900);   // running flash
    fx.flashes.flash(from, 0xffd49a, 0, 2.2, 0.09);                        // light intensity 0 — sprite only
    ParticleBurst.smoke(fx.alpha, from, 8, 0.9, 0x6b6456);
    ParticleBurst.sparks(fx.additive, from, _dir, 5, 8, 0xffd08a);
    // Fired prone, the muzzle blast hits the ground
    const world = host.ctx.world;
    if (world && world.ready) {
      _g.set(from.x, world.getHeightAt(from.x, from.z) + 0.05, from.z);
      if (from.y - _g.y < 1.2) ParticleBurst.dust(fx.alpha, _g, UP, 14, 1.6);
    }
    if (!hit) {
      _back.copy(_dir).negate();
      ParticleBurst.dust(fx.alpha, to, _back, 10, 1.3);
      ParticleBurst.sparks(fx.additive, to, _back, 4, 5);
    }
  }
  playSniperAudio(host, 'sniper_shot', from, 1);
  if (hit) host.playAudio('hit_flesh', to, 0.9, 0.75);
  const dl = host.targets.distToLocal(to);
  if (dl < NEAR_MISS_SHAKE_M) host.ctx.bus.emit('camera:shake', { intensity: 0.35 * (1 - dl / NEAR_MISS_SHAKE_M), duration: 0.25 });
}

/** The scope-glint sound (the glint itself is a sprite in `models/named/SniperLook`). */
export function sniperGlintFx(host: SniperFxHost, at: THREE.Vector3, targetLocal: boolean): void {
  playSniperAudio(host, 'sniper_glint', at, targetLocal ? 0.9 : 0.45);
}
