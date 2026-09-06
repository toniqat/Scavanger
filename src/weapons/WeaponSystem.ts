import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, WEAPON_DURABILITY_PER_SHOT, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY,
  IMPLANT_OVERCHARGE_FIRERATE_MUL,
  QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive, QUICK_WHEEL_HOLD, QUICK_WHEEL_DRAG_PX, GRENADE_FUSE, GRENADE_COOK_MAX, GRENADE_UNDERHAND_SPEED_MUL,
  type GameSystem, type WeaponDef, type ItemInstance, type ItemDef, type PlayerRef, type PlayerWeaponHost, type EnemyRef, type Vec3Tuple,
  type WeaponSlot, type EffectiveWeaponStats, type SocketSlot, type WeaponClass, type GadgetId,
} from '@/shared';
import type { Obstacle as WorldObstacle, InterceptableRef } from '@/shared';
import { ARMOR_IMMUNE_AMMO } from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { WEAPON_SLOTS, defaultFor, kindOf, shotSoundId, shotPitchFor, weaponClassOf, damageFalloff, statsFromDef, STANCE_ACCURACY } from './WeaponDefaults';
import { WeaponModel, type WeaponAttachmentVisuals } from './WeaponModel';
import { WeaponFx } from './fx/WeaponFx';
import { GrenadeManager } from './Grenade';
import { ProjectilePool, projectileOptsFor, type ProjectileHit } from './Projectile';
import { RemoteWeapons } from './RemoteWeapons';
import { MeleeController } from './Melee';
import { raycastBlockers } from './Blocking';
import { createUniqueHandler, UniqueFx, type UniqueHandler, type UniqueInput, type UniqueServices, type UniqueShot, type UniqueWeapon } from './unique';

type Host = PlayerRef & PlayerWeaponHost;

/**
 * A weapon held in one of the three slots. `inst` is the inventory's own `ItemInstance` (shared reference) —
 * `ammoInMag` / `durability` live on it so they travel with the item (drop, pickup, stash); `stats` are the
 * graded + socketed numbers the weapon fires with (`ctx.loot.getEffectiveStats`).
 */
interface WeaponInstance {
  uid: string;
  slot: WeaponSlot;
  def: WeaponDef;
  inst: ItemInstance;
  stats: EffectiveWeaponStats;
  model: WeaponModel;
  /** Phase 6: behaviour handler for `def.unique` weapons (null for regular guns). */
  unique: UniqueHandler | null;
  /** Continuous weapons: fractional ammo / durability spent since the last whole unit was written. */
  ammoFrac: number;
  durFrac: number;
}

interface HitInfo { point: THREE.Vector3; normal: THREE.Vector3; distance: number; enemy: EnemyRef | null; obstacle: boolean; valid: boolean; headshot: boolean; obstacleRef: WorldObstacle | null; armored: boolean; intercept: InterceptableRef | null }

const BLOOM_PER_SHOT = 0.14;
const BLOOM_DECAY = 2.6;
const FIRING_POSE_HOLD = 0.6;
const LOADOUT_FALLBACK_DELAY = 1.0;
const SPRINT_SPREAD_MUL = 1.5;
const MOVING_SPREAD_MUL = 1.35;
/** Delay from the shot to the bolt-cycle sound (sniper). */
const BOLT_SOUND_DELAY = 0.22;
/** Min seconds between "내구도 소진" toasts. */
const BROKEN_NOTIFY_INTERVAL = 2.0;
/** Gun draw-down time when a consumable is taken into the hand (F). */
const QUICK_HOLSTER_TIME = 0.15;
/** Seconds between two stim injections / grenade wind-ups. */
const QUICK_USE_COOLDOWN = 0.4;
/** Shortest fuse a cooked grenade leaves the hand with. */
const GRENADE_MIN_FUSE = 0.15;
/** Overhand throw speed / lift (pre-Phase 2 numbers). */
const GRENADE_THROW_SPEED = 17;
const GRENADE_THROW_LIFT = 3.5;
const GRENADE_UNDERHAND_LIFT = 1.2;

type QuickKind = 'stim' | 'grenade' | 'gadget';

/** A consumable taken into the hand from a quick slot (`active = 'quick'`): the bag's own `ItemInstance` plus its def. */
interface QuickHand {
  index: number;
  uid: string;
  defId: string;
  item: ItemInstance;
  def: ItemDef;
  kind: QuickKind;
}

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _pd = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();
const _muzzle = new THREE.Vector3(), _target = new THREE.Vector3(), _md = new THREE.Vector3(), _right = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _netDir = new THREE.Vector3();
const _mq = new THREE.Quaternion();
const _block = new THREE.Vector3();

function makeHit(): HitInfo { return { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, enemy: null, obstacle: false, valid: false, headshot: false, obstacleRef: null, armored: false, intercept: null }; }

/** Vector3 → wire tuple rounded to 3 dp (fresh tuples: messages are serialized asynchronously by the relay). */
function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/**
 * Three weapon slots (주무기 I / 주무기 II / 보조무기): hitscan & projectile firing from the reticle ray with
 * graded + socketed effective stats, spread/bloom, recoil, durability, ammo v2 (reserve = calibre rounds in the
 * bag, magazine on the item), reloads, swap animation, grenades and all weapon FX/events.
 */
export class WeaponSystem implements GameSystem {
  readonly name = 'weapons';

  private ctx!: GameContext;
  private fx!: WeaponFx;
  private grenades!: GrenadeManager;
  private projectiles!: ProjectilePool;
  /** Multiplayer: remote players' weapon models + replicated fire/reload/grenade FX (inert offline). */
  private remote!: RemoteWeapons;
  /** Tactical kit: F melee attack — the player owns stamina / cooldown / pose, this owns the hit resolution. */
  private melee!: MeleeController;
  /** Phase 6: pooled flame cones / lightning arcs shared by the local uniques and remote replicas. */
  private ufx!: UniqueFx;
  /** What unique handlers may touch (built once in `init`). */
  private services!: UniqueServices;
  private readonly uniqueInput: UniqueInput = { fireDown: false, firePressed: false, fireReleased: false, altDown: false, altPressed: false, altReleased: false, meleeDown: false, meleePressed: false, meleeReleased: false };
  /** True while the holster is caused by a wielded implant (`ctx.implants.blocksWeapons`): nothing in flight is cleared then. */
  private implantHolstered = false;
  /** Gadget throw mode toggled with RMB while a gadget is in hand. */
  private gadgetUnderhand = false;
  private readonly netUnsub: (() => void)[] = [];

  private readonly slots: Record<WeaponSlot, WeaponInstance | null> = { primary: null, primary2: null, secondary: null };
  /** Dev fallback (no `ctx.inventory`): reserve rounds per weapon uid. */
  private readonly fallbackReserve = new Map<string, number>();
  private active: WeaponSlot = 'primary';
  /** Slot that was in hand before the last swap (Q returns to it). */
  private prevActive: WeaponSlot | null = null;
  private attachedModel: WeaponModel | null = null;

  private phase: 'ready' | 'reloading' | 'swapping' = 'ready';
  private reloadTimer = 0;
  private reloadDuration = 1;
  private swapTimer = 0;
  private swapDuration = WEAPON_SWAP_TIME_PRIMARY;
  private swapTarget: WeaponSlot = 'primary';
  private swapSwitched = false;

  private cooldown = 0;
  private bloom = 0;
  private firingTimer = 0;
  /** Bolt-action cycle: remaining seconds / total (0 when idle). */
  private boltTimer = 0;
  private boltDuration = 0;
  private boltSoundTimer = 0;
  private zoomSent = { zoom: 1, scope: false };
  private adsTimeSent = -1;
  private fallbackGrenades = 4;
  private loadoutWait = -1;
  /** Frames until the shader warm-up runs (set when the hellpod drop starts). */
  private warmupFrames = 0;
  /** Hub / docking / menu: weapon model hidden, soldier posed unarmed, ADS zoom neutral. */
  private holstered = false;
  /** True while we are inside our own `ctx.inventory.updateItem` call (ignore the echoed inventory events). */
  private selfWriting = false;
  private brokenNotifyAt = -Infinity;
  private dryFlagged = false;

  /* ── quick-use (F): consumable in hand, wheel, grenade hold ── */
  /** Consumable in hand instead of a gun (`active` keeps the gun slot to return to). */
  private quick: QuickHand | null = null;
  /** Wheel index of the last consumable taken into the hand (F tap re-equips it). */
  private lastQuickIndex: number | null = null;
  /** F is down since a press that we accepted; `quickHoldT` = seconds held so far. */
  private quickKeyHeld = false;
  private quickHoldT = 0;
  private wheelOpen = false;
  private wheelDX = 0;
  private wheelDY = 0;
  private wheelHover: number | null = null;
  /** Remaining draw-down of the gun model after taking a consumable (0 = hidden). */
  private quickHolsterT = 0;
  private quickCooldown = 0;
  /** True while we are inside our own `consumeItem` (defer the echoed `inventory:quickSlotsChanged`). */
  private quickBusy = false;
  /** Grenade in hand: LMB held (wind-up), pin pulled (cooking), cook seconds, lob mode (persists between holds). */
  private holding = false;
  private cooking = false;
  private cooked = 0;
  private underhand = false;

