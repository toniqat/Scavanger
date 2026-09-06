import * as THREE from 'three';
import {
  MELEE_RANGE, PlayerFlags, FLAME_RANGE, FLAME_CONE_DEG, FLAME_ALT_RANGE, FLAME_ALT_CONE_DEG, SHOCK_RANGE, SHOCK_CONE_DEG, SHOCK_MAX_TARGETS,
  SHOCK_CHARGE_RANGE, SHURIKEN_TRIPLE_SPREAD_DEG, BAZOOKA_ALT_FUSE, BAZOOKA_RADIUS, BAZOOKA_ALT_RADIUS,
  type GameContext, type WeaponDef, type PeerId, type RemotePlayerRef, type EnemyRef, type Vec3Tuple, type FireMessage,
} from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { DEFAULT_RIFLE, DEFAULT_PISTOL, kindOf, shotSoundId, shotPitchFor, weaponClassOf } from './WeaponDefaults';
import { WeaponModel } from './WeaponModel';
import { attachmentVisualsFromIds, sameIds } from './Attachments';
import type { WeaponFx } from './fx/WeaponFx';
import { GRENADE_FUSE, type GrenadeManager } from './Grenade';
import { projectileOptsFor, type ProjectilePool, type ProjectileHit } from './Projectile';
import type { UniqueFx } from './unique/UniqueFx';

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
  /** Phase 6: a continuous unique beam (flame / arc) this peer is holding; `beamUntil` = ctx.time it expires without a refresh. */
  beam: -1 | 0 | 1;
  beamUntil: number;
  beamDir: THREE.Vector3;
  beamOrigin: THREE.Vector3;
  /** Phase 7: attachment def ids last applied to the model (`PlayerSnapshot.att` → `RemotePlayerRef.attachments`). */
  att: readonly string[];
}

/** Phase 7: `RemotePlayerRef.attachments` is appended by net/ — read it duck-typed so an older ref shape still compiles. */
type RefWithAttachments = RemotePlayerRef & { attachments?: readonly string[] | null };
const NO_ATT: readonly string[] = [];

