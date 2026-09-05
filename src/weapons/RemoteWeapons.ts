import * as THREE from 'three';
import type { GameContext, WeaponDef, PeerId, RemotePlayerRef, EnemyRef } from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { DEFAULT_RIFLE, DEFAULT_PISTOL, kindOf, shotSoundId, shotPitchFor, weaponClassOf } from './WeaponDefaults';
import { WeaponModel } from './WeaponModel';
import type { WeaponFx } from './fx/WeaponFx';
import type { GrenadeManager } from './Grenade';
import type { ProjectilePool, ProjectileHit } from './Projectile';

/** Max replicated shots per second per remote player that produce FX/audio (token bucket, small burst). */
const FX_RATE = 20;
const FX_BURST = 6;
/** Bolt-cycle sound delay after a sniper shot (mirrors WeaponSystem). */
const BOLT_SOUND_DELAY = 0.22;

interface RemoteEntry {
  id: PeerId;
  weaponId: string | null;
  def: WeaponDef | null;
  model: WeaponModel | null;
  /** Socket the model is parented to; re-parented when the avatar is rebuilt. */
  socket: THREE.Object3D | null;
  fxBudget: number;
  reloadT: number;
  reloadDur: number;
  boltT: number;
  boltDur: number;
  boltSoundT: number;
  seen: number;
}

const _muzzle = new THREE.Vector3(), _dir = new THREE.Vector3(), _pd = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
const _end = new THREE.Vector3(), _pos = new THREE.Vector3(), _right = new THREE.Vector3(), _n = new THREE.Vector3();
const _mq = new THREE.Quaternion();

/**
 * Multiplayer view of other players' weapons (only active while `ctx.isMultiplayer && ctx.net`):
 *  - parents a `WeaponModel` matching `RemotePlayerRef.weaponId` into each remote avatar's `weaponSocket`
 *    (identity local transform, same as the local `getWeaponSocket()` convention),
 *  - turns `net:remoteFired / remoteReloaded / remoteGrenade` into muzzle flash, tracers, impact FX,
 *    model kick/reload/bolt animation and `audio:play` — never damage, never `weapon:*` gameplay events.
 * Owned and driven by WeaponSystem.
 */
export class RemoteWeapons {
  private readonly entries = new Map<PeerId, RemoteEntry>();
  private frame = 0;

  constructor(
    private readonly ctx: GameContext,
    private readonly fx: WeaponFx,
    private readonly grenades: GrenadeManager,
    private readonly projectiles: ProjectilePool,
  ) {}