  private readonly camHit = makeHit();
  private readonly gunHit = makeHit();
  private readonly weaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false, throwing: false, holdingItem: false, charging: false, spraying: false, heavy: false };

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.fx = new WeaponFx(ctx.scene);
    this.grenades = new GrenadeManager(ctx, this.fx);
    // Phase 3: live grenade positions for the HUD's off-screen indicators
    ctx.weapons = { getGrenades: () => this.grenades.getViews() };
    this.projectiles = new ProjectilePool(ctx,
      (h, dmg, weaponId) => this.onProjectileHit(h, dmg, weaponId),
      (h, weaponId) => this.remote.onVisualProjectileHit(h, weaponId));
    this.ufx = new UniqueFx(ctx.scene);
    this.remote = new RemoteWeapons(ctx, this.fx, this.grenades, this.projectiles, this.ufx);
    this.melee = new MeleeController(ctx, this.fx);
    this.services = this.buildServices();
    // melee: anyone else emitting `melee:swing` gets resolved too (MeleeController guards against double resolution)
    ctx.bus.on('melee:swing', () => {
      if (!ctx.isGameplayPhase()) return;
      this.melee.onBusSwing(this.getHost(), this.slots[this.active]?.def ?? null);
    });

    // multiplayer replication (handlers no-op unless ctx.isMultiplayer && ctx.net)
    ctx.bus.on('net:remoteFired', (p) => this.remote.onFired(p.id, p.weaponId, p.origin, p.direction));
    ctx.bus.on('net:remoteReloaded', (p) => this.remote.onReloaded(p.id, p.weaponId));
    ctx.bus.on('net:remoteGrenade', (p) => this.remote.onGrenade(p.position, p.velocity, p.fuse));
    ctx.bus.on('net:remotePlayerRemoved', (p) => this.remote.remove(p.id));
    ctx.bus.on('game:newMission', () => this.remote.clear());

    ctx.bus.on('loadout:changed', (p) => this.onLoadout({ primary: p.primary, primary2: p.primary2 ?? null, secondary: p.secondary }));
    // inventory → weapons: persistent fields / sockets changed on a held weapon (repair, unload, attachments, …)
    ctx.bus.on('inventory:itemUpdated', (p) => this.onItemUpdated(p.item));
    ctx.bus.on('inventory:socketChanged', (p) => this.onSocketChanged(p.weapon));
    ctx.bus.on('inventory:changed', () => this.onInventoryChanged());
    // quick slots re-assigned / consumed / dropped → the consumable in hand may be gone
    ctx.bus.on('inventory:quickSlotsChanged', (p) => this.onQuickSlotsChanged(p.slots));

    ctx.bus.on('world:ready', () => {
      this.dropQuick();
      this.resetTransient();
      this.fallbackReserve.clear();
      for (const s of WEAPON_SLOTS) this.setSlot(s, null);
      this.prevActive = null;
      this.lastQuickIndex = null;
      this.fallbackGrenades = 4;
      this.loadoutWait = LOADOUT_FALLBACK_DELAY;
    });
    ctx.bus.on('game:abort', () => {
      this.dropQuick();
      this.flushAll();
      this.resetTransient();
      for (const s of WEAPON_SLOTS) this.setSlot(s, null);
      this.prevActive = null;
      this.lastQuickIndex = null;
      this.loadoutWait = -1;
    });
    // Ship hub: nothing in flight, weapon holstered (visibility is handled per frame from ctx.phase).
    ctx.bus.on('hub:entered', () => { this.dropQuick(); this.resetTransient(); this.loadoutWait = -1; });
    // Hellpod drop started → pre-compile every shader (hidden FX meshes included) before the first shot/throw.
    ctx.bus.on('game:phaseChanged', ({ phase }) => { if (phase === 'deploying') this.warmupFrames = 2; });
    this.ensureNet();
  }

  /** Subscribe to relayed messages once `ctx.net` exists (NetSystem registers first, but stay defensive). */
  private ensureNet(): void {
    const net = this.ctx.net;
    if (!net || this.netUnsub.length > 0) return;
    this.netUnsub.push(net.onMessage('melee', (msg, from) => this.remote.onMelee(from, msg.p, msg.d, msg.hit)));
    // unique weapons carry `m` / `c` that the `net:remoteFired` bus event drops → raw message path
    this.netUnsub.push(net.onMessage('fire', (msg, from) => this.remote.onFireMessage(from, msg)));
  }

  update(dt: number, ctx: GameContext): void {
    this.fx.update(dt);
    this.ufx.update(dt);
    this.grenades.update(dt);
    this.projectiles.update(dt);
    this.remote.update(dt);
    // one frame after the drop scene rendered: compile shaders for the pooled/hidden FX meshes (async when possible)
    if (this.warmupFrames > 0 && --this.warmupFrames === 0) this.fx.warmUp(ctx.renderer, ctx.scene, ctx.camera);

    this.ensureNet();
    const host = this.getHost();
    if (!host) { this.melee.cancel(); return; }

    // ── holster outside gameplay (hub / docking / menu) or while a wielded implant is in the hands (tactical kit):
    //    model hidden, unarmed pose, neutral zoom. The implant case must NOT wipe grenades / projectiles.
    const phaseHolster = ctx.phase === 'hub' || ctx.phase === 'docking' || ctx.phase === 'menu';
    const implantHolster = !phaseHolster && ctx.implants?.blocksWeapons === true;
    const holster = phaseHolster || implantHolster;
    if (holster !== this.holstered) {
      this.holstered = holster;
      if (holster) {
        this.dropQuick();
        if (phaseHolster) { this.flushAll(); this.resetTransient(); }
        else { if (this.phase === 'reloading') this.cancelReload(); if (this.phase === 'swapping') { this.phase = 'ready'; this.active = this.swapTarget; } this.slots[this.active]?.unique?.reset(); this.applyAimZoom(null); }
      } else this.attachActive(false);
    }
    this.implantHolstered = implantHolster;

    // fallback loadout if no inventory ever speaks
    if (this.loadoutWait > 0) {
      this.loadoutWait -= dt;
      if (this.loadoutWait <= 0 && !this.slots.primary && !this.slots.primary2 && !this.slots.secondary) {
        this.onLoadout({
          primary: { uid: 'default-primary', defId: defaultFor('primary').id, qty: 1, rotated: false },
          primary2: null,
          secondary: { uid: 'default-secondary', defId: defaultFor('secondary').id, qty: 1, rotated: false },
        });
      }
    }

    const input = ctx.input;
    // Phase 3: an armed / targeting ship call owns the mouse — guns neither fire nor swap until it is put away
    const callActive = !!ctx.stratagems && (ctx.stratagems.armed !== null || ctx.stratagems.targeting);
    const armedAndFree = ctx.isGameplayActive() && input.isPointerLocked && host.canUseWeapons() && host.isDiving !== true && !callActive;
    // a wielded implant (Q) holsters the weapon: no firing, no reload, no swap, no quick use
    const usable = armedAndFree && !this.holstered;
    // the gun in hand (null while a consumable is held)
    const weapon = this.quick ? null : this.slots[this.active];

    // ── melee (F, tactical kit). The player owns stamina / cooldown / animation; we only resolve the hit.
    if (armedAndFree && !this.implantHolstered && !this.wheelOpen && !this.holding && !weapon?.unique?.handlesMelee && input.wasPressed(Keys.MELEE)) {
      if (this.melee.tryStart(host, weapon?.def ?? null)) {
        if (this.phase === 'reloading') this.cancelReload();
        this.firingTimer = FIRING_POSE_HOLD * 0.5;
      }
    }
    this.melee.update(dt, host);
    // ── H: stim straight into the hand (tactical kit key layout)
    if (usable && !this.wheelOpen && input.wasPressed(Keys.STIM)) this.quickStim(host);

    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.quickCooldown > 0) this.quickCooldown -= dt;
    this.bloom = Math.max(0, this.bloom - BLOOM_DECAY * dt);
    if (this.firingTimer > 0) this.firingTimer -= dt;
    this.updateBolt(dt, weapon);

    // ── quick-use key (F): tap = last consumable into the hand, hold = wheel
    this.updateQuickKey(dt, host, usable);
    // the wheel eats mouse buttons as well as the look delta
    const inputFree = usable && !this.wheelOpen;

    // ── swap (1 / 2 / 3 / V) — also the way back from a consumable to a gun
    if (inputFree) {
      if (input.wasPressed(Keys.PRIMARY)) this.requestSwap('primary');
      else if (input.wasPressed(Keys.PRIMARY2)) this.requestSwap('primary2');
      else if (input.wasPressed(Keys.SECONDARY)) this.requestSwap('secondary');
      else if (input.wasPressed(Keys.SWAP)) this.requestSwap(this.quickSwapTarget());
    } else if (this.implantHolstered && armedAndFree && !this.wheelOpen) {
      // a wielded implant (대전차포) is in the hands: a weapon key stows it and draws that weapon
      const want: WeaponSlot | null | undefined =
        input.wasPressed(Keys.PRIMARY) ? 'primary'
          : input.wasPressed(Keys.PRIMARY2) ? 'primary2'
            : input.wasPressed(Keys.SECONDARY) ? 'secondary'
              : input.wasPressed(Keys.SWAP) ? this.quickSwapTarget() : undefined;
      if (want !== undefined) {
        ctx.implants?.stow();
        if (want && this.slots[want] && want !== this.active) this.requestSwap(want);
        else if (!want || !this.slots[want]) ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
      }
    }
    let uniqueUpdated = false;
    if (this.phase === 'swapping') this.updateSwap(dt);
    else if (this.phase === 'reloading') this.updateReload(dt);
    else if (this.quick) this.updateQuickHand(dt, host, usable, inputFree);
    else if (weapon && weapon.unique && inputFree) {
      // Phase 6: a unique weapon owns both mouse buttons (RMB = alt fire, never ADS) — R still reloads
      if (input.wasPressed(Keys.RELOAD) && this.magOf(weapon) < weapon.stats.magSize) this.tryReload(weapon);
      else {
        weapon.unique.update(dt, weapon, this.readUniqueInput());
        uniqueUpdated = true;
      }
      if (!input.isMouseDown(MouseButtons.FIRE) && !input.isMouseDown(MouseButtons.AIM)) this.dryFlagged = false;
    }
    else if (weapon && inputFree) {
      const st = weapon.stats;
      const mag = this.magOf(weapon);
      const trigger = weapon.def.automatic ? input.isMouseDown(MouseButtons.FIRE) : input.wasMousePressed(MouseButtons.FIRE);
      if (input.wasPressed(Keys.RELOAD) && mag < st.magSize) this.tryReload(weapon);
      else if (trigger && this.cooldown <= 0 && this.boltTimer <= 0) {
        if (this.durabilityOf(weapon) <= 0) {
          if (!this.dryFlagged) { this.dryFlagged = true; this.onBrokenTrigger(weapon); }
        } else if (mag > 0) this.fire(host, weapon);
        else if (!this.dryFlagged) {
          this.dryFlagged = true;
          ctx.bus.emit('weapon:dryFire', { weaponId: st.weaponId });
          ctx.bus.emit('audio:play', { id: 'dry_fire', volume: 0.6 });
          this.tryReload(weapon);
        }
      }
      if (!input.isMouseDown(MouseButtons.FIRE)) this.dryFlagged = false;
    }

    // a unique in the active slot that got no input this frame (menu, wheel, reload, swap, consumable in hand,
    // holstered): tick it with the trigger released so beams stop, spin decays, charges cancel
    const activeUnique = this.slots[this.active];
    if (activeUnique?.unique && !uniqueUpdated) activeUnique.unique.update(dt, activeUnique, null);

    // ── model animation & pose state
    this.updateQuickHolster(dt);
    for (const s of WEAPON_SLOTS) this.slots[s]?.model.update(dt, ctx.time);
    if (this.holstered && this.attachedModel) this.attachedModel.root.visible = false;
    const ws = this.weaponState;
    const armed = !!weapon && !this.holstered;
    ws.hasWeapon = armed;
    ws.reloading = armed && this.phase === 'reloading';
    ws.firing = armed && this.firingTimer > 0;
    ws.twoHanded = armed && weapon ? weapon.stats.weaponClass !== 'PISTOL' : false;
    ws.holdingItem = !!this.quick && !this.holstered;
    ws.throwing = ws.holdingItem && this.holding;
    const up = armed && weapon ? weapon.unique?.pose : undefined;
    ws.charging = !!up?.charging;
    ws.spraying = !!up?.spraying;
    ws.heavy = !!up?.heavy;
    if (up?.firing) ws.firing = true;
    host.setWeaponState(ws);
  }

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

  /** Tell the player rig (and HUD) the ADS zoom + aim-in time of the weapon in hand. */
  private applyAimZoom(stats: EffectiveWeaponStats | null): void {
    const host = this.getHost();
    const zoom = stats?.adsZoom ?? 1;
    const scope = !!stats?.scope;
    const adsTime = stats?.adsTime ?? -1;
    if (adsTime !== this.adsTimeSent && adsTime > 0) {
      this.adsTimeSent = adsTime;
      if (host && typeof host.setAdsTime === 'function') host.setAdsTime(adsTime);
    }
    if (this.zoomSent.zoom === zoom && this.zoomSent.scope === scope) return;
    this.zoomSent.zoom = zoom; this.zoomSent.scope = scope;
    if (host && typeof host.setAimZoom === 'function') host.setAimZoom(zoom, scope);
    this.ctx.bus.emit('weapon:scopeChanged', { zoom, scope });
  }

  dispose(): void {
    for (const u of this.netUnsub) u();
    this.netUnsub.length = 0;
    for (const s of WEAPON_SLOTS) this.setSlot(s, null);
    this.remote.dispose(); this.fx.dispose(); this.ufx.dispose(); this.grenades.dispose(); this.projectiles.dispose();
  }

  /* ─────────────────────────── loadout ─────────────────────────── */
  private getHost(): Host | null {
    const p = this.ctx.player as (PlayerRef & Partial<PlayerWeaponHost>) | null;
    if (!p || typeof p.getWeaponSocket !== 'function' || typeof p.getAimRay !== 'function') return null;
    return p as Host;
  }

  private resolveDef(item: ItemInstance, slot: WeaponSlot): WeaponDef {
    const ctx = this.ctx;
    const itemDef = ctx.loot?.getItemDef(item.defId) ?? ctx.inventory?.getDef(item.defId);
    let def: WeaponDef | undefined;
    if (itemDef?.weaponId) def = ctx.loot?.getWeaponDef(itemDef.weaponId);
    if (!def) def = ctx.loot?.getWeaponDef(item.defId);
    if (!def) {
      const d = defaultFor(slot);
      const other = defaultFor(slot === 'secondary' ? 'primary' : 'secondary');
      def = item.defId === other.id ? other : d;
    }
    return def;
  }

  /** Graded + socketed stats for the instance (loot service), else derived from the bare def. */
  private resolveStats(inst: ItemInstance, def: WeaponDef): EffectiveWeaponStats {
    const loot = this.ctx.loot;
    let stats: EffectiveWeaponStats | null = null;
    if (loot && typeof loot.getEffectiveStats === 'function') {
      try { stats = loot.getEffectiveStats(inst); } catch { stats = null; }
      if (!stats) { try { stats = loot.getEffectiveStats(def.id); } catch { stats = null; } }
    }
    return stats ?? statsFromDef(def);
  }

  /** Attachment visuals from the instance's sockets (`att_brake`, `att_laser`, …) via the item defs. */
  private attachmentsFor(inst: ItemInstance): WeaponAttachmentVisuals {
    const out: WeaponAttachmentVisuals = {};
    const sockets = inst.sockets;
    if (!sockets) return out;
    const loot = this.ctx.loot, inv = this.ctx.inventory;
    for (const key of Object.keys(sockets) as SocketSlot[]) {
      const att = sockets[key];
      if (!att) continue;
      const def: ItemDef | undefined = loot?.getItemDef(att.defId) ?? inv?.getDef(att.defId);
      const socket: SocketSlot = def?.attachment?.socket ?? key;
      const id = att.defId.toLowerCase();
      switch (socket) {
        case 'muzzle': out.muzzle = id.includes('comp') ? 'comp' : id.includes('choke') ? 'choke' : 'brake'; break;
        case 'grip': out.grip = id.includes('angled') ? 'angled' : 'vertical'; break;
        case 'sight': out.sight = (def?.attachment?.effects.laser || id.includes('laser')) ? 'laser' : 'scope'; break;
        case 'mag': out.mag = true; break;
        case 'stock': out.stock = true; break;
      }
    }
    return out;
  }

  private onLoadout(items: Record<WeaponSlot, ItemInstance | null>): void {
    this.loadoutWait = -1;
    for (const slot of WEAPON_SLOTS) {
      const item = items[slot];
      const cur = this.slots[slot];
      if (!item) { if (cur) { this.flush(cur); this.setSlot(slot, null); } continue; }
      if (cur && cur.uid === item.uid) {
        // same weapon, possibly a fresh instance object → keep the inventory's reference and re-read its stats
        if (cur.inst !== item) cur.inst = item;
        cur.stats = this.resolveStats(item, cur.def);
        cur.model.setAttachments(this.attachmentsFor(item));
        continue;
      }
      if (cur) this.flush(cur);
      const def = this.resolveDef(item, slot);
      const stats = this.resolveStats(item, def);
      const model = new WeaponModel(def);
      model.setAttachments(this.attachmentsFor(item));
      const unique = def.unique ? createUniqueHandler(def.unique, this.services) : null;
      this.setSlot(slot, { uid: item.uid, slot, def, inst: item, stats, model, unique, ammoFrac: 0, durFrac: 0 });
      this.initInstanceFields(this.slots[slot]!);
    }
    // make sure something usable is in hand
    if (!this.slots[this.active]) {
      const next = this.nextOccupied(this.active);
      if (next) this.active = next;
    }
    if (this.prevActive && !this.slots[this.prevActive]) this.prevActive = null;
    if (this.phase === 'reloading') this.cancelReload();
    if (this.phase === 'swapping') { this.phase = 'ready'; }
    this.attachActive(true);
    this.emitGrenadeCount();
  }

  /** `ammoInMag` / `durability` undefined on the instance → treat as full (loot normally initialises both). */
  private initInstanceFields(w: WeaponInstance): void {
    if (w.inst.ammoInMag === undefined) w.inst.ammoInMag = w.stats.magSize;
    if (w.inst.durability === undefined) w.inst.durability = w.stats.maxDurability;
  }

  private setSlot(slot: WeaponSlot, inst: WeaponInstance | null): void {
    const cur = this.slots[slot];
    if (cur) {
      if (this.attachedModel === cur.model) { cur.unique?.onUnequip(cur); cur.model.root.removeFromParent(); this.attachedModel = null; }
      cur.unique?.dispose();
      cur.model.dispose();
    }
    this.slots[slot] = inst;
  }

  /** Next occupied slot after `from` in 1 → 2 → 3 order (wrapping), or null. */
  private nextOccupied(from: WeaponSlot): WeaponSlot | null {
    const i = WEAPON_SLOTS.indexOf(from);
    for (let k = 1; k < WEAPON_SLOTS.length; k++) {
      const s = WEAPON_SLOTS[(i + k) % WEAPON_SLOTS.length];
      if (this.slots[s]) return s;
    }
    return null;
  }

  /** Q: the previously active slot when it still holds a weapon, else the next occupied slot. */
  private quickSwapTarget(): WeaponSlot | null {
    if (this.prevActive && this.prevActive !== this.active && this.slots[this.prevActive]) return this.prevActive;
    return this.nextOccupied(this.active);
  }

  /** Parent the active weapon model to the hand socket and announce it. */
  private attachActive(announce: boolean): void {
    const host = this.getHost();
    const weapon = this.slots[this.active];
    if (this.attachedModel && (!weapon || this.attachedModel !== weapon.model)) {
      const prev = this.findByModel(this.attachedModel);
      prev?.unique?.onUnequip(prev);
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
      weapon.unique?.onEquip(weapon);
    }
    if (this.quick) {
      // a consumable is in hand: the gun stays parented but drawn down, no zoom, no `weapon:equipped`
      if (this.quickHolsterT <= 0) weapon.model.setDraw(0);
      this.applyAimZoom(null);
      return;
    }
    this.applyAimZoom(this.holstered ? null : this.zoomStatsFor(weapon));
    if (announce) {
      const st = weapon.stats;
      this.ctx.bus.emit('weapon:equipped', {
        slot: this.active, weaponId: st.weaponId, name: weapon.def.name, magSize: st.magSize,
        ammoInMag: this.magOf(weapon), reserveRounds: this.reserveOf(weapon),
      });
      this.emitAmmo(weapon);
      this.emitDurability(weapon);
    }
  }

  private emitEmpty(): void {
    this.ctx.bus.emit('weapon:equipped', { slot: this.active, weaponId: '', name: '', magSize: 0, ammoInMag: 0, reserveRounds: 0 });
    this.applyAimZoom(null);
  }

  /* ─────────────────────────── ammo / durability state (lives on the ItemInstance) ─────────────────────────── */
  private magOf(w: WeaponInstance): number {
    const v = w.inst.ammoInMag;
    return v === undefined ? w.stats.magSize : Math.max(0, v);
  }

  private durabilityOf(w: WeaponInstance): number {
    const v = w.inst.durability;
    return v === undefined ? w.stats.maxDurability : Math.max(0, v);
  }

  /** Rounds of the weapon's calibre in the bag (v2); dev fallback without an inventory = `magSize × reserveMags`. */
  private reserveOf(w: WeaponInstance): number {
    const inv = this.ctx.inventory;
    if (inv) {
      const type = w.stats.ammoType;
      return inv.countWhere((d) => d.category === 'ammo' && d.ammoType === type);
    }
    let r = this.fallbackReserve.get(w.uid);
    if (r === undefined) { r = w.def.magSize * w.def.reserveMags; this.fallbackReserve.set(w.uid, r); }
    return r;
  }

  /**
   * Persist `ammoInMag` / `durability` through the inventory so it emits `inventory:itemUpdated` for the HUD / bag UI.
   * The fields are already written on the shared instance; `selfWriting` makes us ignore the echoed events.
   */
  private persist(w: WeaponInstance, patch: { durability?: number; ammoInMag?: number }): void {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.updateItem !== 'function') return;
    this.selfWriting = true;
    try { inv.updateItem(w.uid, patch); } finally { this.selfWriting = false; }
  }

  private flush(w: WeaponInstance): void {
    this.persist(w, { ammoInMag: this.magOf(w), durability: this.durabilityOf(w) });
  }

  private flushAll(): void {
    for (const s of WEAPON_SLOTS) { const w = this.slots[s]; if (w) this.flush(w); }
  }

  private emitAmmo(w: WeaponInstance): void {
    this.ctx.bus.emit('weapon:ammoChanged', { weaponId: w.stats.weaponId, ammoInMag: this.magOf(w), magSize: w.stats.magSize, reserveRounds: this.reserveOf(w) });
  }

  private emitDurability(w: WeaponInstance): void {
    this.ctx.bus.emit('weapon:durabilityChanged', { uid: w.uid, weaponId: w.stats.weaponId, durability: this.durabilityOf(w), max: w.stats.maxDurability });
  }

  private findByUid(uid: string): WeaponInstance | null {
    for (const s of WEAPON_SLOTS) { const w = this.slots[s]; if (w && w.uid === uid) return w; }
    return null;
  }

  private findByModel(model: WeaponModel): WeaponInstance | null {
    for (const s of WEAPON_SLOTS) { const w = this.slots[s]; if (w && w.model === model) return w; }
    return null;
  }

  /** Stats to aim with: every `altFire` unique aims at zoom 1 (RMB is its alt fire); the bow aims like a DMR. */
  private zoomStatsFor(w: WeaponInstance): EffectiveWeaponStats | null {
    if (w.unique && !w.unique.allowsAim) return null;
    return w.stats;
  }

  /** Snapshot of the mouse / melee keys for a unique handler (one shared object, rewritten every frame). */
  private readUniqueInput(): UniqueInput {
    const input = this.ctx.input;
    const u = this.uniqueInput;
    u.fireDown = input.isMouseDown(MouseButtons.FIRE); u.firePressed = input.wasMousePressed(MouseButtons.FIRE); u.fireReleased = input.wasMouseReleased(MouseButtons.FIRE);
    u.altDown = input.isMouseDown(MouseButtons.AIM); u.altPressed = input.wasMousePressed(MouseButtons.AIM); u.altReleased = input.wasMouseReleased(MouseButtons.AIM);
    u.meleeDown = input.isDown(Keys.MELEE); u.meleePressed = input.wasPressed(Keys.MELEE); u.meleeReleased = input.wasReleased(Keys.MELEE);
    return u;
  }

  /** `inventory:itemUpdated` (repair at the workbench, unload, external edits): adopt the instance and re-announce. */
  private onItemUpdated(item: ItemInstance): void {
    if (this.selfWriting) return;
    const w = this.findByUid(item.uid);
    if (!w) return;
    if (w.inst !== item) {
      // a different object for the same uid → mirror the persistent fields onto ours and adopt it
      w.inst = item;
    }
    if (w.inst.ammoInMag !== undefined && w.inst.ammoInMag > w.stats.magSize) w.inst.ammoInMag = w.stats.magSize;
    this.emitDurability(w);
    if (w === this.slots[this.active]) this.emitAmmo(w);
  }

  /** `inventory:socketChanged`: stats (mag size, spread, zoom, …) and the attachment meshes change. */
  private onSocketChanged(item: ItemInstance): void {
    const w = this.findByUid(item.uid);
    if (!w) return;
    if (w.inst !== item) w.inst = item;
    w.stats = this.resolveStats(w.inst, w.def);
    w.model.setAttachments(this.attachmentsFor(w.inst));
    // a smaller magazine (extended mag removed) → hand the excess rounds back to the bag when possible
    const mag = this.magOf(w);
    if (mag > w.stats.magSize) {
      const excess = mag - w.stats.magSize;
      w.inst.ammoInMag = w.stats.magSize;
      this.returnRounds(w, excess);
      this.persist(w, { ammoInMag: w.inst.ammoInMag });
    }
    if (w === this.slots[this.active]) {
      if (!this.holstered) this.applyAimZoom(this.zoomStatsFor(w));
      this.emitAmmo(w);
    }
    this.emitDurability(w);
  }

  /** Try to put `rounds` of the weapon's calibre back into the bag (best effort; leftovers are lost). */
  private returnRounds(w: WeaponInstance, rounds: number): void {
    const loot = this.ctx.loot, inv = this.ctx.inventory;
    if (!loot || !inv || rounds <= 0) return;
    const type = w.stats.ammoType;
    const ammoDef = loot.getAllItemDefs().find((d) => d.category === 'ammo' && d.ammoType === type);
    if (!ammoDef) return;
    let left = rounds;
    while (left > 0) {
      const n = Math.min(left, Math.max(1, ammoDef.stackMax));
      if (!inv.tryAddItem(loot.createItem(ammoDef.id, n))) break;
      left -= n;
    }
  }

  /** Bag contents changed (ammo picked up / dropped / consumed) → refresh the reserve on the HUD. */
  private onInventoryChanged(): void {
    if (this.selfWriting || this.quickBusy) return;
    const w = this.slots[this.active];
    if (w && !this.holstered && !this.quick) this.emitAmmo(w);
    if (this.quick) this.emitGrenadeCount();
  }

  /* ─────────────────────────── swap ─────────────────────────── */
  private requestSwap(slot: WeaponSlot | null): void {
    if (this.phase === 'swapping') return;
    if (!slot || !this.slots[slot]) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
      return;
    }
    const fromQuick = !!this.quick;
    if (slot === this.active && this.attachedModel && !fromQuick) return;
    if (fromQuick) this.leaveQuick();
    if (this.phase === 'reloading') this.cancelReload();
    const cur = this.slots[this.active];
    if (cur) this.flush(cur);
    this.phase = 'swapping';
    this.boltTimer = 0; this.boltSoundTimer = 0;
    cur?.model.setBolt(-1);
    this.swapTimer = 0;
    this.swapTarget = slot;
    this.swapSwitched = false;
    const target = this.slots[slot]!;
    this.swapDuration = Math.max(0.05, target.stats.swapTime || (slot === 'secondary' ? WEAPON_SWAP_TIME_SECONDARY : WEAPON_SWAP_TIME_PRIMARY));
    // coming from a consumable the gun is already drawn down: skip the holster half, play the draw half only
    if (fromQuick) this.swapTimer = this.swapDuration * 0.5;
    this.ctx.bus.emit('weapon:swapStarted', { slot, duration: fromQuick ? this.swapDuration * 0.5 : this.swapDuration });
    this.ctx.bus.emit('audio:play', { id: 'weapon_swap', volume: 0.6 });
  }

  private updateSwap(dt: number): void {
    this.swapTimer += dt;
    const t = Math.min(1, this.swapTimer / this.swapDuration);
    const cur = this.slots[this.active];
    if (t < 0.5) {
      if (cur && this.attachedModel === cur.model) cur.model.setDraw(1 - t * 2);
    } else {
      if (!this.swapSwitched) {
        this.swapSwitched = true;
        if (this.swapTarget !== this.active) this.prevActive = this.active;
        this.active = this.swapTarget;
        this.attachActive(true);
        this.slots[this.active]?.model.setDraw(0);
      }
      this.slots[this.active]?.model.setDraw((t - 0.5) * 2);
    }
    if (t >= 1) { this.phase = 'ready'; this.slots[this.active]?.model.setDraw(1); }
  }

  /* ─────────────────────────── reload ─────────────────────────── */
  private tryReload(w: WeaponInstance): void {
    if (this.phase !== 'ready') return;
    if (this.magOf(w) >= w.stats.magSize) return;
    if (this.reserveOf(w) <= 0) {
      this.ctx.bus.emit('ui:notify', { text: '탄약 없음', kind: 'warning', duration: 1.2 });
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
      return;
    }
    this.phase = 'reloading';
    this.reloadTimer = 0;
    // 사격 스킬 (tactical kit): reload gets faster with the class skill (`derived.reloadSpeedMul`)
    this.reloadDuration = Math.max(0.2, w.stats.reloadTime / this.reloadSpeedFor(w.stats.weaponClass));
    this.boltTimer = 0; this.boltSoundTimer = 0;
    w.model.setBolt(-1);
    w.model.setReload(0);
    this.ctx.bus.emit('weapon:reloadStarted', { weaponId: w.stats.weaponId, duration: this.reloadDuration });
    this.ctx.bus.emit('audio:play', { id: 'reload', volume: 0.8 });
    if (this.ctx.isMultiplayer && this.ctx.net) this.ctx.net.send({ t: 'reload', w: w.stats.weaponId });
  }

  private updateReload(dt: number): void {
    const w = this.slots[this.active];
    if (!w) { this.phase = 'ready'; return; }
    this.reloadTimer += dt;
    const t = Math.min(1, this.reloadTimer / this.reloadDuration);
    w.model.setReload(t);
    if (t >= 1) {
      const need = Math.max(0, w.stats.magSize - this.magOf(w));
      let n = 0;
      const inv = this.ctx.inventory;
      if (inv) {
        const type = w.stats.ammoType;
        n = need > 0 ? inv.consumeWhere((d) => d.category === 'ammo' && d.ammoType === type, need) : 0;
      } else {
        const r = this.reserveOf(w);
        n = Math.min(need, r);
        this.fallbackReserve.set(w.uid, r - n);
      }
      w.inst.ammoInMag = this.magOf(w) + n;
      w.model.setReload(-1);
      this.phase = 'ready';
      this.persist(w, { ammoInMag: w.inst.ammoInMag });
      this.ctx.bus.emit('weapon:reloadFinished', { weaponId: w.stats.weaponId });
      this.ctx.bus.emit('audio:play', { id: 'reload_done', volume: 0.7 });
      this.emitAmmo(w);
    }
  }

  private cancelReload(): void {
    this.slots[this.active]?.model.setReload(-1);
    this.phase = 'ready';
  }

  /* ─────────────────────────── firing ─────────────────────────── */
  /** Trigger pulled on a weapon with 0 durability: click, event, throttled toast. Nothing fires. */
  private onBrokenTrigger(w: WeaponInstance): void {
    const ctx = this.ctx;
    ctx.bus.emit('weapon:broken', { uid: w.uid, weaponId: w.stats.weaponId });
    ctx.bus.emit('audio:play', { id: 'dry_fire', volume: 0.6 });
    if (ctx.time - this.brokenNotifyAt >= BROKEN_NOTIFY_INTERVAL) {
      this.brokenNotifyAt = ctx.time;
      ctx.bus.emit('ui:notify', { text: '내구도 소진 — 함선에서 수리 필요', kind: 'warning', duration: 1.6 });
    }
  }

  private fire(host: Host, w: WeaponInstance): void {
    const ctx = this.ctx, def = w.def, st = w.stats;
    // ── ammo + durability (one write per trigger pull; shotgun pellets count once)
    w.inst.ammoInMag = this.magOf(w) - 1;
    w.inst.durability = Math.max(0, this.durabilityOf(w) - WEAPON_DURABILITY_PER_SHOT);
    this.persist(w, { ammoInMag: w.inst.ammoInMag, durability: w.inst.durability });
    // fire rate reacts to an overcharge beam (tactical kit, ×1.3)
    const rate = this.effectiveFireRate(st);
    this.cooldown += 1 / rate;
    if (this.cooldown < 0) this.cooldown = 1 / rate;
    this.firingTimer = FIRING_POSE_HOLD;

    const cls = st.weaponClass;
    const aim = host.isAiming ? 1 : 0;
    const moving = host.velocity.lengthSq() > 0.5;
    const stance = STANCE_ACCURACY[host.stance ?? 'stand'] ?? STANCE_ACCURACY.stand;
    const stanceMul = stance[aim];
    const moveMul = host.isSprinting ? SPRINT_SPREAD_MUL : moving ? MOVING_SPREAD_MUL : 1;
    const spread = THREE.MathUtils.lerp(st.spread, st.adsSpread, aim) * stanceMul * (1 + this.bloom * 1.6) * moveMul;
    this.bloom = Math.min(1, this.bloom + BLOOM_PER_SHOT);
    // bolt-action: lock the trigger for the cycle and animate the bolt
    if (cls === 'SR') {
      this.boltDuration = Math.max(0.3, 1 / rate - 0.05);
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
    // direction replicated to other players: exact muzzle→target line for single shots, aim centre for pellets
    _netDir.copy(_d);
    for (let i = 0; i < pellets; i++) {
      randomInCone(_d, spread, _pd, _tA, _tB);
      this.raycastAll(_o, _pd, def.range, this.camHit);
      if (this.camHit.valid && this.camHit.distance < camToPlayer) this.camHit.valid = false;
      if (this.camHit.valid) _target.copy(this.camHit.point); else _target.copy(_o).addScaledVector(_pd, def.range);
      _md.subVectors(_target, _muzzle);
      const mdist = _md.length();
      if (mdist < 1e-3) continue;
      _md.divideScalar(mdist);
      if (pellets === 1) _netDir.copy(_md);

      if (def.projectileSpeed) {
        this.projectiles.fire(_muzzle, _md, def.projectileSpeed, st.damage, def.range, def.tracerColor, st.weaponId, false, projectileOptsFor(def));
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
        const dmg = st.damage * damageFalloff(def, _muzzle.distanceTo(hit.point));
        const r = this.applyHit(hit, dmg, _md, pellets > 1, st.ammoType);
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
    if (kindOf(def) !== 'energy' && (!def.unique || def.unique === 'minigun')) this.fx.casing(_tmp, _right, host.position.y);
    w.model.kick(pellets > 1 ? 2.2 : cls === 'SR' ? 2.6 : 1);
    // 사격 스킬 (tactical kit): recoil shrinks as the class skill rises (`derived.recoilMul`)
    const recoilMul = this.recoilMulFor(cls);
    const kick = st.recoilV * (0.85 + Math.random() * 0.3) * stanceMul * recoilMul;
    // horizontal: same ± random as before (items' recoilH = recoil × 0.7, the old constant)
    host.addRecoil(kick, (Math.random() - 0.5) * st.recoilH * stanceMul * recoilMul);
    if (cls === 'SR') ctx.bus.emit('camera:shake', { intensity: 0.35, duration: 0.18 });

    ctx.bus.emit('weapon:fired', { weaponId: st.weaponId, origin: _muzzle.clone(), direction: _d.clone() });
    // one message per trigger pull (shotgun pellets are fanned out visually by the receiver)
    if (ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'fire', w: st.weaponId, o: toTuple(_muzzle), d: toTuple(_netDir) });
    this.emitAmmo(w);
    this.emitDurability(w);
    ctx.bus.emit('audio:play', { id: shotSoundId(kindOf(def)), position: _muzzle, volume: 1, pitch: shotPitchFor(cls) * (0.95 + Math.random() * 0.1) });
    if (anyEnemy) ctx.bus.emit('ui:hitmarker', { kill: anyKill, headshot: anyHead });
    else if (anyHit && pellets === 1) { /* surface hit: no marker */ }
  }

  /** Nearest of world & enemy raycasts into `out`. */
  private raycastAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitInfo): void {
    const ctx = this.ctx;
    out.valid = false; out.enemy = null; out.obstacle = false; out.headshot = false; out.obstacleRef = null; out.armored = false; out.intercept = null;
    const eh = ctx.enemies ? ctx.enemies.raycast(origin, dir, maxDist) : null;
    const wh = ctx.world && ctx.world.ready ? ctx.world.raycast(origin, dir, maxDist) : null;
    if (eh && (!wh || eh.distance <= wh.distance)) {
      out.point.copy(eh.point); out.normal.copy(eh.normal); out.distance = eh.distance; out.enemy = eh.enemy; out.valid = true; out.headshot = eh.part === 'head'; out.armored = !!eh.armored;
    } else if (wh) {
      out.point.copy(wh.point); out.normal.copy(wh.normal); out.distance = wh.distance; out.obstacle = !!wh.obstacle; out.obstacleRef = wh.obstacle ?? null; out.valid = true;
    }
    // Phase 4: artillery shells can be shot down — nearest wins
    const ih = ctx.enemies && typeof ctx.enemies.raycastInterceptable === 'function' ? ctx.enemies.raycastInterceptable(origin, dir, out.valid ? out.distance : maxDist) : null;
    if (ih && (!out.valid || ih.distance < out.distance)) {
      out.point.copy(ih.point); out.normal.copy(dir).negate(); out.distance = ih.distance; out.enemy = null; out.obstacle = false; out.obstacleRef = null; out.headshot = false; out.armored = false;
      out.intercept = ih.target; out.valid = true;
    }
    // tactical kit: shields / solid deployables on the way (allied barriers ignore allied bullets — see Blocking.ts)
    const bd = raycastBlockers(ctx, origin, dir, maxDist, _block, false);
    if (bd >= 0 && (!out.valid || bd < out.distance)) {
      out.point.copy(_block); out.normal.copy(dir).negate(); out.distance = bd;
      out.enemy = null; out.headshot = false; out.armored = false; out.intercept = null; out.obstacleRef = null; out.obstacle = true; out.valid = true;
    }
  }

  /* ───────────────── tactical kit: progression / implant modifiers (all optional, default 1) ───────────────── */
  /** 사격 스킬 recoil multiplier for a class (1 when progression is not registered yet). */
  private recoilMulFor(cls: WeaponClass): number {
    const v = this.ctx.progression?.derived.recoilMul[cls];
    return typeof v === 'number' && v > 0 ? v : 1;
  }

  /** 사격 스킬 reload speed multiplier for a class (>1 = faster). */
  private reloadSpeedFor(cls: WeaponClass): number {
    const v = this.ctx.progression?.derived.reloadSpeedMul[cls];
    return typeof v === 'number' && v > 0 ? v : 1;
  }

  /** Fire rate after the overcharge implant bonus. */
  private effectiveFireRate(st: EffectiveWeaponStats): number {
    let rate = st.fireRate;
    if (this.ctx.player?.isOvercharged) rate *= IMPLANT_OVERCHARGE_FIRERATE_MUL;
    return Math.max(0.05, rate);
  }

  /** H: the first stim in a quick slot goes into the hand; pressed again with the stim in hand → inject. */
  private quickStim(host: Host): void {
    if (this.quick?.kind === 'stim') { if (this.quickCooldown <= 0 && this.quickHolsterT <= 0) this.useStim(host, this.quick); return; }
    for (const i of QUICK_SLOT_UNLOCK_ORDER) {
      const s = this.quickSlotItem(i);
      if (s && s.def.category === 'stim') { this.equipQuick(i); return; }
    }
    this.deny();
  }

  /** LMB with a gadget in hand: `ctx.gadgets.use` consumes the item itself; RMB toggles over / under-hand. */
  private useGadget(host: Host, q: QuickHand): void {
    const gadgets = this.ctx.gadgets;
    const id = q.def.gadgetId as GadgetId | undefined;
    if (!gadgets || !id) { this.deny(); return; }
    const inv = this.ctx.inventory;
    this.quickBusy = true;
    let ok = false;
    try { ok = gadgets.use(id, this.gadgetUnderhand); } finally { this.quickBusy = false; }
    if (!ok) { this.deny(); return; }
    this.quickCooldown = QUICK_USE_COOLDOWN;
    this.firingTimer = FIRING_POSE_HOLD * 0.5;
    host.addRecoil(0.01, 0);
    const cur = inv && typeof inv.getQuickSlots === 'function' ? inv.getQuickSlots()[q.index] : null;
    const remaining = this.adoptSlot(cur) ? Math.max(0, cur!.qty) : 0;
    this.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
    if (remaining <= 0) this.returnToGun();
  }

  /** Returns true if the hit killed an enemy. */
  private applyHit(h: HitInfo, damage: number, dir: THREE.Vector3, light: boolean, ammoType?: string): boolean {
    const ctx = this.ctx;
    if (h.intercept) {
      // Phase 4: shot down an artillery shell
      h.intercept.intercept(h.point);
      this.fx.impactSurface(h.point, h.normal, true);
      ctx.bus.emit('ui:hitmarker', { kill: false });
      ctx.bus.emit('audio:play', { id: 'hit_metal', position: h.point, volume: 0.6 });
      return false;
    }
    if (h.enemy && h.armored && ammoType && ARMOR_IMMUNE_AMMO.includes(ammoType)) {
      // Phase 4: armour plate (behemoth front) — light / medium / shell rounds ricochet, no damage
      this.fx.impactSurface(h.point, h.normal, true);
      ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: h.enemy.id, damage: 0, killed: false });
      ctx.bus.emit('audio:play', { id: 'hit_metal', position: h.point, volume: light ? 0.35 : 0.6, pitch: 1.3 });
      return false;
    }
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
    // Phase 3: destructible cover (dropped structures) takes the shot's damage
    h.obstacleRef?.destructible?.onDamage(damage, h.point);
    this.fx.impactSurface(h.point, h.normal, h.obstacle);
    ctx.bus.emit('weapon:hit', { point: h.point.clone(), normal: h.normal.clone(), enemyId: null, damage, killed: false });
    ctx.bus.emit('audio:play', { id: h.obstacle ? 'hit_metal' : 'hit_dirt', position: h.point, volume: light ? 0.25 : 0.45 });
    return false;
  }

  private onProjectileHit(h: ProjectileHit, damage: number, weaponId: string): void {
    this.gunHit.point.copy(h.point); this.gunHit.normal.copy(h.normal); this.gunHit.distance = h.distance;
    this.gunHit.enemy = h.enemy; this.gunHit.obstacle = h.obstacle; this.gunHit.obstacleRef = h.obstacleRef ?? null; this.gunHit.valid = true; this.gunHit.headshot = h.part === 'head';
    this.gunHit.armored = !!h.armored; this.gunHit.intercept = null;
    let def: WeaponDef | null = null;
    for (const s of WEAPON_SLOTS) {
      const w = this.slots[s];
      if (w && w.stats.weaponId === weaponId) {
        // Phase 6: rockets etc. resolve in their handler (area damage, self knockback)
        if (w.unique && typeof w.unique.onProjectileHit === 'function') { w.unique.onProjectileHit(h, damage, w); return; }
        def = w.def; break;
      }
    }
    const dmg = def ? damage * damageFalloff(def, h.distance) : damage;
    const killed = this.applyHit(this.gunHit, dmg, h.dir, false, def?.ammoType);
    if (h.enemy) this.ctx.bus.emit('ui:hitmarker', { kill: killed, headshot: this.gunHit.headshot });
  }

  /* ─────────────────────────── quick-use (F): wheel & consumable in hand ─────────────────────────── */
  /**
   * F pressed → hold timer. Released before `QUICK_WHEEL_HOLD` = tap (last used consumable, else the first usable slot).
   * Held longer = wheel: look locked, mouse delta accumulated, hover = 8-way direction once the drag exceeds
   * `QUICK_WHEEL_DRAG_PX`; release equips the hovered slot.
   */
  private updateQuickKey(dt: number, host: Host, usable: boolean): void {
    const input = this.ctx.input;
    if (!this.quickKeyHeld) {
      if (usable && input.wasPressed(Keys.QUICK)) { this.quickKeyHeld = true; this.quickHoldT = 0; }
      return;
    }
    if (!usable) { this.closeWheel(host); this.quickKeyHeld = false; return; }
    if (!input.isDown(Keys.QUICK)) {
      // release
      this.quickKeyHeld = false;
      if (this.wheelOpen) {
        const hover = this.wheelHover;
        this.closeWheel(host);
        if (hover !== null) this.equipQuick(hover);
      } else this.quickTap();
      return;
    }
    this.quickHoldT += dt;
    if (!this.wheelOpen) {
      if (this.quickHoldT < QUICK_WHEEL_HOLD) return;
      this.wheelOpen = true;
      this.wheelDX = 0; this.wheelDY = 0; this.wheelHover = null;
      host.setLookLocked(true);
      this.ctx.bus.emit('quick:wheelChanged', { open: true, hover: null });
      this.ctx.bus.emit('audio:play', { id: 'ui_open', volume: 0.35 });
      return;
    }
    this.wheelDX += input.mouseDX; this.wheelDY += input.mouseDY;
    let hover: number | null = null;
    if (this.wheelDX * this.wheelDX + this.wheelDY * this.wheelDY >= QUICK_WHEEL_DRAG_PX * QUICK_WHEEL_DRAG_PX) {
      // 0 = N (up), clockwise; screen y grows downward
      const ang = Math.atan2(this.wheelDX, -this.wheelDY);
      const idx = ((Math.round(ang / (Math.PI / 4)) % QUICK_SLOTS) + QUICK_SLOTS) % QUICK_SLOTS;
      hover = this.quickSlotItem(idx) ? idx : null;
    }
    if (hover !== this.wheelHover) {
      this.wheelHover = hover;
      this.ctx.bus.emit('quick:wheelChanged', { open: true, hover });
      if (hover !== null) this.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3 });
    }
  }

  private closeWheel(host: Host): void {
    if (!this.wheelOpen) return;
    this.wheelOpen = false; this.wheelHover = null;
    host.setLookLocked(false);
    this.ctx.bus.emit('quick:wheelChanged', { open: false, hover: null });
  }

  /** F tap: the last used consumable (else the first usable slot) into the hand; the same item again → back to the gun. */
  private quickTap(): void {
    let index: number | null = null;
    if (this.lastQuickIndex !== null && this.quickSlotItem(this.lastQuickIndex)) index = this.lastQuickIndex;
    else {
      for (const i of QUICK_SLOT_UNLOCK_ORDER) if (this.quickSlotItem(i)) { index = i; break; }
    }
    if (index === null) { this.deny(); return; }
    if (this.quick && this.quick.index === index) { this.returnToGun(); return; }
    this.equipQuick(index);
  }

  private deny(): void { this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 }); }

  private quickSlotCount(): number {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.getQuickSlotCount !== 'function') return 0;
    return Math.min(QUICK_SLOTS, inv.getQuickSlotCount());
  }

  /**
   * Usable consumable (stim / grenade) in wheel slot `index`, or null (empty, slot locked for the bag's quick-slot
   * count — see `isQuickSlotActive` / `QUICK_SLOT_UNLOCK_ORDER` —, wrong category).
   */
  private quickSlotItem(index: number): { item: ItemInstance; def: ItemDef } | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.getQuickSlots !== 'function' || !isQuickSlotActive(index, this.quickSlotCount())) return null;
    const item = inv.getQuickSlots()[index];
    if (!item || item.qty <= 0) return null;
    const def = this.ctx.loot?.getItemDef(item.defId) ?? inv.getDef(item.defId);
    if (!def || !QUICK_USABLE_CATEGORIES.includes(def.category)) return null;
    return { item, def };
  }

  /** Take wheel slot `index` into the hand (`active = 'quick'`): gun drawn down, one-handed pose, `quick:equipped`. */
  private equipQuick(index: number): void {
    const host = this.getHost();
    const slot = this.quickSlotItem(index);
    if (!host || !slot) { this.deny(); return; }
    if (this.quick && this.quick.uid === slot.item.uid) return;
    // leaving a grenade hold for another item: a pulled pin is dropped at the feet, otherwise nothing happens
    if (this.holding) this.cancelHold(host);
    if (this.phase === 'reloading') this.cancelReload();
    if (this.phase === 'swapping') { this.phase = 'ready'; this.active = this.swapTarget; this.attachActive(false); }
    const cur = this.slots[this.active];
    if (cur) { this.flush(cur); cur.model.setBolt(-1); cur.model.setReload(-1); }
    this.boltTimer = 0; this.boltSoundTimer = 0; this.dryFlagged = false;
    const first = !this.quick;
    this.quick = { index, uid: slot.item.uid, defId: slot.item.defId, item: slot.item, def: slot.def, kind: slot.def.category as QuickKind };
    this.lastQuickIndex = index;
    this.quickHolsterT = first && this.attachedModel ? QUICK_HOLSTER_TIME : 0;
    if (!first) this.attachedModel?.setDraw(0);
    this.applyAimZoom(null);
    this.ctx.bus.emit('quick:equipped', { index, item: slot.item });
    this.ctx.bus.emit('audio:play', { id: 'weapon_swap', volume: 0.45 });
  }

  /** Gun draw-down after taking a consumable (0.15 s), then the model hides itself (`drawT` ≤ 0.02). */
  private updateQuickHolster(dt: number): void {
    if (!this.quick || this.quickHolsterT <= 0) return;
    this.quickHolsterT -= dt;
    this.attachedModel?.setDraw(Math.max(0, this.quickHolsterT / QUICK_HOLSTER_TIME));
  }

  /** Clear the hand state (no swap, no events beyond `quick:equipped null`); the caller draws a gun or announces empty. */
  private leaveQuick(): void {
    if (!this.quick) return;
    if (this.holding) { const h = this.getHost(); if (h) this.cancelHold(h); }
    this.quick = null;
    this.quickHolsterT = 0;
    this.ctx.bus.emit('quick:equipped', { index: null, item: null });
  }

  /** Back to the gun that was in hand before the consumable (else the next occupied slot, else empty hands). */
  private returnToGun(): void {
    if (!this.quick) return;
    const target = this.slots[this.active] ? this.active : this.nextOccupied(this.active);
    if (!target) { this.leaveQuick(); this.emitEmpty(); return; }
    this.requestSwap(target);
  }

  /**
   * Hard exit from the hand state on world reset / abort / holster: the hold ends without a throw (the grenade pool is
   * cleared right after anyway), the gun model comes back instantly without a swap animation.
   */
  private dropQuick(): void {
    this.quickKeyHeld = false;
    const host = this.getHost();
    if (host) this.closeWheel(host);
    if (!this.quick) return;
    this.endHold(true);
    this.quick = null;
    this.quickHolsterT = 0;
    this.attachedModel?.setDraw(1);
    this.ctx.bus.emit('quick:equipped', { index: null, item: null });
  }

  /**
   * `inventory:quickSlotsChanged`: the consumable in hand vanished (dropped, moved, consumed elsewhere) → back to the
   * gun. A sibling stack of the same def that the inventory relinked into the slot is adopted instead.
   */
  private onQuickSlotsChanged(slots: readonly (ItemInstance | null)[]): void {
    if (!this.quick || this.quickBusy) return;
    if (!this.adoptSlot(slots[this.quick.index])) this.returnToGun();
  }

  /** Keep the hand on `cur` when it is our stack (or a same-def sibling stack); false when the slot no longer fits. */
  private adoptSlot(cur: ItemInstance | null | undefined): boolean {
    const q = this.quick;
    if (!q || !cur || cur.qty <= 0 || cur.defId !== q.defId || !isQuickSlotActive(q.index, this.quickSlotCount())) return false;
    q.uid = cur.uid; q.item = cur;
    return true;
  }

  /** LMB / R / RMB while a consumable is in hand. */
  private updateQuickHand(dt: number, host: Host, usable: boolean, inputFree: boolean): void {
    const q = this.quick!;
    const input = this.ctx.input;
    if (this.holding) {
      if (!usable) { this.cancelHold(host); if (this.quick && !this.quickSlotItem(q.index)) this.returnToGun(); return; }
      this.updateHold(dt, host, q);
      return;
    }
    if (!inputFree || this.quickCooldown > 0 || this.quickHolsterT > 0) return;
    if (q.kind === 'gadget' && input.wasMousePressed(MouseButtons.AIM)) {
      this.gadgetUnderhand = !this.gadgetUnderhand;
      this.ctx.bus.emit('gadget:throwModeChanged', { underhand: this.gadgetUnderhand });
      this.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3 });
      return;
    }
    if (!input.wasMousePressed(MouseButtons.FIRE)) return;
    if (q.kind === 'stim') this.useStim(host, q);
    else if (q.kind === 'gadget') this.useGadget(host, q);
    else this.beginHold();
  }

  /* ── stim ── */
  private useStim(host: Host, q: QuickHand): void {
    if (host.hp >= host.maxHp) { this.deny(); return; }
    const remaining = this.consumeQuick(q);
    if (remaining < 0) { this.deny(); return; }
    this.quickCooldown = QUICK_USE_COOLDOWN;
    this.firingTimer = FIRING_POSE_HOLD * 0.5;
    host.applyStim(q.def.healAmount ?? 50);
    this.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
    if (remaining <= 0) this.returnToGun();
  }

  /**
   * Take one unit of the consumable in hand out of the bag. Returns the stack left (0 = gone) or −1 when nothing
   * could be consumed. The echoed `inventory:quickSlotsChanged` is ignored (`quickBusy`) so the `quick:used` event
   * goes out before we return to the gun.
   */
  private consumeQuick(q: QuickHand): number {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.consumeItem !== 'function') return -1;
    let n = 0;
    this.quickBusy = true;
    try { n = inv.consumeItem(q.uid, 1); } finally { this.quickBusy = false; }
    if (n < 1) return -1;
    // at 0 the inventory relinks the slot to a sibling stack of the same def when it has one → keep it in hand
    const cur = typeof inv.getQuickSlots === 'function' ? inv.getQuickSlots()[q.index] : null;
    const remaining = this.adoptSlot(cur) ? Math.max(0, cur!.qty) : 0;
    if (q.kind === 'grenade') this.emitGrenadeCount();
    return remaining;
  }

  /* ── grenade hold ── */
  private fuseLeft(): number {
    return this.cooking ? Math.max(GRENADE_MIN_FUSE, GRENADE_FUSE - this.cooked) : GRENADE_FUSE;
  }

  private emitHold(): void {
    this.ctx.bus.emit('grenade:holdChanged', { holding: this.holding, cooking: this.cooking, cooked: this.cooked, fuse: this.fuseLeft(), underhand: this.underhand });
  }

  private beginHold(): void {
    this.holding = true; this.cooking = false; this.cooked = 0;
    this.emitHold();
  }

  private updateHold(dt: number, host: Host, q: QuickHand): void {
    const input = this.ctx.input;
    if (!input.isMouseDown(MouseButtons.FIRE)) { this.throwHeld(host, q, false); return; }
    let changed = false;
    if (!this.cooking && input.wasPressed(Keys.RELOAD)) {
      this.cooking = true; this.cooked = 0; changed = true;
      this.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.7 });
    }
    if (input.wasMousePressed(MouseButtons.AIM)) { this.underhand = !this.underhand; changed = true; }
    if (this.cooking) {
      this.cooked += dt;
      if (this.cooked >= GRENADE_COOK_MAX) { this.explodeInHand(host, q); return; }
      changed = true;
    }
    if (changed) this.emitHold();
  }

  /** LMB released: lob the grenade with the remaining fuse; the stack shrinks by one. */
  private throwHeld(host: Host, q: QuickHand, dropAtFeet: boolean): void {
    const fuse = this.fuseLeft();
    const remaining = this.consumeQuick(q);
    if (remaining < 0) { this.endHold(true); if (!dropAtFeet) this.returnToGun(); return; }
    this.handPosition(host, _tmp);
    if (dropAtFeet) {
      _md.set(0, 0.5, 0);
    } else {
      host.getAimRay(_o, _d);
      if (this.underhand) {
        _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * GRENADE_UNDERHAND_SPEED_MUL).addScaledVector(host.velocity, 0.5);
        _md.y = Math.max(_md.y * 0.5, 0) + GRENADE_UNDERHAND_LIFT;
      } else {
        _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED).addScaledVector(host.velocity, 0.5);
        _md.y += GRENADE_THROW_LIFT;
      }
    }
    this.grenades.throw(_tmp, _md, false, fuse);
    if (this.ctx.isMultiplayer && this.ctx.net) this.ctx.net.send({ t: 'grenade', p: toTuple(_tmp), v: toTuple(_md), fuse: Math.round(fuse * 100) / 100 });
    this.firingTimer = FIRING_POSE_HOLD;
    this.quickCooldown = QUICK_USE_COOLDOWN;
    this.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
    this.endHold(true);
    if (remaining <= 0 && !dropAtFeet) this.returnToGun();
  }

  /** Cooked past `GRENADE_COOK_MAX`: the grenade goes off in the hand (self damage included). */
  private explodeInHand(host: Host, q: QuickHand): void {
    const remaining = this.consumeQuick(q);
    this.handPosition(host, _tmp);
    _md.set(0, 0, 0);
    this.grenades.throw(_tmp, _md, false, 0);
    if (this.ctx.isMultiplayer && this.ctx.net) this.ctx.net.send({ t: 'grenade', p: toTuple(_tmp), v: [0, 0, 0], fuse: 0 });
    this.quickCooldown = QUICK_USE_COOLDOWN;
    if (remaining >= 0) this.ctx.bus.emit('quick:used', { index: q.index, item: q.item, remaining });
    this.endHold(true);
    if (remaining <= 0) this.returnToGun();
  }

  /** Hold interrupted (swap / holster / death / abort / other item): no throw — unless the pin is pulled, then it drops at the feet. */
  private cancelHold(host: Host): void {
    if (!this.holding) return;
    if (this.cooking && this.quick) this.throwHeld(host, this.quick, true);
    else this.endHold(true);
  }

  private endHold(emit: boolean): void {
    const was = this.holding;
    this.holding = false; this.cooking = false; this.cooked = 0;
    if (emit && was) this.emitHold();
  }

  /** Right hand in front of the shoulder (grenade release point). */
  private handPosition(host: Host, out: THREE.Vector3): void {
    host.getAimRay(_o, _d);
    host.getEyePosition(out);
    _right.set(Math.cos(host.yaw), 0, -Math.sin(host.yaw));
    out.addScaledVector(_d, 0.6).addScaledVector(_right, 0.25);
  }

  private emitGrenadeCount(): void {
    const inv = this.ctx.inventory;
    const count = inv ? inv.countWhere((d) => d.category === 'grenade') : this.fallbackGrenades;
    this.ctx.bus.emit('grenade:countChanged', { count });
  }

  private resetTransient(): void {
    this.melee.cancel();
    for (const s of WEAPON_SLOTS) this.slots[s]?.unique?.reset();
    this.grenades.clear();
    this.projectiles.clear();
    this.fx.clear();
    this.ufx.clear();
    this.remote.clear();
    this.phase = 'ready';
    this.cooldown = 0; this.bloom = 0; this.firingTimer = 0;
    this.quickCooldown = 0;
    this.boltTimer = 0; this.boltSoundTimer = 0;
    this.dryFlagged = false;
    this.endHold(false);
    this.slots[this.active]?.model.setReload(-1);
    this.slots[this.active]?.model.setBolt(-1);
    this.applyAimZoom(null);
  }

  /* ─────────────────────────── Phase 6: unique weapon services ─────────────────────────── */
  private readonly uniqueHit = makeHit();

  /**
   * The narrow API a `UniqueHandler` gets. Ammo / durability stay on the shared item instance and go through
   * `persist()` exactly like regular shots; the hitscan helper mirrors `fire()`'s single-pellet path.
   */
  private buildServices(): UniqueServices {
    const sys = this;
    const ctx = this.ctx;
    return {
      ctx,
      fx: this.fx,
      ufx: this.ufx,
      projectiles: this.projectiles,
      host: () => sys.getHost(),
      mag: (w) => sys.magOf(w as WeaponInstance),
      reserve: (w) => sys.reserveOf(w as WeaponInstance),
      drain(w, dt) {
        const wi = w as WeaponInstance;
        const mag = sys.magOf(wi);
        if (mag <= 0) return false;
        wi.ammoFrac += (wi.def.ammoPerSec ?? 0) * dt;
        wi.durFrac += dt;
        const units = Math.floor(wi.ammoFrac);
        const wear = Math.floor(wi.durFrac);
        if (units > 0 || wear > 0) {
          if (units > 0) { wi.ammoFrac -= units; wi.inst.ammoInMag = Math.max(0, mag - units); }
          if (wear > 0) { wi.durFrac -= wear; wi.inst.durability = Math.max(0, sys.durabilityOf(wi) - wear * WEAPON_DURABILITY_PER_SHOT); }
          sys.persist(wi, { ammoInMag: sys.magOf(wi), durability: sys.durabilityOf(wi) });
          if (units > 0) sys.emitAmmo(wi);
          if (wear > 0) sys.emitDurability(wi);
        }
        return true;
      },
      spend(w, rounds) {
        const wi = w as WeaponInstance;
        const mag = sys.magOf(wi);
        if (mag < rounds || rounds <= 0) return false;
        wi.inst.ammoInMag = mag - rounds;
        wi.inst.durability = Math.max(0, sys.durabilityOf(wi) - WEAPON_DURABILITY_PER_SHOT);
        sys.persist(wi, { ammoInMag: wi.inst.ammoInMag, durability: wi.inst.durability });
        sys.emitAmmo(wi);
        sys.emitDurability(wi);
        return true;
      },
      brokenCheck(w) {
        const wi = w as WeaponInstance;
        if (sys.durabilityOf(wi) > 0) return false;
        if (!sys.dryFlagged) { sys.dryFlagged = true; sys.onBrokenTrigger(wi); }
        return true;
      },
      dryFire(w) {
        const wi = w as WeaponInstance;
        if (sys.dryFlagged) return;
        sys.dryFlagged = true;
        ctx.bus.emit('weapon:dryFire', { weaponId: wi.stats.weaponId });
        ctx.bus.emit('audio:play', { id: 'dry_fire', volume: 0.6 });
        sys.tryReload(wi);
      },
      tryReload: (w) => sys.tryReload(w as WeaponInstance),
      muzzle(w, out) {
        w.model.muzzle.updateWorldMatrix(true, false);
        return out.setFromMatrixPosition(w.model.muzzle.matrixWorld);
      },
      aimRay(origin, dir) {
        const host = sys.getHost();
        if (host) host.getAimRay(origin, dir); else { origin.set(0, 0, 0); dir.set(0, 0, -1); }
      },
      aimTarget(range, out) {
        const host = sys.getHost();
        if (!host) { out.set(0, 0, 0); return; }
        host.getAimRay(_o, _d);
        _tmp.copy(host.position); _tmp.y += 1.5;
        const camToPlayer = _tmp.distanceTo(_o) + 0.4;
        sys.raycastAll(_o, _d, range, sys.uniqueHit);
        if (sys.uniqueHit.valid && sys.uniqueHit.distance < camToPlayer) sys.uniqueHit.valid = false;
        if (sys.uniqueHit.valid) out.copy(sys.uniqueHit.point); else out.copy(_o).addScaledVector(_d, range);
      },
      hitscan(w, spread, damage, range, tracerWidth, out: UniqueShot) {
        const wi = w as WeaponInstance;
        out.hit = false; out.enemy = false; out.killed = false;
        const host = sys.getHost();
        if (!host) return;
        host.getAimRay(_o, _d);
        wi.model.muzzle.updateWorldMatrix(true, false);
        _muzzle.setFromMatrixPosition(wi.model.muzzle.matrixWorld);
        _tmp.copy(host.position); _tmp.y += 1.5;
        const camToPlayer = _tmp.distanceTo(_o) + 0.4;
        randomInCone(_d, spread, _pd, _tA, _tB);
        sys.raycastAll(_o, _pd, range, sys.camHit);
        if (sys.camHit.valid && sys.camHit.distance < camToPlayer) sys.camHit.valid = false;
        if (sys.camHit.valid) _target.copy(sys.camHit.point); else _target.copy(_o).addScaledVector(_pd, range);
        _md.subVectors(_target, _muzzle);
        const mdist = _md.length();
        if (mdist < 1e-3) { out.end.copy(_target); return; }
        _md.divideScalar(mdist);
        sys.raycastAll(_muzzle, _md, mdist + 0.05, sys.gunHit);
        const hit = sys.gunHit.valid ? sys.gunHit : (sys.camHit.valid ? sys.camHit : null);
        out.end.copy(hit ? hit.point : _target);
        const fxm = FxManager.get();
        if (fxm) fxm.tracers.add(_muzzle, out.end, wi.def.tracerColor, tracerWidth, _muzzle.distanceTo(out.end) / 600 + 0.06, 600);
        if (!hit) return;
        const dmg = damage * damageFalloff(wi.def, _muzzle.distanceTo(hit.point));
        const killed = sys.applyHit(hit, dmg, _md, false, wi.stats.ammoType);
        out.hit = true; out.enemy = !!hit.enemy; out.killed = killed;
        if (hit.enemy) ctx.bus.emit('ui:hitmarker', { kill: killed, headshot: hit.headshot });
      },
      fireStandard(w) {
        const host = sys.getHost();
        if (host) sys.fire(host, w as WeaponInstance);
      },
      announceFire(w, origin, dir, m, c) {
        ctx.bus.emit('weapon:fired', { weaponId: w.stats.weaponId, origin: origin.clone(), direction: dir.clone() });
        if (ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'fire', w: w.stats.weaponId, o: toTuple(origin), d: toTuple(dir), m, c: Math.round(c * 100) / 100 });
      },
      announceBeamEnd(w, m) {
        if (!ctx.isMultiplayer || !ctx.net) return;
        const host = sys.getHost();
        w.model.muzzle.updateWorldMatrix(true, false);
        _muzzle.setFromMatrixPosition(w.model.muzzle.matrixWorld);
        if (host) host.getAimRay(_o, _d); else _d.set(0, 0, -1);
        ctx.net.send({ t: 'fire', w: w.stats.weaponId, o: toTuple(_muzzle), d: toTuple(_d), m, c: -1 });
      },
      recoil(pitch, yaw) { sys.getHost()?.addRecoil(pitch, yaw); },
      setCooldown(seconds) { sys.cooldown = Math.max(sys.cooldown, seconds); sys.firingTimer = FIRING_POSE_HOLD; },
      cooldown: () => sys.cooldown,
      deny: () => sys.deny(),
      notify(text) { ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 }); },
      lightMelee() {
        const host = sys.getHost();
        if (!host) return false;
        const ok = sys.melee.tryStart(host, sys.slots[sys.active]?.def ?? null);
        if (ok) { if (sys.phase === 'reloading') sys.cancelReload(); sys.firingTimer = FIRING_POSE_HOLD * 0.5; }
        return ok;
      },
      lineOfSight(from, to) {
        _tmp.subVectors(to, from);
        const dist = _tmp.length();
        if (dist < 1e-3) return true;
        _tmp.divideScalar(dist);
        const world = ctx.world;
        if (world && world.ready) {
          const wh = world.raycast(from, _tmp, dist);
          if (wh && wh.distance < dist - 0.35) return false;
        }
        const bd = raycastBlockers(ctx, from, _tmp, dist, _block, false);
        return !(bd >= 0 && bd < dist - 0.35);
      },
      emitAmmo: (w) => sys.emitAmmo(w as WeaponInstance),
    };
  }
}
