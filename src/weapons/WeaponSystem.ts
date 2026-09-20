import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, WEAPON_DURABILITY_PER_SHOT, WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY,
  IMPLANT_OVERCHARGE_FIRERATE_MUL,
  QUICK_SLOTS, QUICK_SLOT_UNLOCK_ORDER, QUICK_USABLE_CATEGORIES, isQuickSlotActive, QUICK_WHEEL_HOLD, QUICK_WHEEL_DRAG_PX, GRENADE_FUSE, GRENADE_COOK_MAX, GRENADE_UNDERHAND_SPEED_MUL,
  HEAL_HOLD_S, CONSUMABLE_SLOW_KEY, CONSUMABLE_SLOW_MUL, DEFIB_USE_TIME_S,
  type GameSystem, type WeaponDef, type ItemInstance, type ItemDef, type PlayerRef, type PlayerWeaponHost, type EnemyRef, type Vec3Tuple,
  type WeaponSlot, type EffectiveWeaponStats, type WeaponClass, type GadgetId, type WeaponRemoteState,
  /* appended 2026-09-21 [W]: the reload hold · giving a healing consumable to a squadmate */
  type ReloadPauseReason,
} from '@/shared';
import type { Obstacle as WorldObstacle, InterceptableRef, PeerId } from '@/shared';
import { ARMOR_IMMUNE_AMMO } from '@/shared';
import { withLocalGunHit } from '@/shared';
import { FxManager } from '@/core/fx';
import { randomInCone } from '@/core/util/MathUtil';
import { WEAPON_SLOTS, defaultFor, kindOf, shotSoundId, shotPitchFor, weaponClassOf, damageFalloff, statsFromDef, STANCE_ACCURACY } from './WeaponDefaults';
import { WeaponModel, type WeaponAttachmentVisuals } from './WeaponModel';
import { attachmentVisualsFor, attachmentIdsOf, sameIds } from './Attachments';
import { WeaponFx } from './fx/WeaponFx';
import { GrenadeManager } from './Grenade';
import { ThrowArc } from './fx/ThrowArc';
import { AimBlockMarker } from './fx/AimBlockMarker';
import { ProjectilePool, projectileOptsFor, type ProjectileHit } from './Projectile';
import { RemoteWeapons } from './RemoteWeapons';
import { MeleeController } from './Melee';
import { raycastBlockers, damageBarrierAt, makeBlockInfo } from './Blocking';
import { createUniqueHandler, UniqueFx, type UniqueHandler, type UniqueInput, type UniqueServices, type UniqueShot, type UniqueWeapon } from './unique';

import { BLOOM_DECAY, BLOOM_PER_SHOT, BOLT_SOUND_DELAY, BROKEN_NOTIFY_INTERVAL, CHANNEL_EMIT_HZ, FIRING_POSE_HOLD, GRENADE_MIN_FUSE, GRENADE_THROW_LIFT, GRENADE_THROW_SPEED, GRENADE_UNDERHAND_LIFT, type HitInfo, type Host, LOADOUT_FALLBACK_DELAY, MOVING_SPREAD_MUL, QUICK_HOLSTER_TIME, QUICK_USE_COOLDOWN, type QuickHand, type QuickKind, SPRAY_SEND_INTERVAL, SPRINT_SPREAD_MUL, type WeaponInstance, _block, _blockInfo, _d, _md, _mq, _muzzle, _netDir, _o, _pd, _rep, _right, _tA, _tB, _target, _tmp, gaugeOf, makeHit, toTuple, useTimeOf } from './model';
/** Shared folder vocabulary (constants · types · scratch) is `model.ts`'s — re-exported for the old import paths. */
export * from './model';
import * as Slots from './parts/Slots';
import * as Fire from './parts/Firing';
import * as Quick from './parts/QuickUse';
import * as Heal from './parts/Healing';
import * as Throw from './parts/Throwing';
/* 2026-09-15 (user's decision): the defibrillator alone fires 「on release」, so it gets its own file. */
import * as Defib from './parts/Defib';
/* 2026-09-21 (user's decision): the right-button use of a healing consumable on a squadmate gets its own file. */
import * as AllyHeal from './parts/AllyHeal';
import * as Svc from './parts/Services';
import * as Aim from './parts/AimLine';

export class WeaponSystem implements GameSystem {
  readonly name = 'weapons';

  ctx!: GameContext;
  fx!: WeaponFx;
  grenades!: GrenadeManager;
  /** The throw-arc preview (2026-09-08) — shown whenever a grenade / throwable gadget is in the hand. */
  throwArc!: ThrowArc;
  projectiles!: ProjectilePool;
  /** Multiplayer: remote players' weapon models + replicated fire/reload/grenade FX (inert offline). */
  private remote!: RemoteWeapons;
  /** Tactical kit: F melee attack — the player owns stamina / cooldown / pose, this owns the hit resolution. */
  melee!: MeleeController;
  /** Phase 6: pooled flame cones / lightning arcs shared by the local uniques and remote replicas. */
  ufx!: UniqueFx;
  /** What unique handlers may touch (built once in `init`). */
  services!: UniqueServices;
  private readonly uniqueInput: UniqueInput = { fireDown: false, firePressed: false, fireReleased: false, altDown: false, altPressed: false, altReleased: false, meleeDown: false, meleePressed: false, meleeReleased: false };
  /** True while the holster is caused by a wielded implant (`ctx.implants.blocksWeapons`): nothing in flight is cleared then. */
  private implantHolstered = false;
  /** Gadget throw mode toggled with RMB while a gadget is in hand. */
  gadgetUnderhand = false;
  private readonly netUnsub: (() => void)[] = [];

  readonly slots: Record<WeaponSlot, WeaponInstance | null> = { primary: null, primary2: null, secondary: null };
  /** Dev fallback (no `ctx.inventory`): reserve rounds per weapon uid. */
  readonly fallbackReserve = new Map<string, number>();
  active: WeaponSlot = 'primary';
  attachedModel: WeaponModel | null = null;

  phase: 'ready' | 'reloading' | 'swapping' = 'ready';
  reloadTimer = 0;
  reloadDuration = 1;
  /**
   * 2026-09-21 (user's decision): reasons the reload is **held**. Non-empty = `reloadTimer` does not advance and the
   * hands keep their pose; the progress is kept, so when the last reason goes the reload continues from that exact
   * point. Cancels (swap, consumable in hand, melee, a wielded implant, loadout change) still go through
   * `cancelReload` and throw the progress away — see `parts/Firing.setReloadPause`.
   */
  readonly reloadPauses = new Set<ReloadPauseReason>();
  swapTimer = 0;
  swapDuration = WEAPON_SWAP_TIME_PRIMARY;
  swapTarget: WeaponSlot = 'primary';
  swapSwitched = false;