  /* ─────────────────────────── per frame ─────────────────────────── */
  update(dt: number): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!ctx.isMultiplayer || !net) { if (this.entries.size > 0) this.clear(); return; }
    this.frame++;
    const refs = net.getRemotePlayers();
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const e = this.entryFor(ref.id);
      e.seen = this.frame;
      this.syncModel(e, ref);
      e.fxBudget = Math.min(FX_BURST, e.fxBudget + FX_RATE * dt);
      this.animate(e, ref, dt);
    }
    // sweep peers that vanished without an event
    for (const e of this.entries.values()) {
      if (e.seen !== this.frame) { this.disposeEntry(e); this.entries.delete(e.id); }
    }
  }

  private entryFor(id: PeerId): RemoteEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = { id, weaponId: null, def: null, model: null, socket: null, fxBudget: FX_BURST, reloadT: -1, reloadDur: 1, boltT: -1, boltDur: 1, boltSoundT: 0, seen: 0 };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Build / re-parent / drop the weapon model so it matches the ref's weapon and avatar. */
  private syncModel(e: RemoteEntry, ref: RemotePlayerRef): void {
    const socket = ref.avatar ? ref.avatar.weaponSocket : null;
    if (e.weaponId === ref.weaponId && e.socket === socket) return;
    if (e.model) { e.model.dispose(); e.model = null; }
    e.weaponId = ref.weaponId;
    e.socket = socket;
    e.def = ref.weaponId ? this.resolveDef(ref.weaponId) : null;
    e.reloadT = -1; e.boltT = -1; e.boltSoundT = 0;
    if (e.def && socket) {
      const model = new WeaponModel(e.def);
      socket.add(model.root);
      model.setDraw(1); model.setReload(-1); model.setBolt(-1);
      e.model = model;
    }
  }

  private animate(e: RemoteEntry, ref: RemotePlayerRef, dt: number): void {
    const model = e.model;
    if (!model) return;
    if (e.reloadT >= 0) {
      e.reloadT += dt / e.reloadDur;
      if (e.reloadT >= 1) {
        e.reloadT = -1; model.setReload(-1);
        this.ctx.bus.emit('audio:play', { id: 'reload_done', position: this.chestOf(ref), volume: 0.45 });
      } else model.setReload(e.reloadT);
    }
    if (e.boltT >= 0) {
      e.boltT += dt / e.boltDur;
      if (e.boltSoundT > 0) {
        e.boltSoundT -= dt;
        if (e.boltSoundT <= 0) this.ctx.bus.emit('audio:play', { id: 'bolt_cycle', position: this.chestOf(ref), volume: 0.5 });
      }
      if (e.boltT >= 1) { e.boltT = -1; model.setBolt(-1); } else model.setBolt(e.boltT);
    }
    model.update(dt, this.ctx.time);
  }

  private chestOf(ref: RemotePlayerRef): THREE.Vector3 {
    return _pos.copy(ref.position).setY(ref.position.y + 1.3);
  }

  private resolveDef(weaponId: string): WeaponDef {
    const def = this.ctx.loot?.getWeaponDef(weaponId);
    if (def) return def;
    if (weaponId === DEFAULT_PISTOL.id) return DEFAULT_PISTOL;
    return DEFAULT_RIFLE;
  }

  /** World-space muzzle of the weapon model attached to `id`'s avatar, or false when there is none. */
  getMuzzleWorld(id: PeerId, out: THREE.Vector3): boolean {
    const e = this.entries.get(id);
    if (!e || !e.model || !e.model.root.parent) return false;
    e.model.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(e.model.muzzle.matrixWorld);
    return true;
  }

  /* ─────────────────────────── remote events ─────────────────────────── */
  /** `net:remoteFired`: muzzle flash + tracer(s) + visual-only hit test. No damage, no `weapon:*` events. */
  onFired(id: PeerId, weaponId: string, origin: THREE.Vector3, direction: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    const e = this.entryFor(id);
    if (e.fxBudget < 1) return;
    e.fxBudget -= 1;
    const ref = ctx.net.getRemotePlayer(id);
    const def = e.def && e.weaponId === weaponId ? e.def : this.resolveDef(weaponId);
    const cls = weaponClassOf(def);
    const kind = kindOf(def);

    if (!this.getMuzzleWorld(id, _muzzle)) _muzzle.copy(origin);
    _dir.copy(direction);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1); else _dir.normalize();

    const pellets = def.pellets && def.pellets > 1 ? def.pellets : 1;
    const spread = pellets > 1 ? def.spread : 0;
    const fxm = FxManager.get();
    for (let i = 0; i < pellets; i++) {
      randomInCone(_dir, spread, _pd, _tA, _tB);
      if (def.projectileSpeed) {
        this.projectiles.fire(_muzzle, _pd, def.projectileSpeed, 0, def.range, def.tracerColor, def.id, true);
        continue;
      }
      const hit = this.visualRaycast(_muzzle, _pd, def.range, _end, _n);
      if (!hit) _end.copy(_muzzle).addScaledVector(_pd, def.range);
      if (fxm) {
        const len = _muzzle.distanceTo(_end);
        fxm.tracers.add(_muzzle, _end, def.tracerColor, pellets > 1 ? 0.03 : 0.045, len / 420 + 0.045, 420);
      }
      if (hit) this.impactFx(_end, _n, _pd, hit.enemy, hit.obstacle, pellets > 1);
    }

    this.fx.muzzleFlash(_muzzle, _dir, def.tracerColor, pellets > 1 ? 1.6 : 1);
    const model = e.model;
    if (model) {
      model.kick(pellets > 1 ? 2.2 : cls === 'SR' ? 2.6 : 1);
      if (kind !== 'energy' && ref) {
        model.ejectPort.updateWorldMatrix(false, false);
        _pos.setFromMatrixPosition(model.ejectPort.matrixWorld);
        model.ejectPort.getWorldQuaternion(_mq);
        _right.set(1, 0, 0).applyQuaternion(_mq);
        this.fx.casing(_pos, _right, ref.position.y);
      }
      if (cls === 'SR' && e.reloadT < 0) {
        e.boltDur = Math.max(0.3, 1 / def.fireRate - 0.05);
        e.boltT = 0; e.boltSoundT = BOLT_SOUND_DELAY;
        model.setBolt(0);
      }
    }
    ctx.bus.emit('audio:play', { id: shotSoundId(kind), position: _muzzle, volume: 0.9, pitch: shotPitchFor(cls) * (0.95 + Math.random() * 0.1) });
  }

  /** `net:remoteReloaded`: reload animation on the remote model + reload sound at the remote's position. */
  onReloaded(id: PeerId, weaponId: string): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    const e = this.entryFor(id);
    const def = e.def && e.weaponId === weaponId ? e.def : this.resolveDef(weaponId);
    if (e.model) {
      e.reloadT = 0; e.reloadDur = Math.max(0.3, def.reloadTime);
      e.boltT = -1; e.boltSoundT = 0;
      e.model.setBolt(-1); e.model.setReload(0);
    }
    const ref = ctx.net.getRemotePlayer(id);
    ctx.bus.emit('audio:play', { id: 'reload', position: ref ? this.chestOf(ref) : undefined, volume: 0.55 });
  }

  /** `net:remoteGrenade`: visual-only grenade replica (arc, bounce, fuse, explosion FX/audio; no damage). */
  onGrenade(position: THREE.Vector3, velocity: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    this.grenades.throw(position, velocity, true);
  }

  /** Impact FX for a visual-only projectile replica (ProjectilePool `onVisualHit`). */
  onVisualProjectileHit(h: ProjectileHit): void {
    this.impactFx(h.point, h.normal, h.dir, h.enemy, h.obstacle, false);
  }

  /* ─────────────────────────── helpers ─────────────────────────── */
  private readonly rayResult = { enemy: null as EnemyRef | null, obstacle: false };

  /** Nearest of enemy / world raycast → `point`, `normal`; returns hit info or null. Read-only, no damage. */
  private visualRaycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, point: THREE.Vector3, normal: THREE.Vector3): { enemy: EnemyRef | null; obstacle: boolean } | null {
    const ctx = this.ctx;
    const eh = ctx.enemies ? ctx.enemies.raycast(origin, dir, maxDist) : null;
    const wh = ctx.world && ctx.world.ready ? ctx.world.raycast(origin, dir, maxDist) : null;
    const r = this.rayResult;
    if (eh && (!wh || eh.distance <= wh.distance)) {
      point.copy(eh.point); normal.copy(eh.normal); r.enemy = eh.enemy; r.obstacle = false; return r;
    }
    if (wh) {
      point.copy(wh.point); normal.copy(wh.normal); r.enemy = null; r.obstacle = !!wh.obstacle; return r;
    }
    return null;
  }

  private impactFx(point: THREE.Vector3, normal: THREE.Vector3, dir: THREE.Vector3, enemy: EnemyRef | null, obstacle: boolean, light: boolean): void {
    const bus = this.ctx.bus;
    if (enemy) {
      this.fx.impactEnemy(point, dir, false);
      bus.emit('audio:play', { id: 'hit_flesh', position: point, volume: light ? 0.25 : 0.45 });
    } else {
      this.fx.impactSurface(point, normal, obstacle);
      bus.emit('audio:play', { id: obstacle ? 'hit_metal' : 'hit_dirt', position: point, volume: light ? 0.18 : 0.3 });
    }
  }

  /* ─────────────────────────── lifecycle ─────────────────────────── */
  /** Drop one peer's model (`net:remotePlayerRemoved`). */
  remove(id: PeerId): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.disposeEntry(e);
    this.entries.delete(id);
  }

  /** Dispose every remote model (`game:abort`, `game:newMission`, leaving multiplayer). Models are rebuilt lazily. */
  clear(): void {
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
  }

  private disposeEntry(e: RemoteEntry): void {
    if (e.model) { e.model.dispose(); e.model = null; }
    e.weaponId = null; e.def = null; e.socket = null;
    e.reloadT = -1; e.boltT = -1; e.boltSoundT = 0;
  }

  dispose(): void { this.clear(); }
}
