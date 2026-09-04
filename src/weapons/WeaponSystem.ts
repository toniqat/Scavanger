import * as THREE from 'three';
import {
  GameContext, Keys,
  type GameSystem, type WeaponDef, type ItemInstance, type PlayerRef, type PlayerWeaponHost, type EnemyRef,
} from '@/shared';
import { FxManager } from '@/core/fx';
import { damp, randomInCone } from '@/core/util/MathUtil';
import { defaultFor, kindOf, shotSoundId, shotPitchFor, weaponClassOf, damageFalloff, STANCE_ACCURACY } from './WeaponDefaults';
import { WeaponModel } from './WeaponModel';
import { WeaponFx } from './fx/WeaponFx';
import { GrenadeManager } from './Grenade';
import { ProjectilePool, type ProjectileHit } from './Projectile';

type Slot = 'primary' | 'secondary';
type Host = PlayerRef & PlayerWeaponHost;

interface WeaponInstance { uid: string; slot: Slot; def: WeaponDef; model: WeaponModel }
interface AmmoState { ammoInMag: number; reserveRounds: number }

interface HitInfo { point: THREE.Vector3; normal: THREE.Vector3; distance: number; enemy: EnemyRef | null; obstacle: boolean; valid: boolean; headshot: boolean }

const SWAP_TIME = 0.4;
const BLOOM_PER_SHOT = 0.14;
const BLOOM_DECAY = 2.6;
const FIRING_POSE_HOLD = 0.6;
const LOADOUT_FALLBACK_DELAY = 1.0;
const SPRINT_SPREAD_MUL = 1.5;
const MOVING_SPREAD_MUL = 1.35;
/** Delay from the shot to the bolt-cycle sound (sniper). */
const BOLT_SOUND_DELAY = 0.22;

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _pd = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
const _muzzle = new THREE.Vector3(), _target = new THREE.Vector3(), _md = new THREE.Vector3(), _right = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _mq = new THREE.Quaternion();

function makeHit(): HitInfo { return { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, enemy: null, obstacle: false, valid: false, headshot: false }; }

/**
 * Primary/secondary weapons: hitscan & projectile firing from the reticle ray, spread/bloom, recoil,
 * reloads with ammo packs, swap animation, grenades and all weapon FX/events.
 */
export class WeaponSystem implements GameSystem {
  readonly name = 'weapons';

  private ctx!: GameContext;
  private fx!: WeaponFx;
  private grenades!: GrenadeManager;
  private projectiles!: ProjectilePool;

  private readonly slots: Record<Slot, WeaponInstance | null> = { primary: null, secondary: null };
  private readonly ammo = new Map<string, AmmoState>();
  private active: Slot = 'primary';
  private attachedModel: WeaponModel | null = null;

  private phase: 'ready' | 'reloading' | 'swapping' = 'ready';
  private reloadTimer = 0;
  private reloadDuration = 1;
  private swapTimer = 0;
  private swapTarget: Slot = 'primary';
  private swapSwitched = false;

  private cooldown = 0;
  private bloom = 0;
  private firingTimer = 0;
  /** Bolt-action cycle: remaining seconds / total (0 when idle). */
  private boltTimer = 0;
  private boltDuration = 0;
  private boltSoundTimer = 0;
  private zoomSent = { zoom: 1, scope: false };
  private fallbackGrenades = 4;
  private loadoutWait = -1;