  cooldown = 0;
  bloom = 0;
  firingTimer = 0;
  /** Bolt-action cycle: remaining seconds / total (0 when idle). */
  boltTimer = 0;
  boltDuration = 0;
  boltSoundTimer = 0;
  zoomSent = { zoom: 1, scope: false };
  adsTimeSent = -1;
  fallbackGrenades = 4;
  loadoutWait = -1;
  /** Frames until the shader warm-up runs (set when the hellpod drop starts). */
  private warmupFrames = 0;
  /** Hub / docking / menu: weapon model hidden, soldier posed unarmed, ADS zoom neutral. */
  holstered = false;
  /** True while we are inside our own `ctx.inventory.updateItem` call (ignore the echoed inventory events). */
  selfWriting = false;
  brokenNotifyAt = -Infinity;
  dryFlagged = false;

  /* ── quick-use (F): consumable in hand, wheel, grenade hold ── */
  /** Consumable in hand instead of a gun (`active` keeps the gun slot to return to). */
  quick: QuickHand | null = null;
  /** Wheel index of the last consumable taken into the hand (F tap re-equips it). */
  lastQuickIndex: number | null = null;
  /** F is down since a press that we accepted; `quickHoldT` = seconds held so far. */
  quickKeyHeld = false;
  quickHoldT = 0;
  wheelOpen = false;
  wheelDX = 0;
  wheelDY = 0;
  wheelHover: number | null = null;
  /** Remaining draw-down of the gun model after taking a consumable (0 = hidden). */
  quickHolsterT = 0;
  /**
   * 2026-09-11 the detonator hand: whether the T tap's "last used" was a remote mine (C4 · the detonator), the
   * placement confirm grace (`DETONATOR_CONFIRM_GRACE_S`), the `원격 지뢰 없음` toast throttle, synthetic instance cache.
   */
  lastQuickDetonator = false;
  detonatorGraceT = 0;
  detonatorNotifyAt = -Infinity;
  detonatorItem: ItemInstance | null = null;
  /**
   * 2026-09-11 drone control: true while `ctx.player.droneControl`, and afterwards until LMB · RMB · R have all
   * been released — a button held on the drone never leaks into firing / aiming the moment the PC takes over.
   * True means `armedAndFree` is false.
   */
  droneLatch = false;
  quickCooldown = 0;
  /** True while we are inside our own `consumeItem` (defer the echoed `inventory:quickSlotsChanged`). */
  quickBusy = false;
  /** Grenade in hand: LMB held (wind-up), pin pulled (cooking), cook seconds, lob mode (persists between holds). */
  holding = false;
  cooking = false;
  cooked = 0;
  underhand = false;
  /**
   * Phase 10 heal items, generalised 2026-09-07: LMB held with a consumable in hand (`붕대` · `약초 붕대` ·
   * `회복주사` · `제세동기`), seconds held so far, `ctx.time` of the last `heal:holdChanged`. `healSpray` marks
   * the heal-spray channel (gauge instead of a fixed hold) and `sprayAcc` is its 0.1 s tick accumulator.
   */
  healHeld = false;
  healT = 0;
  healEmitAt = -Infinity;
  healSpray = false;
  sprayAcc = 0;
  /** Phase 12: the channelled item behind `item:channelChanged` (a heal spray in hand) + its last emit (≤ 10 Hz). */
  channel: { uid: string; defId: string; max: number } | null = null;
  channelEmitAt = -Infinity;
  sprayEmptyNotifyAt = -Infinity;
  /** Heal spray: hp owed to each squadmate in range, flushed as a `buff heal` at most twice a second. */
  sprayOwed = new Map<string, number>();
  spraySendAcc = 0;
  /**
   * 2026-09-15 (defibrillator aiming, user's decision — `parts/Defib`): the LMB hold state of the defibrillator
   * in hand. `defibHeld` = it is held down, `defibT` = seconds charged, `defibArmed` = full and ready (firing on
   * release), `defibTarget` = an ally the release would raise is on the crosshair. It is **separate** from the
   * heal hold (`healT`) for one reason — a heal is used the moment it fills, the defibrillator **on release**.
   */
  defibHeld = false;
  defibArmed = false;
  defibT = 0;
  defibTarget = false;
  defibEmitAt = -Infinity;
  /**
   * 2026-09-21 (user's decision — `parts/AllyHeal`): the **right-button** hold that gives the healing consumable in
   * hand to a squadmate. `allyHealId` / `allyHealName` are the body picked when the hold started (the hold follows
   * that one body out to `HEAL_ALLY_RANGE_HOLD`, so it does not jump to whoever is on the crosshair now), `allyHealT`
   * the seconds held. Separate from `healHeld` because the two buttons mean two different uses of the same item, and
   * because this one carries **no** movement penalty.
   */
  allyHealHeld = false;
  allyHealT = 0;
  allyHealEmitAt = -Infinity;
  allyHealId: string | null = null;
  allyHealName = '';
  /** The held target is an **android** (`AllyId`, applied through `ctx.allies`), not a peer on the wire. */
  allyHealIsAndroid = false;
  /** What the held item gives — decides the ring's label (`아군 회복` vs `아군 실드`) and the `buff` kind. */
  allyHealKind: 'heal' | 'shield' = 'heal';
  /** Last `heal:allyTargetChanged` sent as `"<kind>:<name>"` (null = no givable item) — `undefined` = nothing yet. */
  allyAimName: string | null | undefined = undefined;