const _muzzle = new THREE.Vector3(), _dir = new THREE.Vector3(), _pd = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
const _end = new THREE.Vector3(), _pos = new THREE.Vector3(), _right = new THREE.Vector3(), _n = new THREE.Vector3(), _to = new THREE.Vector3();
const _mq = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;
/** A continuous beam without a refresh for this long is considered ended (sender sends at 10 Hz + a final c:-1). */
const BEAM_GRACE = 0.35;

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

  private readonly arcEnds: THREE.Vector3[] = [];

  constructor(
    private readonly ctx: GameContext,
    private readonly fx: WeaponFx,
    private readonly grenades: GrenadeManager,
    private readonly projectiles: ProjectilePool,
    private readonly ufx: UniqueFx,
  ) {
    for (let i = 0; i < SHOCK_MAX_TARGETS; i++) this.arcEnds.push(new THREE.Vector3());
  }

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
      e = { id, weaponId: null, def: null, model: null, socket: null, fxBudget: FX_BURST, reloadT: -1, reloadDur: 1, boltT: -1, boltDur: 1, boltSoundT: 0, seen: 0, beam: -1, beamUntil: 0, beamDir: new THREE.Vector3(0, 0, -1), beamOrigin: new THREE.Vector3(), att: NO_ATT };
      this.entries.set(id, e);
    }
    return e;
  }

  /** Build / re-parent / drop the weapon model so it matches the ref's weapon and avatar; then mirror its attachments. */
  private syncModel(e: RemoteEntry, ref: RemotePlayerRef): void {
    const socket = ref.avatar ? ref.avatar.weaponSocket : null;
    if (e.weaponId !== ref.weaponId || e.socket !== socket) {
      if (e.model) { e.model.dispose(); e.model = null; }
      if (e.beam >= 0) this.endBeam(e);
      e.weaponId = ref.weaponId;
      e.socket = socket;
      e.def = ref.weaponId ? this.resolveDef(ref.weaponId) : null;
      e.reloadT = -1; e.boltT = -1; e.boltSoundT = 0;
      e.att = NO_ATT;
      if (e.def && socket) {
        const model = new WeaponModel(e.def);
        socket.add(model.root);
        model.setDraw(1); model.setReload(-1); model.setBolt(-1);
        e.model = model;
      }
    }
    this.syncAttachments(e, ref);
  }

  /**
   * Phase 7: the snapshot's attachment ids (`att`) → `WeaponModel.setAttachments`, rebuilt only when the id set
   * differs from what the model shows (element-wise compare — the ref may hand us a fresh array every snapshot).
   */
  private syncAttachments(e: RemoteEntry, ref: RemotePlayerRef): void {
    if (!e.model) return;
    const ids = (ref as RefWithAttachments).attachments ?? NO_ATT;
    if (sameIds(ids, e.att)) return;
    e.att = ids.length > 0 ? ids.slice() : NO_ATT;
    e.model.setAttachments(attachmentVisualsFromIds(this.ctx, e.att));
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
    if (e.beam >= 0) this.animateBeam(e, ref, model);
    model.update(dt, this.ctx.time);
    // holstered / hidden remotes: unarmed in the hub, inside a launch pod or the hellpod, holding a consumable
    // (stim / grenade in hand), downed, or no weapon equipped
    const f = ref.flags;
    const hidden = (f & (PlayerFlags.IN_HUB | PlayerFlags.IN_POD | PlayerFlags.DROPPING | PlayerFlags.HOLDING_ITEM | PlayerFlags.DOWNED)) !== 0
      || (f & PlayerFlags.HAS_WEAPON) === 0;
    if (hidden) model.root.visible = false;
  }

  private chestOf(ref: RemotePlayerRef): THREE.Vector3 {
    return _pos.copy(ref.position).setY(ref.position.y + 1.3);
  }

  /** Graded ids (`ar23_g3`) resolve through the loot service; if unknown, fall back to the family id, then the built-ins. */
  private resolveDef(weaponId: string): WeaponDef {
    const loot = this.ctx.loot;
    const def = loot?.getWeaponDef(weaponId) ?? loot?.getWeaponDef(weaponId.replace(/_g\d+$/, ''));
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
    // Phase 6: flame / arc / shuriken / bazooka replay from the raw `fire` message (needs `m` / `c`); the bus event
    // drops those fields. Bow / minigun are ordinary shots and stay on this path.
    if (def.unique && def.unique !== 'bow' && def.unique !== 'minigun') { e.fxBudget += 1; return; }
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
        this.projectiles.fire(_muzzle, _pd, def.projectileSpeed, 0, def.range, def.tracerColor, def.id, true, projectileOptsFor(def));
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
      if (kind !== 'energy' && (!def.unique || def.unique === 'minigun') && ref) {
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

  /* ─────────────────────────── Phase 6: unique weapon replay ─────────────────────────── */
  /**
   * Raw `fire` message (carries `m` = alt fire, `c` = charge / spin, `c: -1` = beam ended). Presentation only:
   * flame cone / lightning arcs held until the next refresh (≤ 10 Hz sender) or `BEAM_GRACE`, a charged bolt
   * tracer, a fan of visual shuriken, a visual rocket that pops on impact / fuse (`onVisualProjectileHit`).
   */
  onFireMessage(id: PeerId, msg: FireMessage): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    const e = this.entryFor(id);
    const def = e.def && e.weaponId === msg.w ? e.def : this.resolveDef(msg.w);
    const u = def.unique;
    if (!u || u === 'bow' || u === 'minigun') return;
    const m: 0 | 1 = msg.m === 1 ? 1 : 0;
    const c = typeof msg.c === 'number' ? msg.c : 0;
    if (!this.getMuzzleWorld(id, _muzzle)) _muzzle.set(msg.o[0], msg.o[1], msg.o[2]);
    _dir.set(msg.d[0], msg.d[1], msg.d[2]);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1); else _dir.normalize();

    if (u === 'flamethrower' || (u === 'shockgun' && m === 0)) {
      if (c < 0) { this.endBeam(e); return; }
      const starting = e.beam < 0 || e.beam !== m;
      e.beam = m; e.beamUntil = ctx.time + BEAM_GRACE;
      e.beamDir.copy(_dir); e.beamOrigin.copy(_muzzle);
      if (starting) {
        e.model?.setHeat(1);
        ctx.bus.emit('audio:play', { id: 'shot_energy', position: _muzzle, volume: 0.35, pitch: u === 'flamethrower' ? 0.5 : 1.3 });
      }
      return;
    }
    if (e.fxBudget < 1) return;
    e.fxBudget -= 1;
    if (u === 'shockgun') {
      // charged bolt: thick tracer to the first thing in the way
      const hit = this.visualRaycast(_muzzle, _dir, SHOCK_CHARGE_RANGE, _end, _n);
      if (!hit) _end.copy(_muzzle).addScaledVector(_dir, SHOCK_CHARGE_RANGE);
      const fxm = FxManager.get();
      if (fxm) fxm.tracers.add(_muzzle, _end, def.tracerColor, 0.09, _muzzle.distanceTo(_end) / 600 + 0.06, 600);
      if (hit) this.impactFx(_end, _n, _dir, hit.enemy, hit.obstacle, false);
      this.fx.muzzleFlash(_muzzle, _dir, def.tracerColor, 1.6);
      e.model?.kick(2.2);
      ctx.bus.emit('audio:play', { id: 'shot_energy', position: _muzzle, volume: 0.9, pitch: 0.7 + c * 0.2 });
      return;
    }
    if (u === 'shuriken') {
      const n = m === 1 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        _pd.copy(_dir).applyAxisAngle(_up, n === 1 ? 0 : (i - (n - 1) / 2) * SHURIKEN_TRIPLE_SPREAD_DEG * DEG);
        this.projectiles.fire(_muzzle, _pd, def.projectileSpeed ?? 65, 0, def.range, def.tracerColor, def.id, true, projectileOptsFor(def));
      }
      e.model?.kick(0.6);
      ctx.bus.emit('audio:play', { id: 'melee_swing', position: _muzzle, volume: 0.5, pitch: 1.5 });
      return;
    }
    if (u === 'bazooka') {
      const opts = { ...(projectileOptsFor(def) ?? {}), tag: m, fuse: m === 1 ? BAZOOKA_ALT_FUSE : undefined };
      this.projectiles.fire(_muzzle, _dir, def.projectileSpeed ?? 48, 0, def.range, def.tracerColor, def.id, true, opts);
      this.fx.muzzleFlash(_muzzle, _dir, 0xffb060, 2.2);
      e.model?.kick(3);
      ctx.bus.emit('audio:play', { id: 'shot_shotgun', position: _muzzle, volume: 0.9, pitch: 0.6 });
    }
  }

  /** Per frame while a remote beam is on: cone / arcs from the replica muzzle along the last direction. */
  private animateBeam(e: RemoteEntry, ref: RemotePlayerRef, model: WeaponModel): void {
    const ctx = this.ctx;
    if (ctx.time > e.beamUntil || !e.def) { this.endBeam(e); return; }
    if (!this.getMuzzleWorld(e.id, _muzzle)) _muzzle.copy(e.beamOrigin);
    const dir = e.beamDir;
    const owner = e.id;
    if (e.def.unique === 'flamethrower') {
      const alt = e.beam === 1;
      this.ufx.setFlame(owner, _muzzle, dir, alt ? FLAME_ALT_RANGE : FLAME_RANGE, (alt ? FLAME_ALT_CONE_DEG : FLAME_CONE_DEG) * 0.5 * DEG);
    } else {
      // arcs to the nearest enemies in the replica's view cone (visual only; the host applies the real damage)
      const mgr = ctx.enemies;
      let n = 0;
      if (mgr && typeof mgr.queryNear === 'function') {
        const near = mgr.queryNear(_muzzle, SHOCK_RANGE + 1.5);
        const cosHalf = Math.cos(SHOCK_CONE_DEG * 0.5 * DEG);
        for (let i = 0; i < near.length && n < SHOCK_MAX_TARGETS; i++) {
          const en = near[i];
          if (!en || en.isDead) continue;
          _to.copy(en.position); _to.y += Math.min(en.height * 0.5, 1.4);
          _end.subVectors(_to, _muzzle);
          const d = _end.length();
          if (d > SHOCK_RANGE + en.radius || d < 1e-3) continue;
          if (_end.divideScalar(d).dot(dir) < cosHalf) continue;
          this.arcEnds[n++].copy(_to);
        }
      }
      if (n > 0) this.ufx.setArc(owner, _muzzle, this.arcEnds, n); else this.ufx.release(owner);
    }
    void ref; void model;
  }

  private endBeam(e: RemoteEntry): void {
    if (e.beam < 0) return;
    e.beam = -1;
    e.model?.setHeat(0);
    this.ufx.release(e.id);
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

  /**
   * `melee` message: another player swung. Purely presentational — the swing arc + swoosh, plus a contact
   * sound when the sender says it connected. Damage was already resolved on the swinger's client (and, for
   * enemies, by the host through the normal `hit` request).
   */
  onMelee(id: PeerId, p: Vec3Tuple, d: Vec3Tuple, hit: boolean): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    const e = this.entryFor(id);
    if (e.fxBudget < 1) return;
    e.fxBudget -= 1;
    _pos.set(p[0], p[1], p[2]);
    _dir.set(d[0], d[1], d[2]);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1); else _dir.normalize();
    // body yaw from the swing direction (forward = (-sin yaw, *, -cos yaw))
    const yaw = Math.atan2(-_dir.x, -_dir.z);
    _end.copy(_pos).addScaledVector(_dir, 0.45); _end.y -= 0.2;
    this.fx.meleeArc(_end, yaw, MELEE_RANGE * 0.55);
    ctx.bus.emit('audio:play', { id: 'melee_swing', position: _pos, volume: 0.5 });
    if (hit) {
      _end.copy(_pos).addScaledVector(_dir, MELEE_RANGE * 0.6);
      this.fx.meleeImpact(_end, _dir, true);
      ctx.bus.emit('audio:play', { id: 'melee_hit', position: _end, volume: 0.55 });
    }
  }

  /**
   * `net:remoteGrenade`: replica of another player's grenade — arc, bounce, fuse, explosion FX/audio; **Phase 7**: it
   * damages the local player on explosion (same radius / falloff / friendly-fire rule as our own grenades, see
   * `GrenadeManager.explode`) but never enemies (the thrower's client → host owns that). `fuse` = seconds left when
   * released (cooked); `0` = it went off in the thrower's hand and pops at `position` on the next update.
   */
  onGrenade(position: THREE.Vector3, velocity: THREE.Vector3, fuse?: number): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    this.grenades.throw(position, velocity, true, fuse === undefined ? GRENADE_FUSE : Math.max(0, fuse));
  }

  /** Impact FX for a visual-only projectile replica (ProjectilePool `onVisualHit`). Remote rockets pop (FX only). */
  onVisualProjectileHit(h: ProjectileHit, weaponId?: string): void {
    if (weaponId === 'u_bazooka') {
      const radius = h.tag === 1 ? BAZOOKA_ALT_RADIUS : BAZOOKA_RADIUS;
      _pos.copy(h.point); if (!h.enemy && !h.fused) _pos.addScaledVector(h.normal, 0.25);
      this.fx.explosion(_pos, radius);
      const bus = this.ctx.bus;
      bus.emit('audio:play', { id: 'explosion', position: _pos, volume: 0.9 });
      const me = this.ctx.player;
      if (me) {
        const shake = THREE.MathUtils.clamp(1 - me.position.distanceTo(_pos) / 30, 0, 1);
        if (shake > 0) bus.emit('camera:shake', { intensity: 0.2 + shake * 0.6, duration: 0.35 });
      }
      return;
    }
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
    this.endBeam(e);
    if (e.model) { e.model.dispose(); e.model = null; }
    e.weaponId = null; e.def = null; e.socket = null; e.att = NO_ATT;
    e.reloadT = -1; e.boltT = -1; e.boltSoundT = 0;
  }

  dispose(): void { this.clear(); }
}