  private readonly camHit = makeHit();
  private readonly gunHit = makeHit();
  private readonly weaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false };

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.fx = new WeaponFx(ctx.scene);
    this.grenades = new GrenadeManager(ctx, this.fx);
    this.projectiles = new ProjectilePool(ctx, (h, dmg, weaponId) => this.onProjectileHit(h, dmg, weaponId));

    ctx.bus.on('loadout:changed', (p) => this.onLoadout(p.primary, p.secondary));
    ctx.bus.on('world:ready', () => {
      this.resetTransient();
      this.ammo.clear();
      for (const s of ['primary', 'secondary'] as Slot[]) this.setSlot(s, null);
      this.fallbackGrenades = 4;
      this.loadoutWait = LOADOUT_FALLBACK_DELAY;
    });
    ctx.bus.on('game:abort', () => {
      this.resetTransient();
      for (const s of ['primary', 'secondary'] as Slot[]) this.setSlot(s, null);
      this.loadoutWait = -1;
    });
  }

  update(dt: number, ctx: GameContext): void {
    this.fx.update(dt);
    this.grenades.update(dt);
    this.projectiles.update(dt);

    const host = this.getHost();
    if (!host) return;

    // fallback loadout if no inventory ever speaks
    if (this.loadoutWait > 0) {
      this.loadoutWait -= dt;
      if (this.loadoutWait <= 0 && !this.slots.primary && !this.slots.secondary) {
        this.onLoadout({ uid: 'default-primary', defId: defaultFor('primary').id, qty: 1, rotated: false },
          { uid: 'default-secondary', defId: defaultFor('secondary').id, qty: 1, rotated: false });
      }
    }

    const input = ctx.input;
    const usable = ctx.isGameplayActive() && input.isPointerLocked && host.canUseWeapons() && host.isDiving !== true;
    const weapon = this.slots[this.active];

    if (this.cooldown > 0) this.cooldown -= dt;
    this.bloom = Math.max(0, this.bloom - BLOOM_DECAY * dt);
    if (this.firingTimer > 0) this.firingTimer -= dt;
    this.updateBolt(dt, weapon);

    // ── swap
    if (usable) {
      if (input.wasPressed(Keys.PRIMARY)) this.requestSwap('primary');
      else if (input.wasPressed(Keys.SECONDARY)) this.requestSwap('secondary');
      else if (input.wasPressed(Keys.SWAP)) this.requestSwap(this.active === 'primary' ? 'secondary' : 'primary');
    }
    if (this.phase === 'swapping') this.updateSwap(dt);
    else if (this.phase === 'reloading') this.updateReload(dt);
    else if (weapon && usable) {
      const def = weapon.def;
      const a = this.ammoFor(weapon);
      const trigger = def.automatic ? input.isMouseDown(0) : input.wasMousePressed(0);
      if (input.wasPressed(Keys.RELOAD) && a.ammoInMag < def.magSize) this.tryReload(weapon, a);
      else if (trigger && this.cooldown <= 0 && this.boltTimer <= 0) {
        if (a.ammoInMag > 0) this.fire(host, weapon, a);
        else if (input.wasMousePressed(0) || (def.automatic && this.cooldown <= 0 && !this.dryFlagged)) {
          this.dryFlagged = true;
          ctx.bus.emit('weapon:dryFire', { weaponId: def.id });
          ctx.bus.emit('audio:play', { id: 'dry_fire', volume: 0.6 });
          this.tryReload(weapon, a);
        }
      }
      if (!input.isMouseDown(0)) this.dryFlagged = false;
      if (input.wasPressed(Keys.GRENADE)) this.throwGrenade(host);
    } else if (usable && !weapon && input.wasPressed(Keys.GRENADE)) {
      this.throwGrenade(host);
    }

    // ── model animation & pose state
    for (const s of ['primary', 'secondary'] as Slot[]) this.slots[s]?.model.update(dt, ctx.time);
    const ws = this.weaponState;
    ws.hasWeapon = !!weapon;
    ws.reloading = this.phase === 'reloading';
    ws.firing = this.firingTimer > 0;
    ws.twoHanded = weapon ? weaponClassOf(weapon.def) !== 'PISTOL' : false;
    host.setWeaponState(ws);
  }
  private dryFlagged = false;

  /** Bolt-action cycle after each sniper shot: blocks firing, drives the model's bolt animation and the cycle sound. */
  private updateBolt(dt: number, weapon: WeaponInstance | null): void {
    if (this.boltTimer <= 0) return;
    this.boltTimer -= dt;
    if (this.boltSoundTimer > 0) {
      this.boltSoundTimer -= dt;
      if (this.boltSoundTimer <= 0) this.ctx.bus.emit('audio:play', { id: 'bolt_cycle', volume: 0.7 });
    }
    if (!weapon) { this.boltTimer = 0; return; }
    if (this.boltTimer <= 0) { this.boltTimer = 0; weapon.model.setBolt(-1); return; }
    weapon.model.setBolt(1 - this.boltTimer / this.boltDuration);
  }

  /** Tell the player rig (and HUD) the ADS zoom of the weapon in hand. */
  private applyAimZoom(def: WeaponDef | null): void {
    const zoom = def?.adsZoom ?? 1;
    const scope = !!def?.scope;
    if (this.zoomSent.zoom === zoom && this.zoomSent.scope === scope) return;
    this.zoomSent.zoom = zoom; this.zoomSent.scope = scope;
    const host = this.getHost();
    if (host && typeof host.setAimZoom === 'function') host.setAimZoom(zoom, scope);
    this.ctx.bus.emit('weapon:scopeChanged', { zoom, scope });
  }

  dispose(): void {
    for (const s of ['primary', 'secondary'] as Slot[]) this.setSlot(s, null);
    this.fx.dispose(); this.grenades.dispose(); this.projectiles.dispose();
  }

  /* ─────────────────────────── loadout ─────────────────────────── */
  private getHost(): Host | null {
    const p = this.ctx.player as (PlayerRef & Partial<PlayerWeaponHost>) | null;
    if (!p || typeof p.getWeaponSocket !== 'function' || typeof p.getAimRay !== 'function') return null;
    return p as Host;
  }

  private resolveDef(item: ItemInstance, slot: Slot): WeaponDef {
    const ctx = this.ctx;
    const itemDef = ctx.loot?.getItemDef(item.defId) ?? ctx.inventory?.getDef(item.defId);
    let def: WeaponDef | undefined;
    if (itemDef?.weaponId) def = ctx.loot?.getWeaponDef(itemDef.weaponId);
    if (!def) def = ctx.loot?.getWeaponDef(item.defId);
    if (!def) {
      const d = defaultFor(slot);
      def = (item.defId === d.id) ? d : (defaultFor(slot === 'primary' ? 'secondary' : 'primary').id === item.defId ? defaultFor(slot === 'primary' ? 'secondary' : 'primary') : d);
    }
    return def;
  }

  private onLoadout(primary: ItemInstance | null, secondary: ItemInstance | null): void {
    this.loadoutWait = -1;
    const items: Record<Slot, ItemInstance | null> = { primary, secondary };
    for (const slot of ['primary', 'secondary'] as Slot[]) {
      const item = items[slot];
      const cur = this.slots[slot];
      if (!item) { if (cur) this.setSlot(slot, null); continue; }
      if (cur && cur.uid === item.uid) continue;
      const def = this.resolveDef(item, slot);
      this.setSlot(slot, { uid: item.uid, slot, def, model: new WeaponModel(def) });
      if (!this.ammo.has(item.uid)) this.ammo.set(item.uid, { ammoInMag: def.magSize, reserveRounds: def.magSize * def.reserveMags });
    }
    // make sure something usable is in hand
    if (!this.slots[this.active]) {
      const other: Slot = this.active === 'primary' ? 'secondary' : 'primary';
      if (this.slots[other]) this.active = other;
    }
    if (this.phase === 'reloading') this.cancelReload();
    if (this.phase === 'swapping') { this.phase = 'ready'; }
    this.attachActive(true);
    this.emitGrenadeCount();
  }

  private setSlot(slot: Slot, inst: WeaponInstance | null): void {
    const cur = this.slots[slot];
    if (cur) {
      if (this.attachedModel === cur.model) { cur.model.root.removeFromParent(); this.attachedModel = null; }
      cur.model.dispose();
    }
    this.slots[slot] = inst;
  }

  /** Parent the active weapon model to the hand socket and announce it. */
  private attachActive(announce: boolean): void {
    const host = this.getHost();
    const weapon = this.slots[this.active];
    if (this.attachedModel && (!weapon || this.attachedModel !== weapon.model)) {
      this.attachedModel.root.removeFromParent();
      this.attachedModel = null;
    }
    if (!weapon || !host) { if (announce && !weapon) this.emitEmpty(); if (!weapon) this.applyAimZoom(null); return; }
    if (this.attachedModel !== weapon.model) {
      host.getWeaponSocket().add(weapon.model.root);
      this.attachedModel = weapon.model;
      weapon.model.setDraw(1);
      weapon.model.setReload(-1);
      weapon.model.setBolt(-1);
      this.boltTimer = 0;
    }
    this.applyAimZoom(weapon.def);
    if (announce) {
      const a = this.ammoFor(weapon);
      this.ctx.bus.emit('weapon:equipped', { slot: this.active, weaponId: weapon.def.id, name: weapon.def.name, magSize: weapon.def.magSize, ammoInMag: a.ammoInMag, reserveRounds: a.reserveRounds });
      this.emitAmmo(weapon, a);
    }
  }

  private emitEmpty(): void {
    this.ctx.bus.emit('weapon:equipped', { slot: this.active, weaponId: '', name: '', magSize: 0, ammoInMag: 0, reserveRounds: 0 });
    this.applyAimZoom(null);
  }

  private ammoFor(w: WeaponInstance): AmmoState {
    let a = this.ammo.get(w.uid);
    if (!a) { a = { ammoInMag: w.def.magSize, reserveRounds: w.def.magSize * w.def.reserveMags }; this.ammo.set(w.uid, a); }
    return a;
  }

  private emitAmmo(w: WeaponInstance, a: AmmoState): void {
    this.ctx.bus.emit('weapon:ammoChanged', { weaponId: w.def.id, ammoInMag: a.ammoInMag, magSize: w.def.magSize, reserveRounds: a.reserveRounds });
  }

  /* ─────────────────────────── swap ─────────────────────────── */
  private requestSwap(slot: Slot): void {
    if (this.phase === 'swapping') return;
    if (!this.slots[slot]) return;
    if (slot === this.active && this.attachedModel) return;
    if (this.phase === 'reloading') this.cancelReload();
    this.phase = 'swapping';
    this.boltTimer = 0; this.boltSoundTimer = 0;
    this.slots[this.active]?.model.setBolt(-1);
    this.swapTimer = 0;
    this.swapTarget = slot;
    this.swapSwitched = false;
    this.ctx.bus.emit('audio:play', { id: 'weapon_swap', volume: 0.6 });
  }

  private updateSwap(dt: number): void {
    this.swapTimer += dt;
    const t = Math.min(1, this.swapTimer / SWAP_TIME);
    const cur = this.slots[this.active];
    if (t < 0.5) {
      if (cur && this.attachedModel === cur.model) cur.model.setDraw(1 - t * 2);
    } else {
      if (!this.swapSwitched) {
        this.swapSwitched = true;
        this.active = this.swapTarget;
        this.attachActive(true);
        this.slots[this.active]?.model.setDraw(0);
      }
      this.slots[this.active]?.model.setDraw((t - 0.5) * 2);
    }
    if (t >= 1) { this.phase = 'ready'; this.slots[this.active]?.model.setDraw(1); }
  }

  /* ─────────────────────────── reload ─────────────────────────── */
  private tryReload(w: WeaponInstance, a: AmmoState): void {
    if (this.phase !== 'ready') return;
    if (a.ammoInMag >= w.def.magSize) return;
    if (a.reserveRounds <= 0) {
      const inv = this.ctx.inventory;
      let refilled = false;
      if (inv) {
        const n = inv.consumeWhere((d) => d.category === 'ammo' && d.ammoType === w.def.ammoType, 1);
        refilled = n > 0;
      } else {
        refilled = true; // dev fallback: infinite packs
      }
      if (!refilled) {
        this.ctx.bus.emit('ui:notify', { text: '탄약 없음', kind: 'warning', duration: 1.2 });
        this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
        return;
      }
      a.reserveRounds = w.def.magSize * w.def.reserveMags;
      this.ctx.bus.emit('ui:notify', { text: '탄약 보충', kind: 'info', duration: 1.0 });
      this.emitAmmo(w, a);
    }
    this.phase = 'reloading';
    this.reloadTimer = 0;
    this.reloadDuration = w.def.reloadTime;
    this.boltTimer = 0; this.boltSoundTimer = 0;
    w.model.setBolt(-1);
    w.model.setReload(0);
    this.ctx.bus.emit('weapon:reloadStarted', { weaponId: w.def.id, duration: w.def.reloadTime });
    this.ctx.bus.emit('audio:play', { id: 'reload', volume: 0.8 });
  }

  private updateReload(dt: number): void {
    const w = this.slots[this.active];
    if (!w) { this.phase = 'ready'; return; }
    this.reloadTimer += dt;
    const t = Math.min(1, this.reloadTimer / this.reloadDuration);
    w.model.setReload(t);
    if (t >= 1) {
      const a = this.ammoFor(w);
      const need = w.def.magSize - a.ammoInMag;
      const n = Math.min(need, a.reserveRounds);
      a.ammoInMag += n; a.reserveRounds -= n;
      w.model.setReload(-1);
      this.phase = 'ready';
      this.ctx.bus.emit('weapon:reloadFinished', { weaponId: w.def.id });
      this.ctx.bus.emit('audio:play', { id: 'reload_done', volume: 0.7 });
      this.emitAmmo(w, a);
    }
  }

  private cancelReload(): void {
    this.slots[this.active]?.model.setReload(-1);
    this.phase = 'ready';
  }

  /* ─────────────────────────── firing ─────────────────────────── */
  private fire(host: Host, w: WeaponInstance, a: AmmoState): void {
    const ctx = this.ctx, def = w.def;
    a.ammoInMag--;
    this.cooldown += 1 / def.fireRate;
    if (this.cooldown < 0) this.cooldown = 1 / def.fireRate;
    this.firingTimer = FIRING_POSE_HOLD;

    const cls = weaponClassOf(def);
    const aim = host.isAiming ? 1 : 0;
    const moving = host.velocity.lengthSq() > 0.5;
    const stance = STANCE_ACCURACY[host.stance ?? 'stand'] ?? STANCE_ACCURACY.stand;
    const stanceMul = stance[aim];
    const moveMul = host.isSprinting ? SPRINT_SPREAD_MUL : moving ? MOVING_SPREAD_MUL : 1;
    const spread = THREE.MathUtils.lerp(def.spread, def.adsSpread, aim) * stanceMul * (1 + this.bloom * 1.6) * moveMul;
    this.bloom = Math.min(1, this.bloom + BLOOM_PER_SHOT);
    // bolt-action: lock the trigger for the cycle and animate the bolt
    if (cls === 'SR') {
      this.boltDuration = Math.max(0.3, 1 / def.fireRate - 0.05);
      this.boltTimer = this.boltDuration;
      this.boltSoundTimer = BOLT_SOUND_DELAY;
      w.model.setBolt(0);
    }

    host.getAimRay(_o, _d);
    // muzzle world position (model matrices are one frame old → refresh the chain)
    w.model.muzzle.updateWorldMatrix(true, false);
    _muzzle.setFromMatrixPosition(w.model.muzzle.matrixWorld);
    // don't accept camera-ray hits between camera and player (over-the-shoulder)
    _tmp.copy(host.position); _tmp.y += 1.5;
    const camToPlayer = _tmp.distanceTo(_o) + 0.4;

    const pellets = def.pellets && def.pellets > 1 ? def.pellets : 1;
    let anyHit = false, anyKill = false, anyEnemy = false, anyHead = false;
    for (let i = 0; i < pellets; i++) {
      randomInCone(_d, spread, _pd, _tA, _tB);
      this.raycastAll(_o, _pd, def.range, this.camHit);
      if (this.camHit.valid && this.camHit.distance < camToPlayer) this.camHit.valid = false;
      if (this.camHit.valid) _target.copy(this.camHit.point); else _target.copy(_o).addScaledVector(_pd, def.range);
      _md.subVectors(_target, _muzzle);
      const mdist = _md.length();
      if (mdist < 1e-3) continue;
      _md.divideScalar(mdist);

      if (def.projectileSpeed) {
        this.projectiles.fire(_muzzle, _md, def.projectileSpeed, def.damage, def.range, def.tracerColor, def.id);
        continue;
      }
      this.raycastAll(_muzzle, _md, mdist + 0.05, this.gunHit);
      const hit = this.gunHit.valid ? this.gunHit : (this.camHit.valid ? this.camHit : null);
      const end = hit ? hit.point : _target;
      const fx = FxManager.get();
      if (fx) {
        const len = _muzzle.distanceTo(end);
        fx.tracers.add(_muzzle, end, def.tracerColor, pellets > 1 ? 0.03 : 0.045, len / 420 + 0.045, 420);
      }
      if (hit) {
        const dmg = def.damage * damageFalloff(def, _muzzle.distanceTo(hit.point));
        const r = this.applyHit(hit, dmg, _md, pellets > 1);
        anyHit = true;
        if (hit.enemy) { anyEnemy = true; if (hit.headshot) anyHead = true; }
        if (r) anyKill = true;
      }
    }

    // ── FX & feedback
    this.fx.muzzleFlash(_muzzle, _md, def.tracerColor, pellets > 1 ? 1.6 : 1);
    w.model.ejectPort.updateWorldMatrix(false, false);
    _tmp.setFromMatrixPosition(w.model.ejectPort.matrixWorld);
    w.model.ejectPort.getWorldQuaternion(_mq);
    _right.set(1, 0, 0).applyQuaternion(_mq);
    if (kindOf(def) !== 'energy') this.fx.casing(_tmp, _right, host.position.y);
    w.model.kick(pellets > 1 ? 2.2 : cls === 'SR' ? 2.6 : 1);
    const kick = def.recoil * (0.85 + Math.random() * 0.3) * stanceMul;
    host.addRecoil(kick, (Math.random() - 0.5) * def.recoil * 0.7 * stanceMul);
    if (cls === 'SR') ctx.bus.emit('camera:shake', { intensity: 0.35, duration: 0.18 });

    ctx.bus.emit('weapon:fired', { weaponId: def.id, origin: _muzzle.clone(), direction: _d.clone() });
    this.emitAmmo(w, a);
    ctx.bus.emit('audio:play', { id: shotSoundId(kindOf(def)), position: _muzzle, volume: 1, pitch: shotPitchFor(cls) * (0.95 + Math.random() * 0.1) });
    if (anyEnemy) ctx.bus.emit('ui:hitmarker', { kill: anyKill, headshot: anyHead });
    else if (anyHit && pellets === 1) { /* surface hit: no marker */ }
  }

  /** Nearest of world & enemy raycasts into `out`. */
  private raycastAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitInfo): void {
    const ctx = this.ctx;
    out.valid = false; out.enemy = null; out.obstacle = false; out.headshot = false;
    const eh = ctx.enemies ? ctx.enemies.raycast(origin, dir, maxDist) : null;
    const wh = ctx.world && ctx.world.ready ? ctx.world.raycast(origin, dir, maxDist) : null;
    if (eh && (!wh || eh.distance <= wh.distance)) {
      out.point.copy(eh.point); out.normal.copy(eh.normal); out.distance = eh.distance; out.enemy = eh.enemy; out.valid = true; out.headshot = eh.part === 'head';
    } else if (wh) {
      out.point.copy(wh.point); out.normal.copy(wh.normal); out.distance = wh.distance; out.obstacle = !!wh.obstacle; out.valid = true;
    }
  }

  /** Returns true if the hit killed an enemy. */
  private applyHit(h: HitInfo, damage: number, dir: THREE.Vector3, light: boolean): boolean {
    const ctx = this.ctx;
    if (h.enemy) {
      const e = h.enemy;
      const wasDead = e.isDead;
      e.takeDamage(damage, h.point, dir);
      const killed = !wasDead && e.isDead;
      this.fx.impactEnemy(h.point, dir, killed);
      ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: e.id, damage, killed });
      ctx.bus.emit('audio:play', { id: 'hit_flesh', position: h.point, volume: light ? 0.4 : 0.7 });
      return killed;
    }
    this.fx.impactSurface(h.point, h.normal, h.obstacle);
    ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: null, damage, killed: false });
    ctx.bus.emit('audio:play', { id: h.obstacle ? 'hit_metal' : 'hit_dirt', position: h.point, volume: light ? 0.25 : 0.45 });
    return false;
  }

  private onProjectileHit(h: ProjectileHit, damage: number, weaponId: string): void {
    this.gunHit.point.copy(h.point); this.gunHit.normal.copy(h.normal); this.gunHit.distance = h.distance;
    this.gunHit.enemy = h.enemy; this.gunHit.obstacle = h.obstacle; this.gunHit.valid = true; this.gunHit.headshot = h.part === 'head';
    const def = this.slots.primary?.def.id === weaponId ? this.slots.primary.def
      : this.slots.secondary?.def.id === weaponId ? this.slots.secondary.def : null;
    const dmg = def ? damage * damageFalloff(def, h.distance) : damage;
    const killed = this.applyHit(this.gunHit, dmg, h.dir, false);
    if (h.enemy) this.ctx.bus.emit('ui:hitmarker', { kill: killed, headshot: this.gunHit.headshot });
  }

  /* ─────────────────────────── grenades ─────────────────────────── */
  private throwGrenade(host: Host): void {
    const inv = this.ctx.inventory;
    let count: number;
    if (inv) {
      const n = inv.consumeWhere((d) => d.category === 'grenade', 1);
      if (n <= 0) {
        this.ctx.bus.emit('ui:notify', { text: '수류탄 없음', kind: 'warning', duration: 1.2 });
        this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
        return;
      }
      count = inv.countWhere((d) => d.category === 'grenade');
    } else {
      if (this.fallbackGrenades <= 0) {
        this.ctx.bus.emit('ui:notify', { text: '수류탄 없음', kind: 'warning', duration: 1.2 });
        return;
      }
      count = --this.fallbackGrenades;
    }
    host.getAimRay(_o, _d);
    host.getEyePosition(_tmp);
    _right.set(Math.cos(host.yaw), 0, -Math.sin(host.yaw));
    _tmp.addScaledVector(_d, 0.6).addScaledVector(_right, 0.25);
    _md.copy(_d).multiplyScalar(17).addScaledVector(host.velocity, 0.5);
    _md.y += 3.5;
    this.grenades.throw(_tmp, _md);
    this.firingTimer = FIRING_POSE_HOLD;
    this.ctx.bus.emit('grenade:countChanged', { count });
  }

  private emitGrenadeCount(): void {
    const inv = this.ctx.inventory;
    const count = inv ? inv.countWhere((d) => d.category === 'grenade') : this.fallbackGrenades;
    this.ctx.bus.emit('grenade:countChanged', { count });
  }

  private resetTransient(): void {
    this.grenades.clear();
    this.projectiles.clear();
    this.fx.clear();
    this.phase = 'ready';
    this.cooldown = 0; this.bloom = 0; this.firingTimer = 0;
    this.boltTimer = 0; this.boltSoundTimer = 0;
    this.slots[this.active]?.model.setReload(-1);
    this.slots[this.active]?.model.setBolt(-1);
    this.applyAimZoom(null);
  }
}