  readonly camHit = makeHit();
  readonly gunHit = makeHit();
  /**
   * 2026-09-12 hybrid shot resolution (`parts/AimLine`): one resolver shared by `fire()`, the unique services and
   * the blocked-muzzle marker, plus their scratch lines (`shot` = fire, `aimLine` = marker, `uniqueShot` = services).
   */
  readonly aim = new Aim.ShotResolver(this);
  readonly shot = Aim.makeShotLine();
  readonly aimLine = Aim.makeShotLine();
  /** Red ring on the surface the barrel meets (`fx/AimBlockMarker`). */
  aimMarker!: AimBlockMarker;
  /** Last `weapon:aimBlocked` sent. */
  aimBlocked = false;
  /** 2026-09-14: `aimLine` was resolved this frame for the weapon in hand (`updateAimBlock`) — the laser sight reads it. */
  aimLineValid = false;
  /**
   * 2026-09-14: projectile hits since the last `flushHitmarker` — merged into one `ui:hitmarker` per pool step, so a
   * shotgun's pellets that land together still show one marker (the hitscan path merged them per trigger pull).
   */
  hitmarkAny = false;
  hitmarkKill = false;
  hitmarkHead = false;
  private readonly weaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false, throwing: false, holdingItem: false, charging: false, spraying: false, heavy: false, altFire: false };
  /**
   * Phase 7: what the snapshot builder (net/) reads every tick — one object updated in place at the end of `update`.
   * `attachments` is replaced only when the socket set of the weapon in hand changes (`attachDirty` / uid change).
   */
  /**
   * `detonator` (2026-09-11, duck-typed — not in `WeaponRemoteState`): the hand is the virtual detonator (no C4
   * left to place; `heldItemId` still names the C4 def so remote avatars keep holding something). gadgets/ skips
   * the placement preview then.
   */
  private readonly remoteState: WeaponRemoteState & { attachments: readonly string[]; detonator: boolean } = { heldItemId: null, throwing: false, cooking: false, charging: false, spraying: false, heavy: false, attachments: [], detonator: false };
  private attachUid: string | null = null;
  attachDirty = false;
  private readonly attachScratch: string[] = [];

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.fx = new WeaponFx(ctx.scene);
    this.grenades = new GrenadeManager(ctx, this.fx);
    this.throwArc = new ThrowArc(ctx);
    // 2026-09-12: in the scene (hidden) from the start so the core shader warm-up compiles it with everything else
    this.aimMarker = new AimBlockMarker(ctx.scene);
    // Phase 3: live grenade positions for the HUD's off-screen indicators
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const sys = this;
    ctx.weapons = {
      getGrenades: () => this.grenades.getViews(),
      // Phase 7: per-frame pose / held item / attachment list for the player snapshot (`PlayerSnapshot.h / att`, THROWING… flags)
      remoteState: this.remoteState,
      // 2026-09-16 (the bottom-right weapon panel): the HUD asks every frame — to draw 「the last primary held」
      //   dimmed while a consumable is in hand or the gun is holstered, `weapon:equipped` alone is not enough (a
      //   swap or a loadout change finished with a consumable in hand never emits it). A melee swing does not count
      //   (2026-09-17 user's decision: melee is a swing with the primary still in hand — the panel must not blink).
      get activeSlot() { return sys.slots[sys.active] ? sys.active : null; },
      get primaryInHand() {
        return !!sys.slots[sys.active] && !sys.quick && !sys.holstered;
      },
      ammoOf: (slot) => {
        const w = this.slots[slot];
        return w ? { weaponId: w.stats.weaponId, magSize: w.stats.magSize, ammoInMag: this.magOf(w), reserveRounds: this.reserveOf(w) } : null;
      },
    };
    // 2026-09-14: every bullet flies through the pool, swept with the very query a hitscan shot used (`raycastAll`)
    this.projectiles = new ProjectilePool(ctx,
      (h, dmg, weaponId) => this.onProjectileHit(h, dmg, weaponId),
      (h, weaponId) => this.remote.onVisualProjectileHit(h, weaponId),
      (o, d, max, out) => this.raycastAll(o, d, max, out));
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
    ctx.bus.on('net:remoteGrenade', (p) => this.remote.onGrenade(p.position, p.velocity, p.fuse, p.id, p.fire));
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
      this.lastQuickIndex = null;
      this.lastQuickDetonator = false; this.droneLatch = false;
      this.fallbackGrenades = 4;
      this.loadoutWait = LOADOUT_FALLBACK_DELAY;
    });
    ctx.bus.on('game:abort', () => {
      this.dropQuick();
      this.flushAll();
      this.resetTransient();
      for (const s of WEAPON_SLOTS) this.setSlot(s, null);
      this.lastQuickIndex = null;
      this.lastQuickDetonator = false; this.droneLatch = false;
      this.loadoutWait = -1;
    });
    // Ship hub: nothing in flight, weapon holstered (visibility is handled per frame from ctx.phase).
    ctx.bus.on('hub:entered', () => { this.dropQuick(); this.resetTransient(); this.loadoutWait = -1; });
    // Hellpod drop started → pre-compile every shader (hidden FX meshes included) before the first shot/throw.
    ctx.bus.on('game:phaseChanged', ({ phase }) => { this.cancelHeal(); this.cancelDefib(); if (phase === 'deploying' || (phase === 'playing' && ctx.missionMode === 'training')) this.warmupFrames = 2; });
    // Phase 10: a heal hold survives damage but never a death / knock-down. The `usable` gate catches the same
    // frame; these keep the HUD gauge honest even when another path clears the hand state first.
    ctx.bus.on('player:died', () => { this.cancelHeal(); this.cancelDefib(); });
    ctx.bus.on('player:downed', () => { this.cancelHeal(); this.cancelDefib(); });
    /* 2026-09-21 (user's decision — the reload hold). 갈고리 is an **instant** implant: the gun stays in the hands
     * and the wire is out for a moment, so the reload is frozen for exactly that moment and continues after
     * (`parts/Firing.setReloadPause`). The release event also comes from every silent cut (death · phase change ·
     * drone control), so the hold can never be left standing. 대시 needs no subscription — it is a single-frame
     * teleport (`implant:dashed`), so there is no window to hold and the reload simply runs on through it. */
    ctx.bus.on('implant:grappleFired', () => Fire.setReloadPause(this, 'grapple', true));
    ctx.bus.on('implant:grappleReleased', () => Fire.setReloadPause(this, 'grapple', false));
    /* 오버차지 is the other **wielded** implant in the user's classification (the beam occupies the hands even
     * though `ImplantDef.mode` calls it `'hold'`), so starting the channel **cancels** the reload like 배리어 does
     * through `blocksWeapons`. `implant:activated` is the rising edge of the channel — `implant:overcharge` is
     * re-sent whenever the beam locks a different ally, which is not a new use and must not cancel anything.
     * 갈고리 · 대시 · 정찰 pass through here too and are deliberately left alone: they are the instant implants. */
    ctx.bus.on('implant:activated', ({ id }) => { if (id === 'overcharge' && this.phase === 'reloading') this.cancelReload(); });
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
    // 2026-09-14: bullet hits of this step → one merged hitmarker (eight pellets landing together are one marker)
    Fire.flushHitmarker(this);
    this.remote.update(dt);
    // Two frames into the drop: compile shaders for the pooled/hidden FX meshes — **only without `ctx.shaders`**.
    // 2026-09-10: core already compiles the whole scene (hidden meshes included) on `world:ready` and holds the frame
    // until the driver is done, against the composer's render target. This `renderer.compile` ran with no target bound
    // (the canvas: sRGB + ACES), so it compiled variants the game never draws — and its traversal alone cost ~170 ms
    // in the middle of the drop.
    if (this.warmupFrames > 0 && --this.warmupFrames === 0 && !ctx.shaders) this.fx.warmUp(ctx.renderer, ctx.scene, ctx.camera);

    // Phase 12: the spray ticker never outlives its channel — every end path funnels through `stopSpray`; this
    // is the backstop for any that clears the hold flags directly (`active:false` must always be the last event).
    if (this.channel && !(this.healHeld && this.healSpray)) this.closeChannel();

    this.ensureNet();
    const host = this.getHost();
    if (!host) { this.melee.cancel(); this.throwArc.hide(); this.setAimBlocked(false); return; }

    // 2026-09-21 (user's decision): the V roll **holds** the reload instead of cancelling it. Polled rather than
    // driven by `player:dived`, because the roll has no matching end event — `isDiving` is `PlayerController.rolling`,
    // so the hold releases itself the frame the roll is over, cancelled rolls included.
    Fire.setReloadPause(this, 'roll', host.isDiving === true);

    // ── holster outside gameplay (hub / docking / menu) or while a wielded implant is in the hands (tactical kit):
    //    model hidden, unarmed pose, neutral zoom. The implant case must NOT wipe grenades / projectiles.
    const phaseHolster = ctx.phase === 'hub' || ctx.phase === 'docking' || ctx.phase === 'menu';
    const implantHolster = !phaseHolster && ctx.implants?.blocksWeapons === true;
    // 2026-09-08: being downed puts the gun away too. `canUseWeapons()` already refused every action then, but
    //   nothing hid the model — the soldier lay there still holding a rifle. Same branch as the implant holster
    //   (drop the item in hand, cancel a reload, neutral zoom) so grenades / projectiles in flight are untouched.
    const downHolster = !phaseHolster && ctx.player?.isDowned === true;
    const holster = phaseHolster || implantHolster || downHolster;
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
      // 2026-09-10: with the secondary gone the fallback is one primary too (`WEAPON_SLOTS`).
      if (this.loadoutWait <= 0 && !this.slots.primary && !this.slots.primary2) {
        this.onLoadout({
          primary: { uid: 'default-primary', defId: defaultFor('primary').id, qty: 1, rotated: false },
          primary2: null,
          secondary: null,
        });
      }
    }

    const input = ctx.input;
    // Phase 3: an armed / targeting ship call owns the mouse — guns neither fire nor swap until it is put away
    const callActive = !!ctx.stratagems && (ctx.stratagems.armed !== null || ctx.stratagems.targeting);
    // 2026-09-11 drone control: the PC does nothing with its weapons while looking through a drone — and not
    // until every button the drone was using (LMB · RMB · R) is released afterwards. Checked here on its own,
    // not only through `canUseWeapons()`, so fire / reload / swap / melee / T / wheel / unique input / throw arc
    // all stop together.
    // The hand itself is left alone: when the control ends the player holds exactly what they held before.
    // 2026-09-13: riding the rover is the same latch — weapons · reload · swap · melee · T · the wheel all stop,
    //   and nothing leaks until every button is released after getting off
    if (ctx.player?.droneControl === true || ctx.player?.roverRide === true) this.droneLatch = true;
    else if (this.droneLatch && !input.isMouseDown(MouseButtons.FIRE) && !input.isMouseDown(MouseButtons.AIM) && !input.isDown(Keys.RELOAD)) this.droneLatch = false;
    const armedAndFree = ctx.isGameplayActive() && input.isPointerLocked && host.canUseWeapons() && host.isDiving !== true && !callActive && !this.droneLatch;
    // a wielded implant (Q) holsters the weapon: no firing, no reload, no swap, no quick use
    const usable = armedAndFree && !this.holstered;
    // the gun in hand (null while a consumable is held)
    const weapon = this.quick ? null : this.slots[this.active];

    // ── Phase 10 shouldering: with a squadmate on our shoulder only running is allowed. Any weapon input puts the
    //    body down first and does nothing else this frame — the next frame retries naturally once the player is free.
    //    (The F *tap* never reaches us while carrying: player/ pre-empts it with `input.consume(Keys.MELEE)` for the
    //    manual drop, and the unique F-hold reads `wasPressed` so it honours the same consumption.)
    const carryBusy = this.carryGate(usable);

    // ── melee (F, tactical kit). The player owns stamina / cooldown / animation; we only resolve the hit.
    if (armedAndFree && !carryBusy && !this.implantHolstered && !this.wheelOpen && !this.holding && !weapon?.unique?.handlesMelee && input.wasPressed(Keys.MELEE)) {
      if (this.melee.tryStart(host, weapon?.def ?? null)) {
        if (this.phase === 'reloading') this.cancelReload();
        this.firingTimer = FIRING_POSE_HOLD * 0.5;
      }
    }
    this.melee.update(dt, host);

    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.quickCooldown > 0) this.quickCooldown -= dt;
    // 2026-09-14: per-class recovery (weapons.csv bloomDecay) — pump / bolt guns recover slowly, so rapid follow-ups spread
    this.bloom = Math.max(0, this.bloom - (weapon?.stats.bloomDecay ?? BLOOM_DECAY) * dt);
    if (this.firingTimer > 0) this.firingTimer -= dt;
    this.updateBolt(dt, weapon);

    // ── quick-use key (T): tap = last consumable into the hand, hold = wheel
    this.updateQuickKey(dt, host, usable && !carryBusy);
    // the wheel eats mouse buttons as well as the look delta
    const inputFree = usable && !this.wheelOpen && !carryBusy;

    // ── swap (1 / 2) — also the way back from a consumable to a gun.
    // 2026-09-07: the previous-weapon key (V) is retired — V is the roll now, and Alt frees the cursor.
    // 2026-09-10: with the secondary (3) gone `Keys.SECONDARY` points at no slot — the binding stays (it is a
    //             contract) and is simply not read here (`WEAPON_SLOTS` has two slots, so a press draws nothing).
    if (inputFree) {
      const want: WeaponSlot | null | undefined =
        input.wasPressed(Keys.PRIMARY) ? 'primary'
          : input.wasPressed(Keys.PRIMARY2) ? 'primary2' : undefined;
      if (want !== undefined) this.requestSwap(want);
    } else if (this.implantHolstered && armedAndFree && !carryBusy && !this.wheelOpen) {
      // a wielded implant (`배리어` — the `대전차포` was retired 2026-09-15) is in the hands: a weapon key stows it
      //   and draws that weapon
      const want: WeaponSlot | null | undefined =
        input.wasPressed(Keys.PRIMARY) ? 'primary'
          : input.wasPressed(Keys.PRIMARY2) ? 'primary2' : undefined;
      if (want !== undefined) {
        ctx.implants?.stow();
        if (want && this.slots[want] && want !== this.active) this.requestSwap(want);
        else if (!want || !this.slots[want]) ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
      }
    }
    // 2026-09-21: a gun in the hands means the ally-heal chip has nothing to say (`updateQuickHand` owns it while
    //   a consumable is held; with none it is never called, so the last name would stay up).
    if (!this.quick) this.emitAllyAim(null, false, null);
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
    ws.altFire = armed && !!weapon?.unique && !weapon.unique.allowsAim;   // RMB = alt fire → player never enters ADS
    if (up?.firing) ws.firing = true;
    host.setWeaponState(ws);
    this.updateRemoteState(armed ? weapon : null);
    this.updateThrowArc(host);
    this.updateAimBlock(host, weapon, armedAndFree);
    this.updateLaser(dt, host, armed ? weapon : null);
  }

  /**
   * 2026-09-14 the laser sight: while aiming or for `FIRING_POSE_HOLD` after a shot the beam turns from the barrel
   * to where this frame's shot line ends (`aimLine.end` — the crosshair point, or the obstruction the red marker
   * shows); otherwise it follows the barrel. `WeaponModel.setLaserAim` blends and clamps. Remote replicas never
   * call it (barrel beam).
   */
  private updateLaser(dt: number, host: Host, weapon: WeaponInstance | null): void {
    for (const s of WEAPON_SLOTS) {
      const w = this.slots[s];
      if (!w || !w.model.hasLaser) continue;
      const aimed = w === weapon && this.aimLineValid && (host.isAiming || this.firingTimer > 0);
      w.model.setLaserAim(aimed ? this.aimLine.end : null, dt);
    }
  }

  /**
   * 2026-09-12 blocked muzzle: red ring where the barrel really hits + `weapon:aimBlocked` (`parts/AimLine`, the
   * same resolver as `fire()`).
   */
  private updateAimBlock(host: Host, weapon: WeaponInstance | null, armedAndFree: boolean): void { return Aim.updateAimBlock(this, host, weapon, armedAndFree); }

  /** Marker off when clear; `weapon:aimBlocked` only on change. */
  setAimBlocked(blocked: boolean): void { return Aim.setAimBlocked(this, blocked); }

  /**
   * The throw arc (2026-09-08). While a grenade or a throwable gadget is in the hand, re-simulate the throw that LMB
   * would make right now and draw it. The release maths is duplicated from `throwHeld` / `GadgetSystem.throwGadget`
   * on purpose: the preview has to use the numbers those two use, `근력` strength (`derived.throwRangeMul`)
   * included, and the two apply it differently (a grenade's range goes with speed², so it takes the square root;
   * a gadget scales the speed straight). The over/under-hand toggle and the player's own momentum ride along in
   * the release velocity.
   *
   * 2026-09-14 2nd pass (user's decision): `ThrowArc.show` now integrates **gravity only** — terrain · obstacles
   * are not in the preview (「던질 때 날아가는 방향 궤적만」). Not one line of what this function hands over changed.
   */
  private updateThrowArc(host: Host): void {
    const q = this.quick;
    const ctx = this.ctx;
    const gadgetThrow = !!q && q.kind === 'gadget' && this.isThrowGadget(q.def);
    const show = !!q && !this.holstered && !this.healHeld && !this.droneLatch && ctx.isGameplayActive()
      && host.canUseWeapons() && (q.kind === 'grenade' || gadgetThrow);
    if (!show) { this.throwArc.hide(); return; }
    const mul = ctx.progression?.derived.throwRangeMul ?? 1;
    host.getAimRay(_o, _d);
    if (gadgetThrow) {
      const range = Number.isFinite(mul) && mul > 0 ? mul : 1;
      const under = this.gadgetUnderhand;
      _tmp.copy(_o).addScaledVector(_d, 0.6);
      _md.copy(_d).multiplyScalar((under ? 8 : 17) * range).addScaledVector(host.velocity, 0.5);
      _md.y += under ? 2.4 : 3.5;
    } else {
      const throwMul = Math.sqrt(Math.max(0.25, mul));
      this.handPosition(host, _tmp);
      if (this.underhand) {
        _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * GRENADE_UNDERHAND_SPEED_MUL * throwMul).addScaledVector(host.velocity, 0.5);
        _md.y = Math.max(_md.y * 0.5, 0) + GRENADE_UNDERHAND_LIFT;
      } else {
        _md.copy(_d).multiplyScalar(GRENADE_THROW_SPEED * throwMul).addScaledVector(host.velocity, 0.5);
        _md.y += GRENADE_THROW_LIFT;
      }
    }
    this.throwArc.show(_tmp, _md);
  }

  /** True for a gadget that is lobbed (`use: 'throw'`) rather than placed / used on self / used on an ally. */
  private isThrowGadget(def: ItemDef): boolean {
    const id = def.gadgetId;                    // `ItemDef.gadgetId` is a plain string; the registry validates it
    if (!id) return false;
    const g = this.ctx.gadgets;
    if (!g) return false;
    return g.getDefs().find((d) => d.id === id)?.use === 'throw';
  }

  /**
   * Phase 7: mirror the pose / held item into `ctx.weapons.remoteState` (read by net/ for the snapshot). The
   * attachment list is rebuilt only when the weapon in hand changes or its sockets changed (`attachDirty`), and the
   * array instance is replaced only when the id set actually differs.
   */
  private updateRemoteState(weapon: WeaponInstance | null): void {
    const rs = this.remoteState, ws = this.weaponState;
    rs.heldItemId = ws.holdingItem && this.quick ? this.quick.defId : null;
    rs.detonator = ws.holdingItem && !!this.quick?.detonator;
    rs.throwing = ws.throwing;
    rs.cooking = ws.throwing && this.cooking;
    rs.charging = ws.charging;
    rs.spraying = ws.spraying;
    rs.heavy = ws.heavy;
    const uid = weapon ? weapon.uid : null;
    if (uid !== this.attachUid || this.attachDirty) {
      this.attachUid = uid;
      this.attachDirty = false;
      const ids = attachmentIdsOf(weapon?.inst, this.attachScratch);
      if (!sameIds(ids, rs.attachments)) rs.attachments = ids.slice();
    }
  }

  /** Bolt-action cycle after each sniper shot: blocks firing, drives the model's bolt animation and the cycle sound. */
  private updateBolt(dt: number, weapon: WeaponInstance | null): void { return Fire.updateBolt(this, dt, weapon); }

  /** Tell the player rig (and HUD) the ADS zoom + aim-in time of the weapon in hand. */
  applyAimZoom(stats: EffectiveWeaponStats | null): void { return Fire.applyAimZoom(this, stats); }

  dispose(): void {
    for (const u of this.netUnsub) u();
    this.netUnsub.length = 0;
    for (const s of WEAPON_SLOTS) this.setSlot(s, null);
    this.remote.dispose(); this.fx.dispose(); this.ufx.dispose(); this.grenades.dispose(); this.projectiles.dispose(); this.throwArc.dispose(); this.aimMarker.dispose();
  }

  /* ─────────────────────────── loadout ─────────────────────────── */
  getHost(): Host | null {
    const p = this.ctx.player as (PlayerRef & Partial<PlayerWeaponHost>) | null;
    if (!p || typeof p.getWeaponSocket !== 'function' || typeof p.getAimRay !== 'function') return null;
    return p as Host;
  }

  resolveDef(item: ItemInstance, slot: WeaponSlot): WeaponDef { return Slots.resolveDef(this, item, slot); }

  /** Graded + socketed stats for the instance (loot service), else derived from the bare def. */
  resolveStats(inst: ItemInstance, def: WeaponDef): EffectiveWeaponStats { return Slots.resolveStats(this, inst, def); }

  /** Attachment visuals from the instance's sockets (`att_brake`, `att_laser`, …) via the item defs (shared helper). */
  attachmentsFor(inst: ItemInstance): WeaponAttachmentVisuals { return Slots.attachmentsFor(this, inst); }

  private onLoadout(items: Record<WeaponSlot, ItemInstance | null>): void { return Slots.onLoadout(this, items); }

  /** `ammoInMag` / `durability` undefined on the instance → treat as full (loot normally initialises both). */
  initInstanceFields(w: WeaponInstance): void { return Slots.initInstanceFields(this, w); }

  setSlot(slot: WeaponSlot, inst: WeaponInstance | null): void { return Slots.setSlot(this, slot, inst); }

  /** Next occupied slot after `from` in 1 → 2 → 3 order (wrapping), or null. */
  nextOccupied(from: WeaponSlot): WeaponSlot | null { return Slots.nextOccupied(this, from); }

  /** Parent the active weapon model to the hand socket and announce it. */
  attachActive(announce: boolean): void { return Slots.attachActive(this, announce); }

  emitEmpty(): void { return Slots.emitEmpty(this); }

  /* ─────────────────────────── ammo / durability state (lives on the ItemInstance) ─────────────────────────── */
  magOf(w: WeaponInstance): number { return Slots.magOf(this, w); }

  durabilityOf(w: WeaponInstance): number { return Slots.durabilityOf(this, w); }

  /** Rounds of the weapon's calibre in the bag (v2); dev fallback without an inventory = `magSize × reserveMags`. */
  reserveOf(w: WeaponInstance): number { return Slots.reserveOf(this, w); }

  /**
   * Persist `ammoInMag` / `durability` through the inventory so it emits `inventory:itemUpdated` for the HUD / bag UI.
   * The fields are already written on the shared instance; `selfWriting` makes us ignore the echoed events.
   */
  persist(w: WeaponInstance, patch: { durability?: number; ammoInMag?: number }): void { return Slots.persist(this, w, patch); }

  flush(w: WeaponInstance): void { return Slots.flush(this, w); }

  private flushAll(): void { return Slots.flushAll(this); }

  emitAmmo(w: WeaponInstance): void { return Slots.emitAmmo(this, w); }

  emitDurability(w: WeaponInstance): void { return Slots.emitDurability(this, w); }

  findByUid(uid: string): WeaponInstance | null { return Slots.findByUid(this, uid); }

  findByModel(model: WeaponModel): WeaponInstance | null { return Slots.findByModel(this, model); }

  /** Stats to aim with: a unique without `allowsAim` aims at zoom 1 (RMB is its alt fire — since 2026-09-14 the bow's too, RMB cancels the draw). */
  zoomStatsFor(w: WeaponInstance): EffectiveWeaponStats | null { return Slots.zoomStatsFor(this, w); }

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
  private onItemUpdated(item: ItemInstance): void { return Slots.onItemUpdated(this, item); }

  /** `inventory:socketChanged`: stats (mag size, spread, zoom, …) and the attachment meshes change. */
  private onSocketChanged(item: ItemInstance): void { return Slots.onSocketChanged(this, item); }

  /** Try to put `rounds` of the weapon's calibre back into the bag (best effort; leftovers are lost). */
  returnRounds(w: WeaponInstance, rounds: number): void { return Slots.returnRounds(this, w, rounds); }

  /** Bag contents changed (ammo picked up / dropped / consumed) → refresh the reserve on the HUD. */
  private onInventoryChanged(): void { return Slots.onInventoryChanged(this); }

  /* ─────────────────────────── swap ─────────────────────────── */
  requestSwap(slot: WeaponSlot | null): void { return Slots.requestSwap(this, slot); }

  private updateSwap(dt: number): void { return Slots.updateSwap(this, dt); }

  /* ─────────────────────────── reload ─────────────────────────── */
  tryReload(w: WeaponInstance): void { return Fire.tryReload(this, w); }

  private updateReload(dt: number): void { return Fire.updateReload(this, dt); }

  /**
   * Reload interrupted (swap, consumable in hand, melee, implant holster, loadout change). Phase 10: this used to be
   * silent — the bottom-right panel only closed its arc because `weapon:equipped` followed. The crosshair reload
   * gauge needs the explicit cancel, so `weapon:reloadCancelled` goes out whenever a reload was really in progress.
   */
  cancelReload(): void { return Fire.cancelReload(this); }
  /** 2026-09-21: add / remove one reason the reload is **held** (the progress is kept) — `parts/Firing`. */
  setReloadPause(reason: ReloadPauseReason, on: boolean): void { return Fire.setReloadPause(this, reason, on); }
  /** True while the reload is frozen (debug / smoke). */
  get reloadHeld(): boolean { return this.reloadPauses.size > 0; }

  /* ─────────────────────────── firing ─────────────────────────── */
  /** Trigger pulled on a weapon with 0 durability: click, event, throttled toast. Nothing fires. */
  onBrokenTrigger(w: WeaponInstance): void { return Fire.onBrokenTrigger(this, w); }

  fire(host: Host, w: WeaponInstance): void { return Fire.fire(this, host, w); }

  /** Nearest of world & enemy raycasts into `out`. */
  raycastAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitInfo): void { return Fire.raycastAll(this, origin, dir, maxDist, out); }

  /* ───────────────── tactical kit: progression / implant modifiers (all optional, default 1) ───────────────── */
  /** Dexterity (Phase 5): consumable / gadget use speed — divides the quick-use cooldown. */
  useSpeedMul(): number { return Fire.useSpeedMul(this); }
  /**
   * Shooting-skill recoil multiplier for a class (1 when progression is not registered yet; 2026-09-15: always 1
   * for a legendary unique).
   */
  recoilMulFor(cls: WeaponClass, unique = false): number { return Fire.recoilMulFor(this, cls, unique); }

  /**
   * Shooting-skill reload speed multiplier for a class (>1 = faster; 2026-09-15: no skill part for a legendary
   * unique).
   */
  reloadSpeedFor(cls: WeaponClass, unique = false): number { return Fire.reloadSpeedFor(this, cls, unique); }

  /** Fire rate after the overcharge implant bonus. */
  effectiveFireRate(st: EffectiveWeaponStats): number { return Fire.effectiveFireRate(this, st); }

  /**
   * Phase 10 shouldering gate. While `ctx.player.carrying` holds a squadmate, every weapon action (fire, melee, swap,
   * throw, quick use, reload) puts the body down first and does nothing else this frame. Returns true when the frame
   * was spent dropping. Duck-typed so a player build without the carry API can never break the trigger.
   */
  private carryGate(usable: boolean): boolean { return Quick.carryGate(this, usable); }

  /** LMB with a gadget in hand: `ctx.gadgets.use` consumes the item itself; RMB toggles over / under-hand. */
  useGadget(host: Host, q: QuickHand): void { return Quick.useGadget(this, host, q); }

  /** 2026-09-11: RMB with a C4 / the detonator in hand — detonate every remote mine of mine (deny when none). */
  detonateHeld(host: Host): void { return Quick.detonateHeld(this, host); }

  /**
   * 2026-09-11: take the virtual detonator into the hand (`quick:equipped {index: null, item}`); false when no C4
   * def exists.
   */
  equipDetonator(defId: string | null, fromPlacement: boolean): boolean { return Quick.equipDetonator(this, defId, fromPlacement); }

  /** 2026-09-11: the detonator in hand, every frame — auto-return when my mines are gone, LMB deny, RMB detonate. */
  updateDetonator(dt: number, host: Host, inputFree: boolean): void { return Quick.updateDetonator(this, dt, host, inputFree); }

  /** Returns true if the hit killed an enemy. */
  applyHit(h: HitInfo, damage: number, dir: THREE.Vector3, light: boolean, ammoType?: string): boolean {
    /* 2026-09-14 (the NPC quest 「그 계열 총기로 처치」): one round's damage is stamped with the class of the gun now
       in hand — enemies writes a class only for local damage that arrives inside this scope (`shared/damageSource`).
       Grenades · gadgets · melee never take this path.
       2026-09-15 (user's decision): legendary uniques sit outside the class system — the csv `class` stays, but
       null is passed so the kill counts as a classless (ordinary) one. */
    const held = this.slots[this.active];
    const cls = held && !held.def.unique ? held.stats.weaponClass : null;
    return withLocalGunHit(cls, () => Fire.applyHit(this, h, damage, dir, light, ammoType));
  }

  private onProjectileHit(h: ProjectileHit, damage: number, weaponId: string): void { return Fire.onProjectileHit(this, h, damage, weaponId); }

  /* ─────────────────────────── quick-use (F): wheel & consumable in hand ─────────────────────────── */
  /**
   * F pressed → hold timer. Released before `QUICK_WHEEL_HOLD` = tap (last used consumable, else the first usable slot).
   * Held longer = wheel: look locked, mouse delta accumulated, hover = 8-way direction once the drag exceeds
   * `QUICK_WHEEL_DRAG_PX`; release equips the hovered slot.
   */
  private updateQuickKey(dt: number, host: Host, usable: boolean): void { return Quick.updateQuickKey(this, dt, host, usable); }

  closeWheel(host: Host): void { return Quick.closeWheel(this, host); }

  /** F tap: the last used consumable (else the first usable slot) into the hand; the same item again → back to the gun. */
  quickTap(): void { return Quick.quickTap(this); }

  deny(): void { return Quick.deny(this); }

  quickSlotCount(): number { return Quick.quickSlotCount(this); }

  /**
   * Usable consumable (stim / grenade) in wheel slot `index`, or null (empty, slot locked for the bag's quick-slot
   * count — see `isQuickSlotActive` / `QUICK_SLOT_UNLOCK_ORDER` —, wrong category).
   */
  quickSlotItem(index: number): { item: ItemInstance; def: ItemDef } | null { return Quick.quickSlotItem(this, index); }

  /** Take wheel slot `index` into the hand (`active = 'quick'`): gun drawn down, one-handed pose, `quick:equipped`. */
  equipQuick(index: number): void { return Quick.equipQuick(this, index); }

  /** Gun draw-down after taking a consumable (0.15 s), then the model hides itself (`drawT` ≤ 0.02). */
  private updateQuickHolster(dt: number): void { return Quick.updateQuickHolster(this, dt); }

  /** Clear the hand state (no swap, no events beyond `quick:equipped null`); the caller draws a gun or announces empty. */
  leaveQuick(): void { return Quick.leaveQuick(this); }

  /** Back to the gun that was in hand before the consumable (else the next occupied slot, else empty hands). */
  returnToGun(): void { return Quick.returnToGun(this); }

  /**
   * Hard exit from the hand state on world reset / abort / holster: the hold ends without a throw (the grenade pool is
   * cleared right after anyway), the gun model comes back instantly without a swap animation.
   */
  private dropQuick(): void { return Quick.dropQuick(this); }

  /**
   * `inventory:quickSlotsChanged`: the consumable in hand vanished (dropped, moved, consumed elsewhere) → back to the
   * gun. A sibling stack of the same def that the inventory relinked into the slot is adopted instead.
   */
  private onQuickSlotsChanged(slots: readonly (ItemInstance | null)[]): void { return Quick.onQuickSlotsChanged(this, slots); }

  /** Keep the hand on `cur` when it is our stack (or a same-def sibling stack); false when the slot no longer fits. */
  adoptSlot(cur: ItemInstance | null | undefined): boolean { return Slots.adoptSlot(this, cur); }

  /** LMB / R / RMB while a consumable is in hand. */
  private updateQuickHand(dt: number, host: Host, usable: boolean, inputFree: boolean): void { return Quick.updateQuickHand(this, dt, host, usable, inputFree); }

  /* ── consumable use (Phase 10 heal items → 2026-09-07 every healing consumable + the defibrillator) ─── */
  /**
   * `heal:holdChanged` at ≤ 30 Hz. `t` = 0..1 of the item's own use time while holding (remaining gauge for a
   * spray), `-1` on a cancel. `force` bypasses the throttle (start / finish / cancel must always land).
   */
  emitHeal(t: number, force: boolean, dur = HEAL_HOLD_S): void { return Heal.emitHeal(this, t, force, dur); }

  /**
   * Phase 12 perk `quick_heal` (`가속 대사`): every hold-to-use time (healing consumables and the defibrillator's
   * `DEFIB_USE_TIME_S`) is halved while the perk is active. The HUD ring reads the halved value from
   * `heal:holdChanged.dur`.
   */
  holdTimeOf(def: ItemDef): number { return Heal.holdTimeOf(this, def); }

  /**
   * `item:channelChanged` for the spray channel: `active:true` when it starts, ≤ `CHANNEL_EMIT_HZ` while it runs
   * (`gauge` 0..1), `active:false` when it stops for any reason. `force` bypasses the throttle (start / stop).
   */
  emitChannel(active: boolean, gauge01: number, force: boolean): void { return Heal.emitChannel(this, active, gauge01, force); }

  /** Close the ticker at the item's current gauge (`active:false`), whatever ended the channel. */
  closeChannel(): void { return Heal.closeChannel(this); }

  /** `스프레이가 비었습니다` — throttled like the broken-weapon toast so a held button does not spam it. */
  notifySprayEmpty(): void { return Heal.notifySprayEmpty(this); }

  /** Movement penalty while a consumable is being used (`CONSUMABLE_SLOW_MUL`); `1` releases it. */
  setConsumableSlow(on: boolean): void { return Heal.setConsumableSlow(this, on); }

  /** Is there shield left for a shield charger to fill? Rule and reason: `parts/Healing.canChargeShield`. */
  canChargeShield(): boolean { return Heal.canChargeShield(this); }

  /**
   * LMB pressed with a healing consumable / shield charger / defibrillator in hand. A plain heal is refused at
   * full hp (the old instant-use rule); a shield charger with no armor / a full shield; the spray only when its
   * gauge is empty (it also heals squadmates); the defibrillator never checks hp.
   */
  beginHeal(host: Host, q: QuickHand): void { return Heal.beginHeal(this, host, q); }

  /**
   * Accumulate while LMB stays down; releasing cancels. Taking damage does **not** cancel
   * (`HEAL_HOLD_CANCEL_ON_DAMAGE` is false — nothing here watches for damage on purpose).
   */
  updateHeal(dt: number, host: Host, q: QuickHand): void { return Heal.updateHeal(this, dt, host, q); }

  /**
   * The heal spray: every `spray.tick` seconds one gauge unit is spent, `healPerTick` hp goes to the user and to
   * every squadmate inside `spray.radius` (remote ones as a batched `buff heal`, the same wire the overcharge beam
   * uses). The gauge lives on the instance (`durability`), so a half-used can keeps its charge in the stash.
   */
  updateSpray(dt: number, host: Host, q: QuickHand): void { return Heal.updateSpray(this, dt, host, q); }

  /**
   * Phase 12: the spray channel ends (gauge empty, button released, swap, death, screen). The can is **never**
   * consumed — at 0 it stays in the slot with `durability` 0 until the ship repairs it. Closes both the HUD ring
   * (`heal:holdChanged -1`) and the ticker (`item:channelChanged active:false`).
   */
  stopSpray(): void { return Heal.stopSpray(this); }

  /** Squadmates inside `radius` owe `hp` this tick (flushed as `buff heal` at `SPRAY_SEND_INTERVAL`). */
  sprayAllies(hp: number, radius: number): void { return Heal.sprayAllies(this, hp, radius); }

  /** Send one `buff heal` per owed squadmate and clear the ledger. */
  flushSprayHeals(): void { return Heal.flushSprayHeals(this); }

  /** Hold completed: consume the item and apply its effect (a defibrillator hands off to the gadget path). */
  finishHeal(host: Host, q: QuickHand): void { return Heal.finishHeal(this, host, q); }

  /** Button released, swap, implant wield, death / downed, phase change, world reset: the hold is thrown away. */
  cancelHeal(): void { return Heal.cancelHeal(this); }

  /* ── defibrillator aiming (2026-09-15, parts/Defib) ── */
  /** Is the thing in hand a defibrillator — `updateQuickHand` sends only this hand to `updateDefibHand`. */
  isDefibHand(q: QuickHand): boolean { return Defib.isDefibHand(this, q); }

  /** Every frame: LMB charges → armed → aims → fires **on release** (broadcasts `gadget:defibAim`). */
  updateDefibHand(dt: number, host: Host, q: QuickHand, usable: boolean, inputFree: boolean): void { return Defib.updateDefibHand(this, dt, host, q, usable, inputFree); }

  /** Every path ending before the release (swap · death · phase · reset): closes the crosshair, consumes nothing. */
  cancelDefib(): void { return Defib.cancelDefib(this); }

  /* ── giving a healing consumable to a squadmate (2026-09-21, parts/AllyHeal) ── */
  /** Is the item in hand one the **right button** can give (heal item / 실드 충전기) — and is anybody there. */
  isAllyHealHand(q: QuickHand): boolean { return AllyHeal.isAllyHealHand(this, q); }
  /** What this item gives a squadmate (`'heal'` hp / `'shield'` points, −1 = fill up), null when nothing. */
  allyGiftOf(def: ItemDef): AllyHeal.AllyGift | null { return AllyHeal.allyGiftOf(def); }
  /** The squadmate (person or android) at the smallest angle off the crosshair inside `range`, null with none. */
  pickAllyTarget(host: Host, range: number, gift: AllyHeal.AllyGift): AllyHeal.AllyHealTarget | null { return AllyHeal.pickAllyTarget(this, host, range, gift); }
  /** `heal:allyTargetChanged` when the aimed squadmate (or its absence) changed. */
  emitAllyAim(name: string | null, inHand: boolean, kind: AllyHeal.AllyGift['kind'] | null): void { return AllyHeal.emitAllyAim(this, name, inHand, kind); }
  /** RMB pressed: start the ally hold (no movement penalty), or deny with nobody aimed at. */
  beginAllyHeal(host: Host, q: QuickHand): void { return AllyHeal.beginAllyHeal(this, host, q); }
  /** Every frame of the ally hold — release · target lost · out of `HEAL_ALLY_RANGE_HOLD` all cancel it. */
  updateAllyHeal(dt: number, host: Host, q: QuickHand): void { return AllyHeal.updateAllyHeal(this, dt, host, q); }
  /** Hold filled: consume one unit and send that squadmate a `buff heal`. */
  finishAllyHeal(host: Host, q: QuickHand): void { return AllyHeal.finishAllyHeal(this, host, q); }
  /** Ends the ally hold without consuming anything (folded into `cancelHeal`, so every cancel path covers it). */
  cancelAllyHeal(): void { return AllyHeal.cancelAllyHeal(this); }

  /**
   * Take one unit of the consumable in hand out of the bag. Returns the stack left (0 = gone) or −1 when nothing
   * could be consumed. The echoed `inventory:quickSlotsChanged` is ignored (`quickBusy`) so the `quick:used` event
   * goes out before we return to the gun.
   */
  consumeQuick(q: QuickHand): number { return Quick.consumeQuick(this, q); }

  /* ── grenade hold ── */
  fuseLeft(): number { return Throw.fuseLeft(this); }

  emitHold(): void { return Throw.emitHold(this); }

  beginHold(): void { return Throw.beginHold(this); }

  updateHold(dt: number, host: Host, q: QuickHand): void { return Throw.updateHold(this, dt, host, q); }

  /** LMB released: lob the grenade with the remaining fuse; the stack shrinks by one. */
  throwHeld(host: Host, q: QuickHand, dropAtFeet: boolean): void { return Throw.throwHeld(this, host, q, dropAtFeet); }

  /** Cooked past `GRENADE_COOK_MAX`: the grenade goes off in the hand (self damage included). */
  explodeInHand(host: Host, q: QuickHand): void { return Throw.explodeInHand(this, host, q); }

  /** Hold interrupted (swap / holster / death / abort / other item): no throw — unless the pin is pulled, then it drops at the feet. */
  cancelHold(host: Host): void { return Throw.cancelHold(this, host); }

  endHold(emit: boolean): void { return Throw.endHold(this, emit); }

  /** Right hand in front of the shoulder (grenade release point). */
  handPosition(host: Host, out: THREE.Vector3): void { return Throw.handPosition(this, host, out); }

  emitGrenadeCount(): void { return Throw.emitGrenadeCount(this); }

  private resetTransient(): void {
    this.melee.cancel();
    this.throwArc.hide();
    this.setAimBlocked(false);
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
    this.cancelHeal();
    this.cancelDefib();
    // 2026-09-21: the reload hold is transient state too — a mission reset must not leave a stale reason behind,
    // or the next reload would freeze with nothing holding it.
    this.reloadPauses.clear();
    this.slots[this.active]?.model.setReload(-1);
    this.slots[this.active]?.model.setBolt(-1);
    this.applyAimZoom(null);
  }

  /* ─────────────────────────── Phase 6: unique weapon services ─────────────────────────── */
  readonly uniqueHit = makeHit();
  /** 2026-09-12: scratch line for the services' `aimTarget` / `aimShot` / `hitscan` (hybrid resolver). */
  readonly uniqueShot = Aim.makeShotLine();

  /**
   * The narrow API a `UniqueHandler` gets. Ammo / durability stay on the shared item instance and go through
   * `persist()` exactly like regular shots; the hitscan helper mirrors `fire()`'s single-pellet path.
   */
  private buildServices(): UniqueServices { return Svc.buildServices(this); }
}
