import type * as THREE from 'three';
import type { GamePhase, ItemInstance, MissionStats, EnemyType, Stance, HubShipKind, ChatKind, PingKind, WeaponSlot, SocketSlot, StratagemId } from './types';
/* appended (2026-09-09): raid play improvements — structures · hazards · the comms wheel */
import type { StructureKind, HazardKind } from './types';
/* appended (2026-09-11) */
import type { LadderDef } from './types';
import type { CommsId } from './comms';
/* appended (Phase 10): varied enemy deaths / probabilistic corpse looting */
import type { EnemyDeathDir } from './types';
/* appended (2026-09-08): scrap metal supply — the scrap gather node */
import type { GatherNodeKind } from './types';
import type { LobbyErrorCode, LobbyState, PeerId } from './net';
import type { EquipSlot, WeightState } from './gear';
import type { ImplantId, ScanTarget } from './implants';
import type { DeployableKind, GadgetId } from './gadgets';
/* appended (2026-09-11): drones · named rogues */
import type { DroneKind, DroneReleaseReason } from './drones';
import type { NamedRogueType } from './named';
import type { PlayerProfile, SkillId, StatId } from './progression';
import type { EquippedImplant } from './progression';
/* appended (2026-09-06): ship housing payloads */
import type { FacilityId, PlacedFurniture, RoomPurpose, ShipState } from './housing';
/* appended (2026-09-12): library media (A-3e) · the gym (A-3a) */
import type { GymMinigame, ShelfMedium } from './housing';
import type { GymSessionResult, GymStat } from './progression';
import type { FurniturePoseKind } from './types';
/* appended (2026-09-12): character buffs */
import type { CharBuff } from './charBuffs';
/* appended (2026-09-08): the tutorial */
import type { TutorialStepId } from './tutorial';
/* appended (2026-09-15): the cause of death · damage taken by cause */
import type { PlayerDamageSource } from './types';
/* appended (2026-09-13): cooking material tiers */
import type { GrowSocketTarget, SampleFamily } from './types';

/**
 * Every cross-module message goes through the typed EventBus with these payloads.
 * Naming: `<domain>:<fact or command>`. Commands are imperative, facts are past tense.
 */
export interface GameEvents {
  /* ── game flow (owner: game/GameFlowSystem) ─────────────────────────── */
  'game:phaseChanged': { phase: GamePhase; prev: GamePhase };
  /** Command: start a fresh mission. World must generate synchronously and then emit world:ready. */
  /** `mode` (appended, Phase 7): `'training'` = 시뮬레이션 훈련장 instead of the planet (default `'raid'`). */
  /**
   * `planet` (appended, Phase 11): 목표 행성 of this raid. Absent = generate the old way (biome and sky drawn from
   * the seed). The emitter sets `ctx.missionPlanet` before emitting, exactly as it does for `ctx.missionMode`.
   */
  'game:newMission': { seed: number; mode?: import('./types').MissionMode; planet?: PlanetId };
  /** Command: return to menu; all systems reset visuals/state. */
  'game:abort': Record<string, never>;
  'game:complete': { stats: MissionStats };
  'game:over': { stats: MissionStats };
  /**
   * `freeze` (appended, default true): when false the pause menu is shown but the simulation keeps running
   * (multiplayer — Engine keeps dt > 0 and systems must not stop ticking). Owner: game/GameFlowSystem.
   */
  'game:paused': { paused: boolean; freeze?: boolean };
  /**
   * appended (2026-09-13): Command — the pause menu's `함선으로 귀환` emits it after the 1 s hold confirm on its warning
   * popup. During a raid the player **dies fully** on the spot (the same loss as a real death — a squad leaves it on the
   * corpse, a solo player loses everything) and goes to the ship after the death cinematic. Outside a raid (training ·
   * mid-drop · the result screen) it goes straight to `hub:enter` as before. Owner: game/ (`parts/Death.requestReturnToShip`).
   */
  'game:returnToShip': Record<string, never>;

  /* ── world (owner: world/WorldSystem) ───────────────────────────────── */
  /** `planet` (appended, Phase 11): what the world was generated for; null = the seeded biome draw. */
  'world:ready': { seed: number; playerSpawn: THREE.Vector3; planet?: PlanetId | null };
  'world:cleared': Record<string, never>;
  /** A crate was interacted with; Inventory opens the container window. */
  'crate:open': {
    crateId: string; tier: number; position: THREE.Vector3;
    /* appended (2026-09-14, the NPC quest `search` objective): for a structure · rail platform · tram container, that zone's id and kind. A world crate has none. */
    zoneId?: string; zoneKind?: StructureKind | 'platform' | 'tram';
  };
  'crate:looted': { crateId: string };   // emitted by inventory when container becomes empty

  /* ── player (owner: player/PlayerSystem) ────────────────────────────── */
  'player:spawned': { position: THREE.Vector3 };
  'player:healthChanged': { hp: number; maxHp: number; delta: number };
  /** `source` appended (2026-09-15): where this damage came from (exactly the third argument of `PlayerRef.takeDamage`). Omitted = unknown. */
  'player:damaged': { amount: number; hp: number; from?: THREE.Vector3; source?: PlayerDamageSource };
  /** `source` appended (2026-09-15): where the last (killing) damage came from — for a bleed-out after being downed, the source of the damage that downed the player. Omitted = unknown. */
  'player:died': { position: THREE.Vector3; source?: PlayerDamageSource };
  'player:stimUsed': { hp: number };
  'player:sprintChanged': { sprinting: boolean };
  'player:aimChanged': { aiming: boolean };
  'player:landed': { impactSpeed: number };
  /**
   * appended (2026-09-14, owner: player): **fall damage** landed (a global feature — not tutorial-only).
   * `height` = how far the body really fell (m), `damage` = the total taken off the shield and hp. `rule` is the answer
   * of `ctx.world.tutorial?.fallRule()` — `'kill'` (instant death) · `'clamp'` (never below 1 hp) only on the tutorial's
   * cliffs, `'normal'` everywhere else. Nothing is emitted when the damage is 0 (inside the safe height).
   */
  'player:fell': { height: number; damage: number; rule: import('./tutorialWorld').TutorialFallRule };
  /** appended (2026-09-14, owner: player): the tutorial's opening wake-up cinematic ended and control is back. */
  'player:introWakeDone': Record<string, never>;
  'player:footstep': { position: THREE.Vector3; sprinting: boolean };
  /** 2026-09-09 (additive): `hold` = the current interactable has a `holdTime` — the prompt keycap gets a ⌄ chevron. */
  'interact:promptChanged': { text: string | null; holdProgress: number; hold?: boolean };
  'interact:performed': { id: string };
  /* appended: stance / stamina / dive */
  'player:stanceChanged': { stance: Stance; prev: Stance };
  /** Dive started (Alt). `direction` is the horizontal unit vector of the dive. */
  'player:dived': { position: THREE.Vector3; direction: THREE.Vector3 };
  /** Stamina hit zero (sprint cut off). */
  'player:staminaDepleted': Record<string, never>;

  /* ── weapons (owner: weapons/WeaponSystem) ──────────────────────────── */
  /** `slot` widened to `WeaponSlot` (weapon package). `reserveRounds` = rounds of the weapon's calibre in the bag. */
  'weapon:equipped': { slot: WeaponSlot; weaponId: string; name: string; magSize: number; ammoInMag: number; reserveRounds: number };
  'weapon:ammoChanged': { weaponId: string; ammoInMag: number; magSize: number; reserveRounds: number };
  'weapon:fired': { weaponId: string; origin: THREE.Vector3; direction: THREE.Vector3 };
  'weapon:dryFire': { weaponId: string };
  'weapon:reloadStarted': { weaponId: string; duration: number };
  'weapon:reloadFinished': { weaponId: string };
  'weapon:hit': { point: THREE.Vector3; normal: THREE.Vector3; enemyId: number | null; damage: number; killed: boolean };
  'grenade:thrown': { position: THREE.Vector3; velocity: THREE.Vector3 };
  'grenade:exploded': { position: THREE.Vector3; radius: number };
  'grenade:countChanged': { count: number };
  'stim:countChanged': { count: number };
  /** Command from Inventory → Weapons: loadout changed (equip/unequip). `primary2` / `bag` appended (weapon package). */
  'loadout:changed': { primary: ItemInstance | null; secondary: ItemInstance | null; primary2: ItemInstance | null; bag: ItemInstance | null; armor?: ItemInstance | null };
  /** Active weapon's ADS zoom changed (equip/swap). HUD shows the scope overlay while aiming when `scope` is true. */
  'weapon:scopeChanged': { zoom: number; scope: boolean };

  /* ── enemies (owner: enemies/EnemySystem) ───────────────────────────── */
  'enemy:spawned': { id: number; type: EnemyType; position: THREE.Vector3 };
  'enemy:damaged': { id: number; type: EnemyType; amount: number; position: THREE.Vector3; hp: number };
  /** `by` (appended, Phase 9): PeerId | 'local' credited (burn kills go to the fire's owner), null for an AI / unknown kill. */
  /** `deathDir` appended (Phase 10): which way the body went down (enemies/ decides it seeded, so it replicates). */
  'enemy:killed': {
    id: number; type: EnemyType; position: THREE.Vector3; by?: string | null; deathDir?: EnemyDeathDir;
    /* appended (2026-09-14, the NPC quest `kill` objective): with `by === 'local'`, the class of **my killing blow** when it was a gun, else null (grenade · gadget · melee · burn).
       Omitted = unknown (the old path) — an objective with a class condition does not count it. A non-host fills it in for its own kills too. */
    weaponClass?: WeaponClassForKill | null;
  };
  'enemy:attacked': { id: number; type: EnemyType; damage: number; position: THREE.Vector3 };
  'enemy:alerted': { id: number; type: EnemyType; position: THREE.Vector3 };
  'enemy:waveStarted': { index: number; count: number };
  /** Command (enemies → player): apply a movement slow (speed × factor) for `duration` seconds (spewer acid). */
  'player:applySlow': { duration: number; factor: number };

  /* ── inventory / items (owner: inventory/InventorySystem) ───────────── */
  'inventory:opened': { containerId: string | null };
  'inventory:closed': Record<string, never>;
  'inventory:changed': { totalValue: number; itemCount: number };
  /**
   * 2026-09-12 (appended optional): `fromStash` true = the item was **moved** from the ship stash into the bag (it was
   * not newly acquired). ui/hud/Notifications draws no pickup ticker for that line (user's decision). Omitted = acquired, as before.
   */
  'inventory:itemAdded': { item: ItemInstance; name: string; rarity: string; fromStash?: boolean };
  'inventory:itemRemoved': { item: ItemInstance };
  'inventory:full': { item: ItemInstance; name: string };
  'inventory:itemRotated': { item: ItemInstance };

  /* ── extraction (owner: extraction/ExtractionSystem) ────────────────── */
  'extraction:activated': { pointId: string; position: THREE.Vector3; duration: number };
  'extraction:tick': { remaining: number; total: number };
  'extraction:shipIncoming': { position: THREE.Vector3; eta: number };
  'extraction:shipLanded': { position: THREE.Vector3 };
  'extraction:boarded': Record<string, never>;
  /**
   * 2026-09-13 (appended optional): `aboard` = **this client's player** was alive inside the ship and left with it
   * (omitted = true, the old meaning). `squadDone` = not one squadmate is left alive outside the ship — the raid is over
   * for everyone (for a solo player it equals `aboard`). Both false = this person was left behind and the raid goes on
   * (`extraction:reset` follows).
   */
  'extraction:liftoff': { position: THREE.Vector3; aboard?: boolean; squadDone?: boolean };
  'extraction:doorsClosed': Record<string, never>;

  /* ── ui / audio (owner: ui/HudSystem, audio/AudioSystem) ────────────── */
  'ui:notify': { text: string; kind?: 'info' | 'warning' | 'danger' | 'success'; duration?: number };
  'ui:objective': { text: string; subText?: string };
  'ui:hitmarker': { kill: boolean; headshot?: boolean };
  'ui:damageIndicator': { from: THREE.Vector3 };
  'camera:shake': { intensity: number; duration: number };
  'audio:play': { id: string; position?: THREE.Vector3; volume?: number; pitch?: number };
  /* appended: ping / map / pointer lock (owner: ui/HudSystem unless noted) */
  /** A ping was placed (middle mouse). `kind` = what the ping ray hit. `expires` = ctx.time when it auto-clears. */
  'ping:placed': { id: number; position: THREE.Vector3; kind: PingKind; expires: number };
  'ping:removed': { id: number };
  'ui:mapToggled': { open: boolean };
  /** Pointer lock was lost while gameplay was active (Esc / focus loss). Owner: game/GameFlowSystem. Pause menu follows. */
  'input:pointerLockLost': Record<string, never>;

  /* ── appended: multiplayer (owner: net/NetSystem unless noted; see shared/net.ts) ── */
  'net:statusChanged': { status: 'offline' | 'connecting' | 'connected' | 'error'; reason?: string };
  'net:error': { code: LobbyErrorCode; message: string };
  /** Lobby created/joined/changed (players, ready flags, host). Fires with the full state every time. */
  'net:lobbyUpdated': { lobby: LobbyState };
  /** We left (or were dropped from) the lobby; `ctx.net.lobby` is null afterwards. */
  /**
   * `'moved'` + `to` appended (2026-09-11, B-6): the server moved me straight into lobby `to` (같이 하기 / invite accept);
   * its `net:lobbyUpdated` follows at once — the hub skips the undock cutscene and docks into the new shared ship.
   */
  'net:lobbyLeft': { reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved'; to?: string };
  'net:peerJoined': { id: PeerId; name: string; slot: number };
  'net:peerLeft': { id: PeerId; name: string };
  /** Server accepted the host's start. Net emits `game:newMission {seed}` right after this. */
  /** `rejoin` / `mode` (appended, Phase 7): `rejoin` true when re-entering a running mission (player waits for `restoreState`). */
  /** `planet` appended (Phase 11): 목표 행성 from `game:start` / `LobbyState.planet` on a rejoin. */
  'net:gameStarting': { seed: number; lobby: LobbyState; rejoin?: boolean; mode?: import('./types').MissionMode; planet?: PlanetId };
  /** A RemotePlayerRef was created (first snapshot arrived) / removed (peer left). */
  'net:remotePlayerAdded': { id: PeerId };
  'net:remotePlayerRemoved': { id: PeerId };
  /** A remote player fired (from FireMessage). Weapons plays tracer/flash, audio plays the shot. */
  'net:remoteFired': { id: PeerId; weaponId: string; origin: THREE.Vector3; direction: THREE.Vector3 };
  'net:remoteReloaded': { id: PeerId; weaponId: string };
  /** `fuse` (appended, Phase 2) = seconds left on the replica grenade (undefined → GRENADE_FUSE). */
  /** `fire` (appended, 2026-09-15 B-16) = `GrenadeMessage.fire` — true = G-10 소이 수류탄, undefined = 보낸 쪽이 싣지 않았다. */
  'net:remoteGrenade': { id: PeerId; position: THREE.Vector3; velocity: THREE.Vector3; fuse?: number; fire?: boolean };
  'net:remoteDied': { id: PeerId; name: string; position: THREE.Vector3 };
  /** A remote player placed a ping (from PingMessage). Owner: ui/hud/Pings renders it. */
  'net:remotePing': { id: PeerId; position: THREE.Vector3; kind: PingKind };
  'net:chat': { id: PeerId; name: string; text: string; kind?: ChatKind };
  /** Command (ui → ui): open/close the multiplayer lobby screen. Owner: ui/menus/LobbyMenu. */
  'ui:lobbyToggled': { open: boolean };

  /* ── appended: ship hub (owner: hub/HubSystem unless noted) ─────────────── */
  /**
   * Command (ui/menus, net → hub): build `ship` and put the player inside (phase 'hub'). If a mission or menu is
   * active the hub aborts it first (`game:abort`). 'shared' requires `ctx.net.lobby`; otherwise falls back to 'personal'.
   */
  'hub:enter': { ship: HubShipKind };
  /** Fact: interior built, player spawned standing at `spawn`. `ctx.hub.ship` / `ctx.hub.collider` are valid. */
  'hub:entered': { ship: HubShipKind; spawn: THREE.Vector3 };
  /** Fact: hub torn down (mission starting / back to title). `ctx.hub.ship` is null afterwards. */
  'hub:left': Record<string, never>;
  /** Docking cutscene (personal → shared) or undocking (shared → personal) started / finished. Phase is 'docking' in between. */
  'hub:docking': { stage: 'start' | 'end'; direction: 'dock' | 'undock' };
  /** A launch pod changed occupancy (local or remote). `peerId` null = emptied. */
  'hub:slotChanged': { slot: number; peerId: PeerId | null; local: boolean };
  /** Host / solo: everyone is boarded → launch countdown ticking (`seconds` left, 0 = launching now). */
  'hub:launchCountdown': { seconds: number; ready: number; total: number };
  /** Command (hub ui → hub): open/close the ship terminal / hub menu. */
  'ui:hubMenuToggled': { open: boolean };

  /* ── appended: drop / split / pickups (owner: inventory → pickups/PickupSystem) ── */
  /** Inventory removed the item; PickupSystem spawns it as a world pickup thrown from `position` with `velocity`. */
  'inventory:itemDropped': { item: ItemInstance; position: THREE.Vector3; velocity: THREE.Vector3 };
  'inventory:itemSplit': { source: ItemInstance; created: ItemInstance };
  /** Owner: pickups. Emitted for local and replicated pickups. */
  'pickup:spawned': { id: string; item: ItemInstance; position: THREE.Vector3 };
  /** `byLocal` true when the local player took it (item already added to the bag). */
  'pickup:taken': { id: string; item: ItemInstance; byLocal: boolean; byName: string | null };
  'pickup:removed': { id: string };

  /* ── appended: chat (owner: ui/hud/ChatLog) ────────────────────────────── */
  /**
   * Command (any → ChatLog): post a line as the local player. ChatLog shows it, and — while in a lobby — sends it as
   * `ChatMessage {kind}` to 'others'. Pings (item / ammo request) and the hub use this.
   */
  'chat:post': { text: string; kind: ChatKind };
  /** Fact: a line was added to the log (own, remote or system). `id` null = local/system. */
  'chat:message': { id: PeerId | null; name: string; text: string; kind: ChatKind; local: boolean };
  /** Text-chat input opened/closed (Enter). ChatLog adds the `'chat'` blocker token while open. */
  'ui:chatToggled': { open: boolean };

  /* ── appended: pings v2 (owner: ui/hud/Pings) ──────────────────────────── */
  /** Widened `ping:placed.kind`: see `PingKind`. Enemy pings only track the enemy while it is visible. */
  'ping:placedV2': { id: number; position: THREE.Vector3; kind: PingKind; expires: number; owner: PeerId | null };

  /* ── appended: reconnection (owner: net/NetSystem) ─────────────────────── */
  /** The socket dropped while in a lobby; auto-reconnect is running (`attempt` 1..n). GameFlow keeps the mission alive. */
  'net:reconnecting': { attempt: number; nextInMs: number };
  /**
   * Connected with a stored session token and the server still had us in a lobby (fresh page load or after a drop).
   * `inProgress` = the lobby's mission is running; the player may rejoin via a launch slot (`ctx.net.rejoinMission()`).
   * `seamless` = the drop happened mid-mission on this page and the same mission is still running → nothing to rebuild.
   */
  'net:resumed': { lobby: LobbyState; inProgress: boolean; seamless: boolean };
  /** Quick-match result. `created` = no open ship was found so a new public one was created. */
  'net:matched': { lobby: LobbyState; created: boolean };

  /* ── appended: weapon package (2026-09-05) ─────────────────────────────── */
  /** Owner: weapons. Durability of the weapon instance `uid` changed (per shot / repair). `max` from effective stats. */
  'weapon:durabilityChanged': { uid: string; weaponId: string; durability: number; max: number };
  /** Owner: weapons. Trigger pulled on a weapon with 0 durability (HUD flashes, audio clicks). */
  'weapon:broken': { uid: string; weaponId: string };
  /** Owner: weapons. A swap to `slot` began; `duration` = holster + draw time (primary 0.4 s, secondary 0.1 s). */
  'weapon:swapStarted': { slot: WeaponSlot; duration: number };
  /** Owner: inventory. Persistent instance fields changed (`durability` / `ammoInMag` / repair / unload). */
  'inventory:itemUpdated': { item: ItemInstance };
  /** Owner: inventory. Socket contents of a weapon changed (`attachment` null = removed). Weapons recompute stats. */
  'inventory:socketChanged': { weapon: ItemInstance; socket: SocketSlot; attachment: ItemInstance | null };
  /** Owner: inventory. Bag grid resized (bag equipped / removed). `dropped` = items that no longer fit (already dropped to the world). */
  'inventory:bagChanged': { cols: number; rows: number; quickSlots: number; dropped: ItemInstance[] };
  /** Owner: hub. Workbench (repair) menu opened / closed (blocker token 'hub'). */
  'hub:workbenchToggled': { open: boolean };

  /* ── appended: Phase 2 — down / revive / respawn (owner: player unless noted) ─── */
  /** hp hit 0: the player is 전투불능 (crawling, `downHp` bleeding). `player:died` follows only when `downHp` reaches 0. */
  'player:downed': { position: THREE.Vector3 };
  /** Every change of `downHp` while downed (bleed tick / damage). */
  'player:downHpChanged': { downHp: number; max: number };
  /** Back on our feet (teammate revive). */
  'player:revived': { hp: number };
  /** Someone is reviving us (`t` 0..1, from the reviver's hold; owner: net relays `revive progress`). `t` −1 = cancelled. */
  'player:reviveProgress': { t: number; by: PeerId | null; byName: string | null };
  /** Command (game → player, inventory): respawn at `position` like at mission start (hellpod). Inventory reapplies the starter kit. */
  'player:respawn': { position: THREE.Vector3 };
  /** Command (ui → game): the player wants to respawn (only honoured when `game:respawnAvailable` reached 0). Owner: game. */
  'game:respawn': Record<string, never>;
  /** Owner: game. While dead: seconds until respawn is allowed (ticks each second; 0 = available now). */
  'game:respawnAvailable': { seconds: number };
  /** Owner: net. A squadmate went down / got back up (from snapshot flags). */
  'net:remoteDowned': { id: PeerId; name: string; position: THREE.Vector3 };
  'net:remoteRevived': { id: PeerId; name: string };

  /* ── appended: Phase 2 — quick-use wheel / consumables (owner: inventory / weapons) ── */
  /** Owner: inventory. Wheel slot assignment changed (`slots` length QUICK_SLOTS; `active` = usable count). */
  'inventory:quickSlotsChanged': { slots: (ItemInstance | null)[]; active: number };
  /** Owner: weapons. Wheel opened / hover changed / closed (F held). `hover` = slot index under the cursor or null. */
  'quick:wheelChanged': { open: boolean; hover: number | null };
  /** Owner: weapons. A consumable is now in hand (`item` null = back to a gun). */
  'quick:equipped': { index: number | null; item: ItemInstance | null };
  /** Owner: weapons. A consumable was used (stim injected / grenade thrown). `remaining` = stack left. */
  'quick:used': { index: number; item: ItemInstance; remaining: number };
  /**
   * Owner: weapons. Grenade in hand: `holding` while LMB is down (wind-up pose), `cooking` after R pulled the pin,
   * `cooked` seconds so far (explodes in hand at GRENADE_COOK_MAX), `fuse` seconds the grenade will have on release,
   * `underhand` toggle (RMB). Emitted on every change and each frame while cooking.
   */
  'grenade:holdChanged': { holding: boolean; cooking: boolean; cooked: number; fuse: number; underhand: boolean };

  /* ── appended: Phase 3 — ship calls / stratagems (owner: stratagems/StratagemSystem) ── */
  /** G held → wheel open / hover changed / closed. */
  'stratagem:wheelChanged': { open: boolean; hover: StratagemId | null };
  /** A call is in hand (null = put away; guns are usable again). */
  'stratagem:armed': { id: StratagemId | null };
  /** Orbital calls: LMB charge 0..1 before the top view opens (−1 = released early / cancelled). */
  'stratagem:chargeChanged': { t: number };
  /** Targeting mode on/off (top view for orbital calls, ground ring for drops). `position` = current cursor point while active. */
  'stratagem:targeting': { active: boolean; kind: StratagemId | null; position: THREE.Vector3 | null };
  /** A call was confirmed (local or remote). `landsAt` = ctx.time when the effect starts. */
  'stratagem:called': { callId: string; kind: StratagemId; position: THREE.Vector3; landsAt: number; caller: PeerId | null };
  /** Effect started at the target (beam ignites / bomb detonates / crate or structures touched down). */
  'stratagem:landed': { callId: string; kind: StratagemId; position: THREE.Vector3 };
  /** Effect finished (beam off / crate looted or expired / structures all destroyed is NOT this — see structure:destroyed). */
  'stratagem:ended': { callId: string; kind: StratagemId };
  /**
   * Shared cooldown (seconds left, total). Emitted on start, every ~0.5 s and at 0.
   *
   * `refunded` (appended 2026-09-11, E-8): this 0 is `StratagemSystem.refundCooldown` giving the cooldown back
   * because the host **refused** the call (`strat deny`) — not a cooldown that actually ran out. The HUD gauge
   * reads it the same either way; the toast must not, or a refusal shows 「거절」 and 「준비 완료」 side by side.
   */
  'stratagem:cooldown': { remaining: number; total: number; refunded?: boolean };
  /** A dropped cover structure took damage / was destroyed. */
  'structure:damaged': { id: string; hp: number; maxHp: number; position: THREE.Vector3 };
  'structure:destroyed': { id: string; position: THREE.Vector3 };

  /* ── appended: Phase 4 — rogues / enemy gimmicks / corpses (owner: enemies) ── */
  /** A rogue fired its gun (tracer from `from` to `to`; `hit` = a player was hit). Audio/FX are the enemies folder's own. */
  'enemy:shot': { id: number; type: EnemyType; from: THREE.Vector3; to: THREE.Vector3; hit: boolean };
  /** Artillery shell lifecycle (`sid` = shell id; shells are `InterceptableRef`s). */
  'enemy:shellFired': { sid: number; from: THREE.Vector3; target: THREE.Vector3; flightTime: number };
  'enemy:shellIntercepted': { sid: number; position: THREE.Vector3 };
  'enemy:shellLanded': { sid: number; position: THREE.Vector3; radius: number };
  /** Behemoth started a line charge toward `target` / hit something. */
  'enemy:chargeStarted': { id: number; position: THREE.Vector3; target: THREE.Vector3 };
  /** Toxic bug burst (friendly fire to bugs too). */
  'enemy:toxicBurst': { id: number; position: THREE.Vector3; radius: number };
  /** A boss (rogue_boss) appeared with its escorts. */
  'enemy:bossSpawned': { id: number; type: EnemyType; position: THREE.Vector3 };
  /** A lootable corpse is available (`Interactable` `corpse:<enemyId>`), removed after CORPSE_LIFETIME or when looted. */
  /** `lootable` / `deathDir` appended (Phase 10): false = this corpse rolled un-searchable (`CORPSE_LOOT_CHANCE`). */
  'corpse:spawned': { enemyId: number; type: EnemyType; position: THREE.Vector3; lootable?: boolean; deathDir?: EnemyDeathDir };
  'corpse:removed': { enemyId: number };
  /** Two factions clashing nearby (first contact only, throttled) — HUD may toast `교전 감지`. */
  'enemy:factionClash': { position: THREE.Vector3 };
  /* ══ appended: tactical kit (merged 2026-09-06) ═══════════════════════════ */

  /* ── tactical implants (owner: implants/ImplantSystem) ─────────────────── */
  /** Implant chosen on the ship (or cleared). Persisted by progression/. */
  'implant:equipped': { id: ImplantId | null };
  /** Q fired an instant implant, or a wielded one performed its action. */
  'implant:activated': { id: ImplantId; position: THREE.Vector3 };
  /** Cooldown / charge readout for the HUD. Fires whenever any of these change. */
  'implant:cooldownChanged': { id: ImplantId; remaining: number; total: number; charges: number; maxCharges: number };
  /** A wielded implant went in / out of the hands (weapons holster while `wielded`). */
  'implant:wieldChanged': { id: ImplantId; wielded: boolean };
  /** Grapple: whether the point under the crosshair is attachable right now (HUD reticle state). */
  'implant:grappleTargetChanged': { valid: boolean; distance: number };
  'implant:grappleFired': { origin: THREE.Vector3; direction: THREE.Vector3 };
  'implant:grappleAttached': { point: THREE.Vector3 };
  'implant:grappleReleased': Record<string, never>;
  'implant:dashed': { position: THREE.Vector3; direction: THREE.Vector3 };
  /** Barrier durability / deployment changed. */
  'implant:barrierChanged': { hp: number; maxHp: number; active: boolean };
  'implant:barrierHit': { point: THREE.Vector3; damage: number };
  /** Scan pulse went out; `targets` are what it revealed for `duration` seconds. Owner: ui renders the outlines. */
  'implant:scanned': { pulse: number; radius: number; duration: number; targets: ScanTarget[] };
  /** Overcharge beam locked on / released. `target` is a peer id, or null for the local player. */
  'implant:overcharge': { mode: 'heal' | 'boost'; target: string | null; active: boolean };
  /** Anti-tank rocket detonated. */
  'implant:rocketExploded': { position: THREE.Vector3; radius: number; damage: number };

  /* ── gadgets (owner: gadgets/GadgetSystem) ─────────────────────────────── */
  'gadget:used': { id: GadgetId; position: THREE.Vector3 };
  'gadget:deployed': { id: string; kind: DeployableKind; position: THREE.Vector3; owner: string };
  'gadget:damaged': { id: string; hp: number; maxHp: number };
  'gadget:removed': { id: string; kind: DeployableKind; reason: 'destroyed' | 'recovered' | 'expired' };
  /** A deployable was picked back up; the item is already in the recoverer's bag. */
  'gadget:recovered': { id: string; item: ItemInstance };
  /** Over / under-hand throw toggle (shared with grenades). */
  'gadget:throwModeChanged': { underhand: boolean };

  /* ── melee (owner: player swings, weapons resolves) ────────────────────── */
  'melee:swing': { weaponId: string | null; damage: number };
  'melee:hit': { point: THREE.Vector3; enemyId: number | null; damage: number; killed: boolean };

  /* ── player state added by the tactical kit (owner: player) ────────────── */
  'player:cloakChanged': { cloaked: boolean; source: 'gadget' | 'armor' | null };
  /** The 인내 skill saved the player from a lethal hit. */
  'player:gritSaved': { hp: number };
  'player:burning': { active: boolean; dps: number };
  /** Jump pad / grapple launched the player. */
  'player:launched': { position: THREE.Vector3; impulse: THREE.Vector3 };

  /* ── gear / weight / durability (owner: inventory) ─────────────────────── */
  'equip:changed': { slot: EquipSlot; item: ItemInstance | null };
  'inventory:weightChanged': { weight: number; capacity: number; ratio: number; state: WeightState };
  'inventory:overloaded': { state: WeightState };
  'durability:changed': { uid: string; defId: string; durability: number; max: number };
  'durability:broken': { uid: string; defId: string; name: string };
  'repair:completed': { uid: string; name: string; durability: number };

  /* ── detection / highlight (owner: ui) ─────────────────────────────────── */
  /** Command: outline these objects through walls for `duration` seconds (scan results, quest markers). */
  'detect:reveal': { targets: ScanTarget[]; duration: number };
  'detect:clear': Record<string, never>;

  /* ── gathering & crafting (owner: world spawns, inventory crafts) ──────── */
  /** `kind` appended (2026-09-08): 'salvage' = 고철 노드 (제작 XP), undefined / 'herb' = 약초 (원예 XP). */
  'gather:collected': { nodeId: string; defId: string; qty: number; kind?: GatherNodeKind };
  /** `count` appended (2026-09-09): how many times the recipe is run in one hold (제작 수량, ≥ 1; absent = 1). */
  'craft:started': { recipeId: string; duration: number; count?: number };
  'craft:completed': { recipeId: string; item: ItemInstance; count?: number };
  'craft:failed': { recipeId: string; reason: 'missing' | 'space' | 'cancelled' };
  /** Command (inventory ui): open / close the field-crafting panel. */
  'ui:craftToggled': { open: boolean };

  /* ── progression (owner: progression/ProgressionSystem) ────────────────── */
  'progress:loaded': { profile: PlayerProfile };
  'progress:xpGained': { amount: number; xp: number; xpToNext: number };
  'progress:levelUp': { level: number; statPoints: number };
  'progress:statChanged': { id: StatId; value: number; pointsLeft: number };
  'progress:skillUp': { id: SkillId; level: number };
  'progress:skillProgress': { id: SkillId; level: number; progress: number };
  /** Command (hub ui): open / close the character sheet (stats + skills). */
  'ui:statsToggled': { open: boolean };

  /* ── appended: key rebinding / implant rework / ship stash (2026-09-06) ── */
  /** Owner: whoever rebinds (ui/menus/KeybindMenu). `Keys` already holds the new values; refresh cached labels. */
  'input:bindingsChanged': Record<string, never>;
  /** Key-settings overlay opened / closed (ui). */
  'ui:keybindsToggled': { open: boolean };
  /** Owner: implants. Channel resource of a 'hold' implant (overcharge energy) changed. */
  'implant:energyChanged': { energy: number; max: number };
  /** Owner: inventory. Ship stash contents changed (`count` = stacks). */
  'inventory:stashChanged': { count: number };

  /* ══ appended: dev console · unique weapons · stat XP · ship housing (2026-09-06) ═══════════════════ */

  /* ── dev console (owner: console/) ── */
  'console:toggled': { open: boolean };
  /** A line was executed. `ok` false = unknown command / the command returned an error. */
  'console:executed': { line: string; ok: boolean; output: string };
  /** `/movecheat` toggled (HUD may show a tag). */
  'cheat:moveCheat': { enabled: boolean };
  /** `/seed` set the mission seed (also applied through `ctx.hub.setMissionSeed`). */
  'cheat:seed': { seed: number | null };

  /* ── unique weapons (owner: weapons unless noted) ── */
  /**
   * Charge / spin-up / slash wind-up readout 0..1 (−1 = cancelled). ui draws a gauge next to the reticle.
   * 2026-09-14: `draw` = 「롱혼」 활 시위 당기기 — the arc gauge ignores it, the reticle's bow bars (한조식) draw it.
   */
  'weapon:chargeChanged': { weaponId: string; kind: 'charge' | 'spinup' | 'slash' | 'draw'; t: number };
  /** Continuous fire (flame / shock arc) switched on or off; `mode` = LMB primary or RMB alt. Audio loops on this. */
  'weapon:beamChanged': { weaponId: string; active: boolean; mode: 'primary' | 'alt' };
  /** A unique weapon used its RMB alternative fire (triple shuriken, charged bolt, air-burst rocket, flame jet). */
  'weapon:altFired': { weaponId: string; origin: THREE.Vector3; direction: THREE.Vector3 };
  /** The 용검 big slash was performed (local; remotes see the melee message). */
  'player:slashed': { position: THREE.Vector3; direction: THREE.Vector3; hits: number };
  /** Owner: enemies. An enemy was set 전소 (writhing, incapacitated) / shocked. */
  'enemy:incinerated': { id: number; position: THREE.Vector3; duration: number };
  'enemy:shocked': { id: number; position: THREE.Vector3 };
  /** Owner: player. Rocket jump / blast self-knockback happened (HUD shake, audio). */
  'player:blastJump': { position: THREE.Vector3; impulse: THREE.Vector3 };

  /* ── stat XP (owner: progression) ── */
  /** Stat XP moved; `progress` = 0..1 toward the next point. A point gained / lost also emits `progress:statChanged`. */
  'progress:statXp': { id: StatId; value: number; progress: number; delta: number };

  /* ── ship housing (owner: housing/ unless noted) ── */
  'housing:loaded': { state: ShipState };
  /** Anything in the ship state changed (cheap catch-all for UI refresh). */
  'housing:changed': { reason: string };
  /** Housing mode entered / left for `room`. hub reacts (camera, cursor, colliders). */
  'housing:modeChanged': { active: boolean; room: number | null };
  /** Selection for placement changed (def id + yaw). */
  'housing:selectionChanged': { defId: string | null; yaw: 0 | 1 | 2 | 3 };
  'housing:roomPurposeChanged': { room: number; purpose: RoomPurpose };
  'housing:furniturePlaced': { item: PlacedFurniture };
  'housing:furnitureMoved': { item: PlacedFurniture };
  'housing:furnitureRecovered': { uid: string; defId: string; room: number };
  'housing:furnitureUpgraded': { item: PlacedFurniture };
  'housing:facilityUpgraded': { id: FacilityId; level: number };
  /** Storage level changed the stash grid; inventory resizes `Stash` (never shrinks below its contents). */
  'housing:stashSizeChanged': { cols: number; rows: number };
  'housing:presetApplied': { index: number; equipped: number; missing: string[] };
  /** Housing DOM panels (room / facility / presets) opened or closed. Blocker token `'housing'`. */
  'ui:housingToggled': { open: boolean; page: 'room' | 'facility' | 'presets' | null };
  /** Owner: hub. The player walked into a room (index) or back into the corridor / cockpit (null). */
  'hub:roomEntered': { room: number | null; purpose: RoomPurpose | null };
  /** Owner: hub. Housing-mode cursor moved to a cell (HUD hint: cell + validity). */
  'housing:cursorChanged': { room: number; x: number; y: number; valid: boolean };

  /* ── cheat item catalog (owner: inventory) ── */
  /** The 무한 상자 window (every item def, infinite stock) opened / closed. */
  'ui:catalogToggled': { open: boolean };
}

export type GameEventName = keyof GameEvents;

/* ══ appended: Phase 5 — meta progression (2026-09-06) ═══════════════════════════════════════════════════ */
import type { ContractGoalKind, ContractSettlement, CorpId, QuestState } from './meta';
export interface GameEvents {
  /* ── corporations / credits / contracts / quests (owner: meta/MetaSystem) ── */
  'meta:loaded': { credits: number };
  'meta:creditsChanged': { credits: number; delta: number; reason: string };
  'meta:repChanged': { corp: CorpId; rep: number; level: number; delta: number; levelUp: boolean };
  'meta:contractAccepted': { id: string; corp: CorpId };
  'meta:contractAbandoned': { id: string; corp: CorpId };
  /** Progress moved (`delta` may be fractional for a squad share). HUD shows `progress / target` under the objective. */
  'meta:contractProgress': { id: string; corp: CorpId; goal: ContractGoalKind; progress: number; target: number; delta: number };
  'meta:contractSettled': ContractSettlement;
  'meta:questChanged': { id: string; corp: CorpId; state: QuestState };
  'meta:purchase': { corp: CorpId; defId: string; price: number; placed: 'bag' | 'stash' };
  'meta:sale': { defId: string; qty: number; credits: number };
  /**
   * appended (Phase 9 UI pass): a squad member's active contract changed as far as this client knows — from a relayed
   * `meta contract` broadcast, or from the list being cleared (`id` null). `ui/hud/ContractPanel` repaints on it;
   * `ctx.meta.getSquadContracts()` is the full list.
   */
  'meta:squadContract': { peer: string; id: string | null; progress: number };
  /** Corp screen (ship computer) opened / closed. Blocker token `'corp'`. */
  'ui:corpToggled': { open: boolean; corp: CorpId | null };

  /* ── owner: inventory ── */
  /** A crate / corpse / supply container window opened; `first` = first time this container id was opened this mission. */
  'inventory:containerOpened': { containerId: string; first: boolean };
  /** The bag + loadout + quick slots were written to localStorage (`LOADOUT_STORAGE_KEY`). */
  'inventory:loadoutSaved': { reason: string };
}

/* ══ appended: Phase 7 — known follow-ups (2026-09-06) ═══════════════════════════════════════════════════ */
import type { GhostState, PeerId as NetPeerId } from './net';
import type { AudioChannel, PlayerRestoreState, Rarity } from './types';
import type { ProfileRecord, RaidSessionBlob } from './profile';
export interface GameEvents {
  /* ── game flow (owner: game) ── */
  /** Command from the training arena's exit console (owner: world emits, game handles → abort + back to the ship). */
  'training:exitRequested': Record<string, never>;
  /** A squad wipe / solo death ended the raid (host decided; every client mirrors). Emitted right before `game:over`. */
  'game:raidFailed': { stats: MissionStats };

  /* ── net (owner: net/NetSystem) ── */
  /** The server profile record arrived (welcome / `profile:docs`). `migrated` = credits were null and the local balance was uploaded. */
  'net:profileLoaded': { profile: ProfileRecord; migrated: boolean };
  /** A raid blob arrived with `welcome` (resume into a running raid). game/ applies it after the rejoin's `world:ready`. */
  'net:raidLoaded': { blob: RaidSessionBlob };
  /** `lobby.hostId` changed while a session is running. `isLocalHost` = we are the new host (authority systems promote). */
  'net:hostChanged': { hostId: NetPeerId; prev: NetPeerId | null; isLocalHost: boolean };
  /** A member's socket dropped (`suspended: true`) or came back during a session. */
  'net:peerSuspended': { id: NetPeerId; name: string; suspended: boolean };
  /** Host-simulated body of a suspended member changed (hp / downed / dead). */
  'net:ghostState': { id: NetPeerId; hp: number; downHp: number; state: GhostState };
  /** The host handed our body back (rejoin). game/ → `ctx.player.restoreState`. */
  'net:ghostRestore': { state: PlayerRestoreState };
  /** A member entered / left the running mission (`LobbyPlayer.inMission`). Squad panel badges. */
  'net:missionMembership': { id: NetPeerId; inMission: boolean };

  /* ── container search (owner: inventory) ── */
  /** Search progress of the item being revealed in an open container (0..1, ≤ 20 Hz). */
  'container:searchProgress': { containerId: string; uid: string; progress: number };
  /** An item finished searching (progression pays 감정 XP by rarity here instead of on `inventory:itemAdded`). */
  'container:itemRevealed': { containerId: string; uid: string; defId: string; rarity: Rarity };
  /** Every item in the container is searched. */
  'container:searchDone': { containerId: string };

  /* ── ghosts (host only) ── */
  /**
   * An enemy hit a SUSPENDED member's body (owner: enemies emits instead of sending `dmg` to a socket that is down;
   * player/RemotePlayerSystem on the host applies it to the ghost and broadcasts `ghost state`).
   */
  'ghost:damage': { id: NetPeerId; amount: number; from?: THREE.Vector3; kb?: { direction: THREE.Vector3; speed: number } };

  /* ── remote pose (owner: player) ── */
  /** A remote player's held consumable changed (for FX / audio). */
  'net:remoteHeldItem': { id: NetPeerId; defId: string | null };

  /* ══ appended: Phase 8 — UI/UX pass (2026-09-06) ══════════════════════════ */

  /* ── greenhouse growing (owner: housing) ── */
  /** A plot of `uid` was planted, harvested or became ready. `ready` = how many plots of that rack can be harvested now. */
  'housing:growChanged': { uid: string; ready: number };
  /** The 재배층 panel opened / closed (blocker `housing`). */
  'ui:growToggled': { open: boolean; uid: string | null };

  /* ── ship management (owner: housing, rendered by ui) ── */
  /** Ship management (M) opened / closed, and which room the camera is on. ui/ draws the room list + furniture bar from this. */
  'housing:shipManageChanged': { active: boolean; room: number | null };

  /* ── settings (owner: ui, applied by audio) ── */
  /** A volume slider moved. audio/ persists; anything else that cares can react. */
  'audio:volumeChanged': { channel: AudioChannel; value: number };
  /** The 설정 screen opened / closed (inside the pause menu, no blocker of its own). */
  'ui:settingsToggled': { open: boolean };

  /* ── item salvage (owner: inventory) ── */
  /** The modeless 분해 dialog opened / closed over the inventory window. */
  'ui:disassembleToggled': { open: boolean; uid: string | null };
}

/* ══ appended: Phase 9 — known follow-ups II (2026-09-06) ══════════════════════════════════════════════════ */
import type { TrainingMode } from './types';
export interface GameEvents {
  /* ── downed give-up hold (owner: player, rendered by ui/hud/Vitals) ── */
  /** Progress of the Space give-up hold while downed (0..1, ≤ 20 Hz); `t: -1` = released / cancelled. */
  'player:giveUpProgress': { t: number };

  /* ── 시뮬레이션 훈련장 target modes (owner: world/TrainingArena) ── */
  'training:modeChanged': { mode: TrainingMode };
  /** One target knocked down; `score` / `hits` = running totals of the current run. */
  'training:scored': { score: number; hits: number; index: number };
  /** A timed course ended. `completed` false = the clock ran out; `best` = best time after this run (seconds). */
  'training:courseFinished': { time: number; score: number; completed: boolean; best: number | null };

  /* ── library bookshelf (owner: housing) ── */
  /** Books on shelf `uid` changed (`count` shelved); also fired when a shelf is recovered (count 0). */
  'housing:booksChanged': { uid: string; count: number };
  /** The 책장 panel opened / closed (blocker `housing`). */
  'ui:bookshelfToggled': { open: boolean; uid: string | null };
}

/* ══ appended: Phase 10 — UI improvement pass (2026-09-07) ═════════════════════════════════════════════════════════ */
import type { CarryEndReason } from './types';
import type { CrewCardWire } from './net';
export interface GameEvents {
  /* ── the reload gauge moves onto the crosshair (owner: weapons, drawn by ui/hud/ReloadGauge) ── */
  /**
   * A reload was aborted before it finished (melee / swap / put-away / death / a unique taking over). Genuinely new:
   * `WeaponSystem.cancelReload()` used to be silent, and the bottom-right panel only got away with it because
   * `weapon:equipped` closed its arc. A crosshair ring must be told explicitly.
   */
  'weapon:reloadCancelled': { weaponId: string };

  /* ── the `회복약` 2 s hold (owner: weapons, drawn by ui/hud/HealGauge) ── */
  /**
   * 회복약 in hand: `holding` while LMB is down, `t` = 0..1 of the use time, `t: -1` on cancel. Same contract shape
   * as `grenade:holdChanged`, so the HUD gauge is a sibling of `CookGauge`.
   * appended 2026-09-07: `dur` = the item's own use time in seconds (`ItemDef.heal.useTime`, `HEAL_HOLD_S` when a
   * def omits it) so the ring can count down real seconds; `spray` marks the 회복 스프레이 channel, where `t` is the
   * remaining gauge (0..1) rather than progress toward a use.
   */
  'heal:holdChanged': { holding: boolean; t: number; dur?: number; spray?: boolean };

  /* ── map pings (owner: ui — map screen → ping system, in-folder) ── */
  /** A ping was asked for at a world position by a surface with no aim ray (tactical-map middle click). */
  'ping:requestAt': { position: THREE.Vector3; kind: PingKind };
  /* ── appended (2026-09-09): the acknowledge ping (owner: ui/hud/Pings) ── */
  /**
   * Somebody pinged an existing squad ping to say 알겠다. `id` = the acknowledged ping's local id (as in `ping:placedV2`),
   * `by` = the acker (null = the local player), `slot` = their lobby slot (colour). Fired for local and remote acks.
   */
  'ping:acked': { id: number; by: PeerId | null; name: string; slot: number };

  /* ── the mouse cursor mode (owner: shared/cursor.ts + Input; the art is ui/hud/GameCursor) ── */
  /**
   * A UI surface took / released the mouse. `owner` = the blocker token that asked for it, null on the last release.
   * 2026-09-07: cursor mode means the **pointer lock is released** and the real OS cursor is back (restyled in place),
   * so this is also the signal that the camera has stopped following the mouse.
   */
  'input:cursorModeChanged': { active: boolean; owner: string | null };

  /* ── live container looting (owner: inventory) ── */
  /**
   * A confirmed take removed units from this client's copy of a container. `live` true = it just happened (`cont taken`
   * or a local take) and the tile plays the float-up + fade-out; `live` false = a silent catch-up reconciliation
   * (`cont sync`, or the first open of a container with pending takes).
   */
  'container:itemTaken': {
    containerId: string;
    idx: number;
    /** uid in THIS client's copy (`Container.uidAt(idx)`), null when the container was never rolled here. */
    uid: string | null;
    qty: number;
    /** Units of `idx` left in this copy after the removal. */
    remaining: number;
    /** Peer that took it; null for a local single-player take. */
    by: NetPeerId | null;
    /** Lobby name of the taker; null for the local player / an unknown peer. */
    byName: string | null;
    byLocal: boolean;
    live: boolean;
  };

  /* ── shouldering a wounded squadmate (owner: player; the remote mirror is net's) ── */
  /** We shouldered a downed squadmate (`id` null = a host-simulated ghost body). */
  'player:carryStarted': { id: NetPeerId | null; name: string | null };
  /** The carried squadmate is back on the ground. */
  'player:carryEnded': { id: NetPeerId | null; reason: CarryEndReason };
  /** A squadmate picked up / put down another squadmate (HUD markers, 분대 목록). */
  'net:remoteCarryChanged': { id: NetPeerId; carrying: NetPeerId | null };

  /* ── the launch READY panel (owner: hub; the crew wire is net's) ── */
  /** A member's ship-side card arrived / changed. The local player is included (`id === net.localId`). */
  'net:crewCard': { id: NetPeerId; card: CrewCardWire };
  /** A member answered `crewq loadout`; `loadout` is inventory's opaque document — validate before rendering. */
  'net:crewLoadout': { id: NetPeerId; card: CrewCardWire; loadout: unknown };
  /** The READY panel opened / closed (blocker `HUB_READY_BLOCKER`, software cursor on). */
  'hub:readyPanelToggled': { open: boolean };
  /** A member's 장비 popup opened / closed from the READY panel; `peerId` null = closed. */
  'hub:crewLoadoutToggled': { open: boolean; peerId: NetPeerId | null };

  /* ── the barrier shield (owner: implants) ── */
  /** The shield was raised / lowered (distinct from the old deploy/stow of `implant:barrierChanged`). */
  'implant:barrierCarried': { up: boolean };
}

/* ══ appended: Phase 11 — planet selection · social (2026-09-07) ══════════════════════════════════════════════════════ */
import type { PlanetId } from './planets';
import type { PlayOutcome, PlayerCode, SocialErrorCode, SocialSnapshot, SquadInvite, WhisperLine } from './social';

export interface GameEvents {
  /* ── the target planet (owner: hub; world / core / enemies read `ctx.missionPlanet` instead) ── */
  /**
   * The ship's 목표 행성 changed and the travel cutscene has finished. `by` distinguishes my own terminal pick from a
   * squad-mate's (`'squad'` = the host changed it and my `lobby:state` brought it in).
   */
  'hub:planetChanged': { planet: PlanetId; by: 'local' | 'squad' };
  /**
   * Ship travel: `'start'` closes the terminal, un-boards every pod and begins the trip; `'end'` marks arrival.
   * Local to each client — it is driven by each client's own `lobby:state`.
   * 2026-09-09: no longer a cutscene — the warp is watched through the ship's viewports, controls stay enabled
   * (see `hub:warpProgress`); `ctx.hub.travelling` is true in between.
   */
  'hub:travel': { stage: 'start' | 'end'; planet: PlanetId };
  /** The full-screen terminal opened / closed (blocker `'hub'`, software cursor on). Replaces nothing — new. */
  'hub:terminalToggled': { open: boolean };

  /* ── social (owner: net/SocialSync; drawn by ui/) ── */
  /** A snapshot arrived. `first` = the one that came with `welcome` / the first `social:get` of this connection. */
  'social:updated': { snapshot: SocialSnapshot; first: boolean };
  /** A squad invite arrived (panel under the community thumbnail, P-hold to accept). */
  'social:invited': { invite: SquadInvite };
  /** An invite left the list: accepted, dismissed, or `SQUAD_INVITE_TTL_S` expired. */
  /**
   * `declined` · `failed` · `offline` · `superseded` + `id` · `detail` appended (2026-09-11, B-3): the server now closes invites
   * too (`social:inviteClosed` wire) — `detail` narrows `failed` (full · started · not_found …).
   */
  'social:inviteClosed': {
    from: PlayerCode;
    reason: 'accepted' | 'dismissed' | 'expired' | 'declined' | 'failed' | 'offline' | 'superseded';
    id?: string;
    detail?: SocialErrorCode;
  };
  /** A whisper was sent or received (`line.out` distinguishes). ChatLog renders it, nothing else consumes it. */
  'social:whisper': { line: WhisperLine };
  /** How my 같이 하기 resolved — `joined` (a docking cutscene follows) or `invited` (they were asked). */
  'social:play': { code: PlayerCode; name: string; outcome: PlayOutcome };
  /** A social request was refused. `message` is the Korean line from `SOCIAL_ERROR_MESSAGE_KO`. */
  'social:error': { code: SocialErrorCode; message: string };

  /* ── the community / private chat UI (owner: ui) ── */
  /** The ship's top-right 커뮤니티 panel opened / closed (blocker `COMMUNITY_BLOCKER`). */
  'ui:communityToggled': { open: boolean };
  /* appended (2026-09-07, the cursor rework): Alt freed / re-captured the mouse cursor with no screen behind it. */
  'ui:freeCursorToggled': { active: boolean };
  /**
   * Command: open the chat input in whisper mode aimed at `code` (the ESC screen's 개인 대화 closes itself and emits
   * this). ChatLog keeps the target until the player clears it, so the next Enter also whispers.
   */
  'chat:whisperTo': { code: PlayerCode; name: string };

  /* ══ appended: 2026-09-08 batch — implant items · the barrier · recon · bullet tracking · the resume gate · the salvage gauge ══ */
  /** Equipped 임플란트 items changed (owner: progression). `slots` = total, `used` = occupied. */
  'progress:implantsChanged': { equipped: readonly EquippedImplant[]; slots: number; used: number };
  /** 실드 배쉬 swung (owner: implants; audio / HUD). `hits` = enemies struck. */
  'implant:bashed': { position: THREE.Vector3; yaw: number; hits: number };
  /** A bug bumped into a raised shield (owner: enemies; implants sparks, audio thuds). `owner` = the carrier. */
  'implant:barrierBumped': { owner: PeerId | 'local'; enemyId: number; point: THREE.Vector3 };
  /** An enemy that could not see the shooter reacted to a bullet (owner: enemies; HUD / audio may cue it). */
  'enemy:shotAlerted': { id: number; position: THREE.Vector3; toward: THREE.Vector3 };
  /**
   * 정찰 pulse cast by me or a squadmate (owner: implants). ui draws the compass marks + timers from this; enemies/
   * gets `setXray` from implants directly. `targets` includes kind 'enemy' and every interactable in range.
   */
  'scan:cast': { position: THREE.Vector3; radius: number; duration: number; targets: ScanTarget[]; byLocal: boolean };
  /**
   * The browser-only `좌측 클릭으로 게임 재개` gate (owner: game). Shown when the last cursor screen closed with Escape and
   * the pointer lock could not be re-taken (Chrome grants Escape no activation); hidden on the click that re-locks.
   */
  'ui:resumeGate': { shown: boolean };
  /** Item salvage progress 0..1 while the hold runs (owner: inventory; the `분해` panel draws its bar from this). */
  'inventory:disassembleProgress': { uid: string; t: number; done: boolean };
  /**
   * Continuous-use item (회복 스프레이) channel started / stopped (owner: weapons). ui keeps **one** ticker alive for the
   * length of the channel instead of one per tick. `gauge` = remaining gauge 0..1.
   */
  'item:channelChanged': { uid: string; defId: string; active: boolean; gauge: number };

  /* ── appended (2026-09-08): the tutorial (owner: tutorial) ── */
  /**
   * The tutorial started, advanced or ended. `step` is null when it is over; `index` / `count` are 1-based progress
   * for a readout. Every folder that hides or gates something during the tutorial re-reads `ctx.tutorial` here.
   */
  'tutorial:changed': {
    active: boolean; step: TutorialStepId | null; index: number; count: number;
    /** appended (2026-09-14): the track currently running (`raid` · `ship` · `build`). Absent while inactive. */
    track?: import('./tutorial').TutorialTrack;
  };
  /**
   * The tutorial is over — completed (`skipped: false`) or waved off from the 건너뛰기 button / console.
   * appended (2026-09-14): `track` = the track that ended. Absent (an older emit) = `build`.
   */
  'tutorial:finished': { skipped: boolean; track?: import('./tutorial').TutorialTrack };
  /**
   * appended (2026-09-14, owner: world/tutorial): a checkpoint of the tutorial world was passed — a death stands the
   * player back up here. `index` is the 0-based position inside `TUTORIAL_CHECKPOINTS`. Walking back over an earlier one
   * **never lowers the number**.
   */
  'tutorial:checkpoint': { id: import('./tutorialWorld').TutorialCheckpointId; index: number };

  /* ── display settings (2026-09-08, owner: ui/menus/SettingsMenu) ── */
  /**
   * The 화면 설정 section changed (or was restored at startup). Applied by **`main.ts`**, the one place that holds the
   * `Engine`: bloom → `setPostProcessing`, shadows → `setShadows`, scale → `setResolutionScale`. `fullscreen` is
   * already applied by the panel itself (only a user gesture may request it) and is reported here for completeness.
   */
  'ui:displayChanged': { fullscreen: boolean; bloom: boolean; shadows: boolean; scale: number };
  /**
   * appended (2026-09-11, C-58): `core/Engine`'s perf guard turned a display option off **by itself** (sustained slow
   * frames in the first 90 s). Fact only — nothing is persisted; the settings row shows it as `꺼짐 (성능 자동)` until the
   * player's next real change (`ui:displayChanged`) wins. Emitted at most once per boot.
   */
  'render:autoAdjusted': { bloom: false; reason: 'perf' };

  /* ── the shared ship's hangar (2026-09-08) ── */
  /**
   * Fact (net): a member's `ship state` arrived and `ctx.net.getShipVisit(id)` now answers. hub/ waits for this
   * when a bay was entered before the layout was known.
   */
  'net:shipVisit': { id: PeerId };
  /**
   * Fact (hub): the player entered or left a personal ship through a hangar bay. `peerId` = the ship's owner (our own id
   * for our own ship), null when we are back on the shared deck; `readOnly` marks someone else's ship.
   */
  'hub:shipVisit': { peerId: PeerId | null; readOnly: boolean };

  /* ── the key guide (2026-09-09) ── */
  /**
   * The key guide's one-liner, bottom-right of the screen (drawn by `ui/hud/KeyGuide`; e.g. `R 회전 · X 버리기 · Tab 닫기`).
   * A screen / mode emits `{ owner, keys }` when it opens and whenever its keys change — labels are read at emit
   * time with `keyLabel(Keys.X)`, so re-emit on `input:bindingsChanged` — and `{ owner, keys: null }` when it closes.
   * The guide keeps a stack per `owner` and shows the most recently opened one (popups over a screen win).
   * **The guide appends the close entry itself** (`keyLabel(Keys.INVENTORY)` + `닫기`, always the rightmost item), so
   * `keys` never lists the close key. Decision 2026-09-09: **Tab (`Keys.INVENTORY`) closes every screen / mode** in
   * addition to the key that opened it (E for 터미널 · 작업대, M for 지도 · 시설 관리, …); a screen that eats Tab must
   * `ctx.input.consume(Keys.INVENTORY)` so the inventory does not open on the same press. The ESC pause menu
   * (`'menu'` blocker) is excluded — it draws no guide and the guide hides while it is up.
   */
  'ui:keyGuide': { owner: string; keys: ReadonlyArray<KeyGuideEntry> | null };

  /* ── the window warp (2026-09-09): planet travel is no longer a cutscene ── */
  /**
   * Fact (hub): progress of the in-ship warp seen through the viewports, emitted every frame while `hub:travel` runs.
   * `t` = 0..1 of `HUB_TRAVEL_DURATION`; `speed` = 0..1 warp intensity (ramps up over `HUB_WARP_RAMP_S`, holds, ramps
   * down over the last `HUB_WARP_RAMP_S`) — the starfield stretch, the hull shake and the audio all follow `speed`.
   * Controls stay enabled for the whole trip (the player walks around the ship); pods / terminal stay refused via
   * `ctx.hub.travelling`.
   */
  'hub:warpProgress': { planet: PlanetId; t: number; speed: number };

  /* ══ 2026-09-09: death / corpses · the rescue drop · the squad leader · the fog of war ═══════════════════════════════════════════════
   *
   * **The auto-revive is gone.** There is no 30 s countdown after `player:died` and `game:respawnAvailable` is no
   * longer emitted either (it stays in the contract — never delete it). A full death turns the player into a corpse,
   * and the only way back is a `rescue_drop` called by a squadmate.
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

  /* ── corpses (owner: game/parts/Corpses) ── */
  /**
   * Fact: a dead player's corpse stands in the world. There is no lifetime and no distance culling — it goes **when it
   * is empty** (2026-09-16, `corpse:playerEmptied` below). Looting runs through the `Interactable` `pcorpse:<owner>:<n>`
   * → the existing container window (`inventory:containerOpened`).
   */
  'corpse:playerSpawned': { id: string; ownerId: string; ownerName: string; position: THREE.Vector3; yaw: number };
  /**
   * Fact: the last item left that corpse (for a corpse that stood up empty, the moment it stood). The prompt becomes
   * `비어 있음`, and since 2026-09-16 it sinks into the ground over `CORPSE_EMPTY_SINK_S` after
   * `CORPSE_EMPTY_REMOVE_DELAY_S` and is cleared from the raid (`CorpsesRef.get` → null).
   */
  'corpse:playerEmptied': { id: string; ownerId: string };

  /* ── the rescue drop (owner: stratagems/parts/Rescue) ── */
  /** Fact: the squad's shared remaining count changed (including the initial broadcast at mission start). */
  'rescue:countChanged': { left: number; total: number };
  /** Fact: a rescue drop call was confirmed (the count is deducted at this point). `target` = the PeerId of the squadmate to be revived. */
  'rescue:called': { callId: string; target: string; targetName: string; by: string; position: THREE.Vector3; eta: number };
  /** Fact: the rescue pod landed and that squadmate is back on their feet. */
  'rescue:landed': { callId: string; target: string; position: THREE.Vector3 };
  /** Command (ui → stratagems): pick this squadmate on the rescue drop selection screen (`null` = deselect). */
  'rescue:selectTarget': { peerId: string | null };

  /* ── the squad leader (the host) (owner: game/parts/Leader) ── */
  /** Fact: the host died fully and the squad-leader device dropped beside the corpse (`Interactable` `leader_device`, a 3 s hold). */
  'leader:deviceDropped': { position: THREE.Vector3; hostId: string };
  /** Fact: somebody picked the device up and took over as squad leader (the device disappears). */
  'leader:deviceTaken': { by: string; byName: string };
  /** Command (ui/hub → net): hand the squad leadership to this squadmate (right-click in the community panel · an interaction inside the ship). */
  'leader:transferRequested': { peerId: string };

  /* ── the fog of war (owner: world/Fog) ── */
  /**
   * Fact: the fog mask grew. The map reacts to this event alone to repaint its cached fog layer — it does not scan
   * `FogRef.mask` every frame. `explored` = the explored fraction, 0..1.
   */
  'fog:revealed': { revision: number; explored: number };
  /**
   * Fact: a landmark that had not been seen was discovered for the first time (an extraction `신호소` · a nest · a
   * crate …). The toast, the map icon and the compass all switch on from this. `kind` uses the same names as the map
   * marker kinds.
   */
  /* 2026-09-09 (raid play improvements): added `structure` (an abandoned outpost · lab · crashed ship), `rail` (rails ·
     platforms) and `grove` (a giant mushroom grove = a toxic spore source) — the union is add-only. */
  'fog:discovered': {
    kind: 'extraction' | 'nest' | 'crate' | 'outpost' | 'gather' | 'structure' | 'rail' | 'grove'
      /* appended (2026-09-13): a rover station — `id` = `RoverStationDef.id`, `position` = the marker pole */
      | 'rover';
    id: string; position: THREE.Vector3;
  };

  /* ── remote drop pods (owner: player/RemotePlayerSystem) ── */
  /**
   * Fact: a remote squadmate's drop pod started to fall. `kind` 0 = the mission start, 1 = a rescue drop.
   * Before 2026-09-09 an ally simply appeared on the spot — now the pod is visible.
   */
  'net:remotePodDrop': { id: string; position: THREE.Vector3; yaw: number; kind: 0 | 1 };

  /* ══ 2026-09-09: raid play improvements — comms · structures · rails · hazards · rogue drops ═══════════════════════
   * The owning folder is named at the head of each section. Everything is an **addition**; no existing event was touched.
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

  /* ── the comms wheel (owner: ui/hud/CommsWheel) ── */
  /**
   * Fact: somebody sent a line from the comms wheel (hold `H` → pick a direction → release). The same for local and
   * remote. ui/ makes both the chat line (`ChatKind 'request'`) and the audio out of this one event.
   * `text` is an already finished Korean sentence — a line that carries a number, like `contract`, is filled in **by the sender**.
   * `position` = the sender's position (for a remote, their last snapshot position), null when it is unknown.
   */
  'comms:sent': {
    id: CommsId; text: string; by: string | null; byName: string; slot: number; position: THREE.Vector3 | null;
  };
  /** Fact: the comms wheel opened and closed (`downed` = the 2-slot downed layout). `hover` = the index of the slot currently pointed at, null when there is none. */
  'comms:wheelChanged': { open: boolean; downed: boolean; hover: number | null };

  /* ── the local ping wheel (owner: ui/hud/Pings) ── */
  /**
   * Fact: the left/right wheel held open while the ping button is down opened and closed. While `downed` it is
   * `살려줘` / `나를 버려`, otherwise `여기 조심해` / `저쪽으로 가자`. `hover` is the side currently pointed at.
   */
  'ping:wheelChanged': { open: boolean; downed: boolean; hover: 'left' | 'right' | null };

  /* ── abandoned structures (owner: world/Structures) ── */
  /** Fact: a structure's locked door (the outpost basement · the lab's locked room on the 2nd floor) was opened with a key / keycard (one of the opener's is consumed). */
  'structure:unlocked': { id: string; kind: StructureKind; by: string | null; position: THREE.Vector3 };
  /** Fact: a planet scan was run from the structure's computer and the fog within `radius` m cleared (once per structure). */
  'structure:scanned': { id: string; kind: StructureKind; position: THREE.Vector3; radius: number };
  /**
   * Fact: a player investigated a container of a structure (or a rail platform) — **the only trigger of the rogue drop roll**.
   * `zoneId` is the key that counts "once per zone" (the structure id or the platform id), and enemies/ listens to it and rolls.
   */
  'structure:investigated': { zoneId: string; kind: StructureKind | 'platform'; position: THREE.Vector3 };

  /* ── rails · tram (owner: world/Rails) ── */
  /** Fact: the tram was started from a console (after the host confirmed it). */
  'rail:tramStarted': { lineId: string; tramId: string; by: string | null };
  /** Fact: the tram stopped at a platform / set off again. */
  'rail:tramDocked': { tramId: string; platformId: string | null; docked: boolean };

  /* ── rogue drops (owner: enemies/RogueDrop) ── */
  /** Fact: a rogue drop was announced (the pod in the sky + the alarm). `eta` = seconds left until touchdown, on `ctx.time`. */
  'rogueDrop:incoming': { dropId: string; position: THREE.Vector3; count: number; boss: boolean; eta: number };
  /** Fact: the pod touched down and the rogues got out. */
  'rogueDrop:landed': { dropId: string; position: THREE.Vector3; count: number; boss: boolean };

  /* ── environmental hazards (owner: world/Hazard) ── */
  /** Fact: this raid's hazard and its start time were decided (from the mission seed, once right after the world was generated). */
  'hazard:planned': { kind: HazardKind; startsAt: number };
  /** Fact: the warning `HAZARD_WARN_S` seconds before the start. The HUD warning and the audio hang off this. */
  'hazard:announced': { kind: HazardKind; secondsLeft: number };
  /** Fact: the hazard started. */
  'hazard:started': { kind: HazardKind };
  /** Fact: the progress changed (emitted only a few times per second — never per frame). `progress` 0..1. */
  'hazard:progress': { kind: HazardKind; progress: number };
  /** Fact: the local player entered / left the damage zone. Sight range, screen effects and the warning sound hang off this. */
  'hazard:insideChanged': { inside: boolean; kind: HazardKind | null };

  /* ── the atmosphere override (owner: core/Atmosphere) ── */
  /**
   * Command: push the sky and the fog temporarily. `fogMul` = a multiplier on the current planet's fog density
   * (1 = as it was), `color` = the fog / sky colour to mix in (0xRRGGBB, null = leave it), `blend` = 0..1, how much.
   * A hazard narrows the view with it and restores `{fogMul:1, color:null, blend:0}` when it ends.
   * core/ remembers only the last value it received and lays it over the palette every frame.
   */
  'atmo:override': { fogMul: number; color: number | null; blend: number };

  /* ══ appended (2026-09-10): armor = a shield · remote footsteps · danger indicators ══════════════════════ */
  /**
   * Fact: the local player's **shield** (the extra hp armor gives) changed. It is a pool entirely separate from `hp`,
   * and damage goes shield first, then hp. Taking the armor off gives `maxShield: 0`, `rarity: null`.
   * `rarity` · `tier` decide the **segment colour and segment count** of the bottom-left shield gauge (one segment per
   * `ARMOR_SHIELD_PER_SEGMENT`). Emitted from equipping, swapping, being hit, charging and spawning alike
   * (`delta` = this change, negative when it fell).
   */
  'player:shieldChanged': { shield: number; maxShield: number; delta: number; rarity: Rarity | null; tier: number };
  /**
   * Fact: a **remote** squadmate's foot hit the ground (the local player uses `player:footstep`). audio plays it with
   * the distance falloff applied — the emitting side measures no distance.
   */
  'remote:footstep': { position: THREE.Vector3; sprinting: boolean; peerId: PeerId };

  /* ══ appended (2026-09-10): the server address ══════════════════════════════════════════════════════════ */
  /**
   * Fact: the relay address to connect to changed (`설정 › 서버 설정`). `custom` = an address the user typed; false
   * means it fell back to the build default (the same origin, `/ws`). **This event does not reconnect** — whoever
   * called `NetRef.reconnectRelay()` does.
   */
  'net:relayChanged': { url: string; custom: boolean };

  /* ══ appended (2026-09-11): ladders · breakable windows · the roof scanner ══════════════════════════════════════════ */
  /**
   * Command → player: the local player grabs this ladder. `from` = where it was grabbed (`bottom` starts the climb from
   * the foot, `top` starts the descent from the top). Emitted by world's ladder `Interactable` — it carries the whole ladder def.
   */
  'ladder:grab': { ladder: LadderDef; from: 'bottom' | 'top' };
  /** Fact: the local player is on a ladder (`ladderId`) / got off it (null). */
  'player:climbChanged': { ladderId: string | null };
  /**
   * Fact: a structure's window broke (on this client or over the wire). `byLocal` = this client broke it.
   * Emitted **after** world removed the collider and hid the glass.
   */
  'structure:glassBroken': { structureId: string; index: number; position: THREE.Vector3; byLocal: boolean };

  /* ══ appended (2026-09-11): drones · remote mines · the placement preview · named rogues ═════════════════════════════════ */
  /** Fact: a drone appeared (local deploy or a replica spawn). Owner: gadgets/drones. `position` is the live vector. */
  'drone:deployed': { id: string; kind: DroneKind; owner: PeerId | 'local'; position: THREE.Vector3 };
  /** Fact: a drone left the world (destroyed · recovered by E hold · mission reset). Owner: gadgets/drones. */
  'drone:removed': { id: string; kind: DroneKind; reason: 'destroyed' | 'recovered' | 'expired' };
  /** Fact (local): the local player started looking through drone `id` / went back to the PC camera (`id` null). */
  'drone:controlChanged': { id: string | null; kind: DroneKind | null; reason: DroneReleaseReason | null };
  /** Fact: a drone's hp changed. `own` = the local player owns it. */
  'drone:damaged': { id: string; hp: number; maxHp: number; own: boolean };
  /**
   * Fact: a noise enemies can hear, other than gunfire (지상 드론 질주). Emitted **on the authority only** (the host
   * sees remote drones through their replicas' `DroneFlags.NOISY`), at most `DRONE_NOISE_EMIT_HZ` per source.
   * enemies/ turns it into alert / aggro toward `position`.
   */
  'world:noise': { position: THREE.Vector3; radius: number; source: 'drone'; sourceId: string };
  /** Fact: remote mines were detonated by `owner` (count = how many went off). Owner: gadgets. */
  'gadget:detonated': { count: number; owner: PeerId | 'local' };
  /**
   * Fact (local): the hand placement preview changed — gadget in hand, validity, reason, drone mount. Emitted only when one
   * of those changes (never per frame). `gadget` null = no `place` gadget in hand. Owner: gadgets. Read by ui/hud.
   */
  'gadget:placementChanged': { gadget: GadgetId | null; valid: boolean; reason: string | null; mount: string | null };
  /* ── appended: 2026-09-15 (defibrillator aiming, user's decision) ── */
  /**
   * The crosshair's state while a defibrillator is in hand. `charge` 0..1 = the readiness gauge (while
   * `DEFIB_USE_TIME_S` fills), `armed` = ready (the small circle has met the big one and thickened), `target` = letting
   * go right now would revive somebody (a downed ally inside `DEFIB_AIM_CONE_DEG` and inside `GADGET_DEFIB_RANGE`).
   * Letting go closes it with `armed:false`. It is drawn in one place, `ui/hud/Reticle`.
   */
  'gadget:defibAim': { armed: boolean; charge: number; target: boolean };
  /** Fact: a named rogue was placed this raid (authority emits on spawn, replicas on first sight of the type). Owner: enemies. */
  'enemy:namedSpawned': { id: number; type: NamedRogueType; position: THREE.Vector3 };
  /**
   * Fact (every client): a scan drone pulse went out. `exposedLocal` = the local player was inside it with line of sight.
   * Owner: enemies (host decides exposure, replicas read `ee scanPulse.tg`).
   */
  'named:scanPulse': { enemyId: number; position: THREE.Vector3; radius: number; index: number; total: number; exposedLocal: boolean };
  /** Fact (local): the local player's scan exposure changed. `count` 0 = cleared (drone downed · shot fired · timed out). */
  'named:scanExposure': { count: number; total: number; sniperId: number | null };
  /** Fact (every client): 로든's scope glints — a shot follows after `duration` s. `targetLocal` = aimed at the local player. */
  'named:sniperGlint': { enemyId: number; position: THREE.Vector3; targetLocal: boolean; duration: number };
}

/** One key guide entry (`ui:keyGuide`): `key` is the display label (`keyLabel(...)`), `label` the Korean action. */
export interface KeyGuideEntry {
  key: string;
  label: string;
  /** 2026-09-09: the key must be **held** (탑승 · 1초 홀드) — the guide draws a downward chevron over the keycap. */
  hold?: boolean;
  /**
   * appended (2026-09-12): **another key does the same thing**. The guide draws it as `key 또는 alt[0] 또는 …` — the
   * `또는` between the keycaps is set small. Each key carries its own `hold` (e.g. tap `E` or hold `LMB` = move a piece).
   */
  alt?: ReadonlyArray<KeyGuideKey>;
  /**
   * appended (2026-09-12): a key that must be **pressed together** with it (`Ctrl + R`). The guide draws it as
   * `key + combo[0] + …` — the `+` is set small. Nothing uses it yet, but the rule was fixed first (user's decision).
   */
  combo?: ReadonlyArray<string>;
}

/** appended (2026-09-12): one key of `KeyGuideEntry.alt`. */
export interface KeyGuideKey {
  key: string;
  hold?: boolean;
}

/* ══ appended: 2026-09-11 — social · trust · connection (commits `9bd72ce` — the contract · `b3fc2f0` — the implementation) ══ */
import type { InviteOutcome } from './social';
import type { NetLinkInfo, NetLinkState } from './net';
import type { ProfileDocKey } from './profile';
export interface GameEvents {
  /** B-3 (owner: net/SocialSync): how an invite **I sent** ended. ui/ toasts `name + SOCIAL_INVITE_OUTCOME_KO[outcome]`. */
  'social:inviteResult': { id: string; code: PlayerCode; name: string; outcome: InviteOutcome; reason?: SocialErrorCode };
  /**
   * B-4 (owner: net/SocialSync): an outgoing whisper line changed delivery state (`pending` → `sent` / `stored` /
   * `failed`) — ChatLog finds its row by `line.nonce` and redraws it (no separate error toast).
   */
  'social:whisperUpdated': { line: WhisperLine };
  /**
   * B-1 (owner: net/parts/Socket): `ctx.net.link` changed. ui/hud/NetBadge draws it (ship · title only), the transition
   * toasts (connected → dropped, dropped → connected) come from the same place.
   */
  'net:linkChanged': { link: NetLinkInfo; prev: NetLinkState };
  /**
   * E-6 (owner: net/ProfileSync): the server refused local writes for `keys` as stale and its copies won. A
   * `net:profileLoaded` carrying those copies follows; this one exists for the console warning / a smoke to see.
   */
  'net:profileConflict': { keys: ProfileDocKey[] };
  /**
   * E-4 (owner: enemies): an enemy was killed by **a squad-mate** (`by` = their PeerId, never the local player — that is
   * `enemy:killed {by:'local'}`). Emitted on every client from the host's authoritative kill: the host from its damage
   * path, replicas from `ee kill {killer}`. meta/ counts the squad share of kill goals from this instead of `meta contractHit`.
   */
  'enemy:squadKill': { id: number; type: EnemyType; position: THREE.Vector3; by: PeerId };
}

/* ══ appended: 2026-09-11 — the lab · furniture upgrades (A-11 · A-12 · A-13 · B-13) ══ */
import type { EnvKind } from './types';
export interface GameEvents {
  /**
   * A-12 (owner: housing): one analyzer's analysis state changed (inserting · collecting · cancelling · upgrading · a
   * catalogue entry). `ready` = how many cells can be collected right now — the same shape as `housing:growChanged`, so
   * hub's glow and ui's badge take the same road.
   */
  'housing:analysisChanged': { uid: string; ready: number };
  /**
   * A-12 (owner: housing): a sample entered the analysis catalogue for the first time. ui/ raises one toast.
   */
  'housing:sampleDexAdded': { defId: string };
  /**
   * B-13 (owner: hub — the ship management camera's raycast): a placed piece of furniture was clicked. `uid: null` =
   * empty space was clicked and the selection was released. ui/hud/ShipManage opens and closes the **click inspector**
   * (name · level · next upgrade cost · upgrade) from this. It is separate from the existing path that picks a piece up
   * and moves it in placement mode — the inspector moves nothing.
   */
  'housing:furnitureSelected': { uid: string | null };
  /**
   * A-13 (owner: player): exposure to the planet's permanent environment changed. `env: null` = a planet with no
   * environment, or the ship. `protected` = the matching preparation is aboard, so the damage is 0. ui/'s environment
   * badge is the only consumer.
   */
  'player:envChanged': { env: EnvKind | null; protected: boolean };
  /** A-13 (owner: progression): the waiting / this-raid preparations changed. ui/'s launch prep screen and the HUD badge redraw. */
  'progress:prepChanged': { prep: readonly string[]; active: readonly string[] };
}

/* ══ appended: 2026-09-11 — the kitchen · culture tank · printer (A-3c · A-14 · A-15) ══ */
export interface GameEvents {
  /**
   * A-3c (owner: progression): the waiting / this-raid meal changed (eating · being served · launch · raid end).
   * `null` = nothing eaten. ui/'s meal badge and the dining table screen redraw.
   */
  'progress:mealChanged': { meal: string | null; active: string | null; /* 2026-09-13 cooking quality (omitted = 0) */ mealQuality?: number; activeQuality?: number };
  /**
   * A-14 (owner: housing): one culture tank's state changed (medium · cell line · harvest · upgrade).
   * `ready` = how many cells can be harvested right now — the same shape as `housing:growChanged` · `housing:analysisChanged`.
   */
  'housing:cultureChanged': { uid: string; ready: number };
  /**
   * A-3c (owner: housing — `분대에 차리기` on the shared ship's dining table): a meal was served to the squad. net/
   * sees this and sends `meal serve`; **only what the lobby host rebroadcast** reaches the receiver's
   * `progression.serveMeal` (「a message that affects others is accepted only from the authority」 E-4). `by` = the
   * display name of whoever served it (for the toast).
   */
  'housing:mealServed': { defId: string; by: string; /* 2026-09-13 cooking quality (omitted = 0) */ quality?: number };
  /** A-15 (owner: inventory): a pouch was equipped or its contents changed. ui/ redraws the grid below the quick slots. */
  'inventory:pouchChanged': Record<string, never>;
}

/* ══ appended: 2026-09-16 — the dining plate (a meal is not an item — the plate section of `shared/housing.ts`) ══ */
export interface GameEvents {
  /**
   * owner: housing — the plate on my ship's dining table changed. `reason`: `cooked` a cook finished · `raid` cleared
   * at raid start · `profile` replaced by the server copy · `dev` console · smoke. net tells the squadmates in the
   * shared ship (`plate state`).
   */
  'housing:plateChanged': { plate: import('./housing').DiningPlate | null; reason: 'cooked' | 'raid' | 'profile' | 'dev' };
  /** owner: housing — the list of plates on some dining table changed (mine · a squadmate's). hub redraws the 3D plates, the table screen its list. */
  'housing:tablePlatesChanged': { count: number };
  /**
   * owner: net — one squadmate's plate arrived (`plate state`, past the shape check). `plate` null = no plate · they
   * left. `fresh` = that person just cooked (ui toasts only this one — the list received on joining is silent).
   * `id` = PeerId.
   */
  'net:squadPlate': { id: string; name: string; plate: import('./housing').DiningPlate | null; fresh: boolean };
}

/* ══ appended: 2026-09-12 — moving furniture in ship management ══ */
export interface GameEvents {
  /**
   * (owner: ui — the `위치 이동` button in the `hud/ShipManage` inspector): please pick the placed piece `uid` up into
   * the **move state**. hub/'s `HousingMode` is the only consumer — it takes the same road as entering with the E key.
   */
  'housing:moveRequested': { uid: string };
  /**
   * (owner: hub — `HousingMode`): ship management's **move state** changed. `active` = a piece of furniture is held on
   * the cursor (`uid` while moving a placed piece, `uid: null` + `defId` while placing a new one from the stash).
   */
  'housing:moveStateChanged': { active: boolean; uid: string | null; defId: string | null };
  /**
   * (owner: hub — `HousingMode`): a spot that cannot take the piece was clicked while in the move state.
   * ui/hud/ShipManage shows it as a short toast **above** the inspector (why not the global `ui:notify` — it has to
   * appear right above the spot the user was looking at).
   */
  'housing:placeRefused': { reason: string };
  /**
   * appended (2026-09-12, owner: hub — `HousingMode`): a placed piece is **being held with LMB** in ship management.
   * `progress` 0 … 1 (fills over `HOUSING_MOVE_HOLD_S`), `null` = the hold ended · was cancelled · reached 1 and picked
   * the piece up into the move state. ui/ draws a ring gauge **centred on the cursor** (ui reads the coordinates itself
   * from `ctx.input.uiX/uiY`).
   */
  'housing:moveHold': { progress: number | null };
}

/* ══ appended: 2026-09-12 — library media (A-3e) · the gym (A-3a). `src/housing/README.md` Decisions ══ */
export interface GameEvents {
  /**
   * (owner: housing) what is shelved in holder `uid` changed — shared by the bookshelf · disc stand · record rack (the
   * bookshelf still emits `housing:booksChanged` as well). Collecting the holder gives `count: 0`.
   */
  'housing:shelfChanged': { uid: string; medium: ShelfMedium; count: number };
  /** (owner: housing) the disc stand · record rack screen opened / closed (the bookshelf is still `ui:bookshelfToggled`). */
  'ui:shelfToggled': { open: boolean; uid: string | null; medium: ShelfMedium | null };
  /** (owner: housing) the TV · record player was turned on / off. hub swaps that piece's screen · lamp material (no light source). */
  'housing:furnitureToggled': { uid: string; on: boolean };
  /**
   * (owner: housing) a workout session started (`active: true`) / ended (`false`). `completed` = it was played to the
   * end and the score counted (false on a cancel). hub sees this, loads the plates onto the barbell and raises /
   * releases the pose and the fixed camera through `ctx.player.setFurniturePose`.
   */
  'housing:gymSession': { uid: string; active: boolean; stat: GymStat; minigame: GymMinigame; completed: boolean };
  /**
   * (owner: housing) one minigame judgement. hub matches the barbell · pedal · body motion to it and audio plays the
   * sound. `index` from 0, `total` = how many judgements this session has.
   */
  'housing:gymBeat': { uid: string; minigame: GymMinigame; quality: 'perfect' | 'good' | 'miss'; index: number; total: number };
  /** (owner: housing) the session result — exactly what `ProgressionRef.applyGymSession` returned. */
  'housing:gymResult': { uid: string; result: GymSessionResult };
  /** (owner: progression) the training bonus · its progress moved. `value` = the training bonus, `delta` = the XP added this time. */
  'progress:trainedChanged': { id: GymStat; value: number; progress: number; delta: number };
  /** (owner: progression) the workout debuff was raised. `until` = epoch ms. Expiry is a function of the clock, so it has no event. */
  'progress:gymFatigue': { id: GymStat; until: number };
  /**
   * (owner: player) a furniture pose was released — `interact` = stood up with E (the rocking chair),
   * `caller` = `setFurniturePose(null)`, `reset` = a phase change · a spawn · `game:abort` · `hub:left`.
   */
  'player:furniturePoseEnded': { kind: FurniturePoseKind; reason: 'interact' | 'caller' | 'reset' };
}

/* ══ appended: 2026-09-12 — character buffs. `src/player/README.md` Decisions ══ */
export interface GameEvents {
  /** (owner: player) my buff list changed — the same array as `PlayerRef.buffs`. ui's buff row and net's `cbuf state` listen. */
  'player:buffsChanged': { buffs: readonly CharBuff[]; revision: number };
  /** (owner: net) squadmate `id`'s buff list changed (the same array as `RemotePlayerRef.buffs`). ui's squad list listens. */
  'net:remoteBuffsChanged': { id: PeerId; buffs: readonly CharBuff[] };
}

/* ══ appended: 2026-09-12 — hybrid shot resolution · the muzzle-blocked indicator ══ */
export interface GameEvents {
  /**
   * (owner: weapons/parts/AimLine) the muzzle is caught on a wall · window frame · piece of cover within
   * `WEAPON_MUZZLE_BLOCK_RANGE` m ahead, so the shot will not follow the crosshair (`true`) / it is clear again
   * (`false`). Emitted only on a change. The red circle on the wall (weapons) and the crosshair's warning colour
   * (ui/hud/Reticle) look at the same judgement — and the real shot lands by that judgement too.
   */
  'weapon:aimBlocked': { blocked: boolean };
}

/* ══ appended: 2026-09-12 — consumables · implants · keys · drone scan · favorites · the gym ══
 * Each parallel agent appends **only inside its own block** (writing `export interface GameEvents { … }` in there). The block order is never changed. */
/* ── [A1] the three consumables ── */
/* ── end [A1] ── */
/* ── [A2] aim sway ── */
/* ── end [A2] ── */
/* ── [B] tactical implants · the ship-call ready effect ── */
export interface GameEvents {
  /**
   * (owner: implants) **the moment** a local implant became usable. A cooldown ended and one charge came back
   * (`full` false = a mid charge of a charge-based implant — the 1st · 2nd of the dash's 3), the barrier's collapse lock
   * was released, overcharge energy filled up, or `ImplantsRef.refillAll` (`refill` true — emitted even when already
   * full). Emitted **only in a gameplay phase** — being full from the start because of a mission start · reset ·
   * equipping is not a moment of becoming ready. ui's ready flash (`hud/ImplantWidget`) and audio's `implant_ready`
   * listen.
   */
  'implant:ready': { id: ImplantId; charges: number; maxCharges: number; full: boolean; refill: boolean };
  /**
   * (owner: implants) a grapple cooldown refund was applied — the remaining cooldown dropped by `seconds`. `ratio` is
   * the fraction the rule gave (against the effective cooldown, `IMPLANT_GRAPPLE_REFUND_*` · `_CANCEL_*`). The HUD's
   * green `−N초` listens.
   */
  'implant:cooldownRefunded': { id: ImplantId; seconds: number; ratio: number };
  /**
   * (owner: stratagems) the moment the shared ship-call cooldown reached 0 — only in a gameplay phase. `refunded` = it
   * reached 0 through the host-denial refund (`refundCooldown`): audio does not play `stratagem_ready` then (the denial
   * sound already played).
   */
  'stratagem:ready': { refunded: boolean };
}
/* ── end [B] ── */
/* ── [C] keys · keycards · locked rooms · crawl holes ── */
/* ── end [C] ── */
/* ── [D] ground drone scan ── */
import type { DroneScanTargetKind } from './drones';
export interface GameEvents {
  /**
   * (owner: gadgets/drones `parts/Scan`) a drone scan result appeared · changed — both my scan (`local`) and a
   * squadmate's. `id` = the target's `Interactable.id`, `rarity` null = empty, `position` = the target's live vector.
   * Labels are read from `DronesRef.getScanResults`.
   */
  'drone:scanned': { id: string; kind: DroneScanTargetKind; name: string; rarity: Rarity | null; position: THREE.Vector3; local: boolean; byName: string };
}
/* ── end [D] ── */
/* ── [E1] the favorites core ── */
export interface GameEvents {
  /**
   * 2026-09-12 (E1): the favorite flag of one item **kind (def id)** was turned on or off
   * (`InventoryRef.toggleFavorite`, and once per def when the server profile document arrives with a different list).
   * Emitted only when the state actually changed. Marks drawn outside the inventory — chips, shop tiles — listen to
   * this and repaint.
   */
  'inventory:favoritesChanged': { defId: string; favorite: boolean };
}
/* ── end [E1] ── */
/* ── [E2] favorite chips · the recovery contract ── */
/* ── end [E2] ── */
/* ── [F] gym minigames ── */
/* ── end [F] ── */

/* ── [2026-09-13] cooking ingredient tiers ── */
export interface GameEvents {
  /**
   * (owner: housing) an output received from the analyzer for the **first** time was written into the analysis
   * catalogue (`ShipState.analysisFound`). ui/ raises one toast. The old `housing:sampleDexAdded` is no longer emitted
   * (it is a catalogue of outputs now, not of samples).
   */
  'housing:analysisFound': { family: SampleFamily; defId: string };
  /** (owner: housing) one family's analysis level rose — ui/ raises a toast (including the results newly opened at this level). */
  'housing:analysisLevelUp': { family: SampleFamily; level: number };
  /** (owner: housing) a socket was inserted into soil · a medium. `replaced` = the def id of the old socket **destroyed** by overwriting (null with none). */
  'housing:socketInserted': { uid: string; target: GrowSocketTarget; defId: string; replaced: string | null };
}
/* ── end [2026-09-13] ── */

/* ── [2026-09-13] the extraction rework (owner: extraction/ExtractionSystem — extraction emits `ui:cinematic` too) ── */
export interface GameEvents {
  /**
   * Every frame while the ship is on the ground. `waiting` = seconds left until the automatic departure grace is
   * raised (`total` = `EXTRACTION_AUTO_DEPART_IDLE_S`), `departing` = seconds left until liftoff
   * (`total` = `EXTRACTION_DEPART_GRACE_S`). The whole squad receives it (aboard or not).
   */
  'extraction:departureTick': { stage: 'waiting' | 'departing'; remaining: number; total: number };
  /** The departure grace started — `auto` = it raised itself on the idle timeout (nobody pressed the switch). It cannot be cancelled. */
  'extraction:departureStarted': { duration: number; auto: boolean };
  /**
   * The ship left without this person and the extraction flow went back to the start — the raid continues and the
   * `신호소` can be activated again. Not emitted on a `game:abort` · `game:newMission` reset.
   */
  'extraction:reset': Record<string, never>;
  /**
   * The liftoff cinematic took the camera (`true`) / gave it back (`false`). ui/HudSystem fades the combat HUD out
   * over `EXTRACTION_HUD_FADE_S`. ui restores it by itself once the phase leaves gameplay or `game:abort` arrives.
   * 2026-09-16 (user's decision): it is **all of the remaining HUD** — the crosshair instantly, the social layers · key
   * guide and the rest by a code-stepped fade, and tutorial/ listens to this too and folds its own guide.
   */
  'ui:cinematic': { active: boolean };
}
/* ── end [2026-09-13] the extraction rework ── */

/* ── [2026-09-14 2nd pass] the screen fade (owner: ui/HudSystem) ── */
export interface GameEvents {
  /**
   * The target opacity of the black plate covering the whole screen. `opacity` 1 = full black · 0 = transparent, and it
   * travels to that value over `durationS` (0 = instantly). The plate sits at the top of `ctx.uiRoot` and **does not
   * eat input** — it is an effect, not a blocker. Its first user is the tutorial opening
   * (`PlayerRef.playIntroWake`): it starts on a black screen and brightens as the fallen body is revealed. ui returns
   * it to 0 by itself once the phase leaves gameplay or `game:abort` arrives.
   *
   * appended (2026-09-15, skipping the tutorial): `hold` — **this plate does not clear itself even when the phase
   * changes.** Omitted = as before (0 the instant the result screen · ship · title takes over). The tutorial raid skip
   * uses it for 「탈출 성공 appears while the screen is still black」, and the side that raised it clears it itself
   * with `{opacity: 0}`. Even a held plate is cleared unconditionally by ui on `game:abort` · `hub:entered` — there is
   * no road that leaves the ship black.
   */
  'ui:screenFade': { opacity: number; durationS: number; hold?: boolean };
}
/* ── end [2026-09-14 2nd pass] ── */

/* ── [2026-09-13] burrow spawns · the sandworm (owner: enemies) ── */
export interface GameEvents {
  /**
   * Fact (every client): the sandworm omen started — it erupts at `position` (on the ground) in `eta` seconds, damage
   * radius `radius`. The host emits it right after the roll, replicas from `ee wormWarn`. This is where a HUD danger
   * indicator belongs (today it is a toast · shake · ground ring).
   */
  'sandworm:warning': { position: THREE.Vector3; radius: number; eta: number };
  /** Fact (every client): sandworm `id` (an enemy id) erupted at `position`. Not emitted in a late joiner's sync (`sy`). */
  'sandworm:erupted': { id: number; position: THREE.Vector3; radius: number };
  /**
   * Command (console `worm`): start a sandworm event **now**, under the local player's feet (authority only; the roll,
   * the window and the once-per-raid limit are ignored). `spitS` = change the bug-spitting stage to this many seconds
   * (0 = straight to the poison stage, omitted = csv).
   * appended (2026-09-15): `weak` = force a juvenile (`sandworm_weak`) (omitted = the planet's threat decides: 1 →
   * juvenile, 2–3 → adult).
   */
  'cheat:sandworm': { spitS?: number; weak?: boolean };
}
/* ── end [2026-09-13] burrow spawns · the sandworm ── */

/* ── [2026-09-13] cooking minigames (owner: housing — `src/housing/README.md` Decisions) ── */
import type { CookBeatAction, CookGame, CookJudge, CookResult } from './cooking';
export interface GameEvents {
  /** The cooking station screen opened / closed (the minigame overlay is `housing:cookSession`). */
  'ui:cookStationToggled': { open: boolean; uid: string | null };
  /**
   * A cook started (`active: true`) / ended (`false`). `completed` = it was played to the end and a meal came out
   * (false on a cancel · failure). hub sees this and raises / releases the pose in front of the station and the fixed
   * camera (if `setFurniturePose` refuses, `ctx.housing.cancelCook()`).
   */
  'housing:cookSession': { uid: string; recipeId: string; mealDefId: string; active: boolean; completed: boolean };
  /**
   * The flow of one step — `choose` = asking 「직접 하기 / 자동」 (straight to `play` when there is no automating
   * furniture), `play` = in the minigame, `done` = finished (`score` filled in, `auto` = it was handled
   * automatically). `index` from 0, `total` = how many steps there are.
   */
  'housing:cookStep': { uid: string; index: number; total: number; game: CookGame; phase: 'choose' | 'play' | 'done'; auto: boolean; score: number | null };
  /** One input · judgement for the effect — hub matches the hands · tools, audio the sound. `quality` = the result when that input was a judgement, else null. */
  'housing:cookBeat': { uid: string; game: CookGame; action: CookBeatAction; quality: CookJudge | null };
  /** The cook result (both success and failure — on a failure, `result.reason`). */
  'housing:cookResult': { uid: string; result: CookResult };
}
/* ── end [2026-09-13] cooking minigames ── */

/* ── [2026-09-13] the rover (owner: world/rover — the rules are the rover section of `shared/types.ts`; consumers: ui · audio · player) ── */
import type { RoverState } from './types';
export interface GameEvents {
  /**
   * Command (world/rover → ui/map): the local player just boarded → open the map in **destination select mode**.
   * `open:false` = close that mode (departure · getting off · destruction · a forced exit). While aboard and stopped,
   * reopening with M gives the same mode (ui looks at `ctx.world.rover`).
   */
  'rover:destinationSelect': { open: boolean };
  /** Fact (every client): the vehicle's state changed. */
  'rover:state': { state: RoverState; stationId: string | null; targetId: string | null };
  /** Fact (every client): every station was revealed for the first time (once per raid). */
  'rover:stationsRevealed': Record<string, never>;
  /** Fact (every client): someone boarded (`aboard: true`) / got off. `local` = the local player, `by` = 'local' or a PeerId. */
  'rover:boarded': { by: string; name: string; local: boolean; aboard: boolean };
  /** Fact (every client): a paid trip was committed — departure in `grace` seconds. `local` = the local player paid. */
  'rover:tripStarted': { by: string; name: string; fromId: string; toId: string; fare: number; local: boolean; grace: number };
  /** Fact (every client): the vehicle actually departed (grace over · including an empty car starting its round). `trip` = a paid trip. */
  'rover:departed': { trip: boolean; targetId: string | null };
  /** Fact (local): the local player's boarding · exit · payment request was refused. */
  'rover:refused': { reason: string };
  /** Fact (every client): it arrived at a station. `trip` = the arrival of a paid trip (a forced exit follows). */
  'rover:arrived': { stationId: string; trip: boolean };
  /** Fact (every client): its hp changed. */
  'rover:damaged': { hp: number; maxHp: number; hazard: boolean };
  /** Fact (every client): it was destroyed (unusable for the rest of the raid). */
  'rover:destroyed': { position: THREE.Vector3 };
  /**
   * Fact (every client): the turret fired a shot (effect · sound). `targetId` is the enemy that round went to: the
   * authority fires and damages in one step (`world/rover/parts/Turret.updateTurretLogic` calls `fire()` on the line
   * after `takeDamage`), so the shot and the body it hit travel together instead of having to be matched up
   * afterwards. A **replica** is handed the impact point alone (`rover fire {p}`) and never knows the target, so it
   * is `null` there.
   */
  'rover:fired': { from: THREE.Vector3; to: THREE.Vector3; targetId: number | null };
  /* appended (2026-09-13, R2) */
  /**
   * Command (console `rover` → world/rover, applied on the authority only): a dev cheat. `hp` = set the hp to `value`
   * (0 = destroyed) · `speed` = the drive speed multiplier · `depart` = set the stop · departure grace timer to 0 ·
   * `arrive` = while driving, skip to a few m short of the destination.
   * (`rover:fired`'s `from` · `to` are reused vectors — read them where they arrive, never keep them.)
   */
  'cheat:rover': { action: 'hp' | 'speed' | 'depart' | 'arrive'; value?: number };
}
/* ── end [2026-09-13] the rover ── */

/* ── [2026-09-13] placement rules · power · crypto mining (`src/housing/README.md` Decisions — the rules are the same-day section of `shared/housing.ts`) ── */
import type { CryptoChartRange } from './cryptoMarket';
export interface GameEvents {
  /**
   * **Retired (the same day, 2026-09-13, user's decision 「전력 할당 시스템 제거」) — nobody emits it.** The contract is
   * add-only, so only the name stays.
   * Fact (housing): generator supply · facility allocation · furniture activity · power demand changed. The generator
   * screen · inspector · station banner redraw.
   */
  'housing:powerChanged': { reason: string };
  /**
   * **Retired (the same day, 2026-09-13) — nobody emits it.** There is no stopped clock any more.
   * Fact (housing): whether one power-using piece of furniture runs changed (because of allocation · activity ·
   * placement · collection · the generator · the main computer). With `operational: true`, `pausedMs` = how long it was
   * stopped — growing · culturing · analysis · mining push their own clocks by that much **synchronously, right where
   * they receive this event**. With `operational: false`, `pausedMs` is 0 (the stopped clock is held by
   * `stationNow(uid)`).
   */
  'housing:operationalChanged': { uid: string; operational: boolean; pausedMs: number };
  /** Fact (housing): a compute cluster's coin · cores · progress band changed. */
  'housing:clusterChanged': { uid: string };
  /** Fact (housing): a cluster finished a cycle and put it in the wallet (when catching up over several cycles, one combined event). */
  'housing:cryptoMined': { uid: string; coinId: string; units: number };
  /** Fact (housing): a wallet balance changed. `units` = the balance after the change, `delta` = the change. */
  'housing:walletChanged': { coinId: string; units: number; delta: number; reason: 'mined' | 'buy' | 'sell' | 'cheat' };
  /** Fact (housing/ui): the compute cluster screen · main computer screen opened / closed. */
  'ui:miningToggled': { open: boolean; uid: string | null; page: 'cluster' | 'computer' };
  /** Fact (net): new quotes arrived (`ctx.net.crypto.prices`). */
  'net:cryptoPrices': { at: number };
  /** Fact (net): the requested candle history arrived (`ctx.net.crypto.getHistory`). */
  'net:cryptoHistory': { coin: string; range: CryptoChartRange };
}
/* ── end [2026-09-13] placement rules · power · crypto mining ── */

/* ── [2026-09-13] library series · video games (`src/housing/README.md` Decisions — the rules are the closing sections of `shared/library.ts` · `shared/housing.ts`) ── */
import type { GameStat } from './library';
export interface GameEvents {
  /** Fact (housing): the summed library effects changed (shelving · unshelving · placing/collecting a holder or helper piece · power). progression recomputes `derived` and the band · sheet · cooking station redraw. */
  'housing:libraryChanged': { revision: number };
  /** Fact (housing): the console mounted on the TV changed (`defId` null = removed). hub rebuilds the TV model. */
  'housing:tvConsoleChanged': { uid: string; defId: string | null };
  /**
   * Fact (housing): a game session started / ended — hub seats the player and raises the fixed camera (`active`),
   * releases it (`!active`). `completed` = it was played to the end.
   * 2026-09-17: `seatUid` null = there is no valid seat, so it is played **standing** (no pose and no camera are
   * raised; only the TV game screen is turned on).
   */
  'housing:gameSession': { tvUid: string; seatUid: string | null; discDefId: string; active: boolean; stat: GameStat; minigame: GymMinigame; completed: boolean };
  /** Fact (housing): one game judgement — the TV screen effect in hub. */
  'housing:gameBeat': { tvUid: string; quality: 'perfect' | 'good' | 'miss'; index: number; total: number };
  /** Fact (housing): the game session result (exactly what `applyGymSession` returned). */
  'housing:gameResult': { tvUid: string; discDefId: string; result: GymSessionResult };
  /** Fact (housing/ui): the TV screen opened / closed. */
  'ui:tvMenuToggled': { open: boolean; uid: string | null };
}
/* ── end [2026-09-13] library series · video games ── */

/* ── [2026-09-14] pinning the inventory tooltip · the shared cursor hold ring ── */
export interface GameEvents {
  /**
   * appended (2026-09-14, owner: whichever screen is being held — today the inventory's tooltip pin `ui/TipPin`): LMB
   * is **being held**. `progress` 0 … 1 (fills over `UI_HOLD_CONFIRM_S`), `null` = it ended · was cancelled · reached 1.
   * `x` · `y` = the cursor's client coordinates (omitted, ui reads `ctx.input.uiX/uiY`). `owner` = who raised the ring
   * (for diagnostics). ui/hud/CursorHoldGauge draws it with the **same ring** as `housing:moveHold` — this is the way
   * to use the ring without importing another folder's internals.
   */
  'ui:cursorHold': { owner: string; progress: number | null; x?: number; y?: number };
  /**
   * appended (2026-09-14, owner: inventory `ui/TipPin`): an item tooltip was pinned (`uid`) / released (`uid: null`).
   * There is exactly one pin on the whole screen, so anyone who hears another `owner`'s pin releases its own.
   * ui/hud/ItemTip drops the hover card that was up the moment a pin happens.
   */
  'ui:tipPinned': { owner: string; uid: string | null };
}
/* ── end [2026-09-14] pinning the inventory tooltip ── */

/* ── [2026-09-14] the messenger · NPC quests · group rooms (`src/meta/README.md` Decisions — the contract itself is the closing sections of `shared/npc.ts` · `shared/social.ts`) ── */
import type { WeaponClass as WeaponClassForKill } from './types';
import type { MessengerTab, NpcInteractKind, NpcLogEntry, NpcQuestState } from './npc';
import type { RoomErrorCode, RoomId, RoomInvite, RoomLine } from './social';
export interface GameEvents {
  /** Fact (meta): one event was appended to an NPC conversation (first contact · offer · accept · hold · re-taking · completion). The ship toast and the messenger list listen. */
  'npc:message': { npc: string; entry: NpcLogEntry };
  /** Fact (meta): the unread total of NPC messages changed. */
  'npc:unreadChanged': { total: number };
  /** Fact (meta): an NPC quest's state changed (`prev` null = from hidden). */
  'npc:questChanged': { id: string; npc: string; state: NpcQuestState; prev: NpcQuestState | null };
  /**
   * Fact (meta): objective progress changed. `raid` = a raid objective, `done` = it was committed (it arrives true
   * once, at that moment), `delta` = this change (the rollback at raid end is negative).
   */
  'npc:objectiveProgress': { questId: string; index: number; progress: number; target: number; done: boolean; delta: number; raid: boolean };
  /** Fact (meta): every objective of an active quest is full — `완료 보고` is now possible. */
  'npc:questReady': { id: string; npc: string };
  /**
   * Fact (world): an interaction succeeded **through this client's own input** — activating a map scanner · opening a
   * locked door · calling/starting the tram · boarding the rover. Not emitted for a squadmate's input (an NPC quest's
   * interact objective counts only your own — user's decision). `id` = the structure · platform · tram · vehicle id.
   */
  'world:interacted': { kind: NpcInteractKind; id: string; structureKind?: StructureKind };
  /** Fact (ui): the messenger opened / closed. */
  'ui:messengerToggled': { open: boolean };
  /** Command (anyone → ui): open the messenger (ship only — ignored during a raid). With a target, straight to that conversation · tab. */
  'ui:openMessenger': { tab?: MessengerTab; npc?: string; code?: PlayerCode; room?: RoomId };
  /** Fact (net): the unread total of private chat changed (a received line · a read mark). */
  'social:unreadChanged': { total: number };
  /** Fact (net): the room list · invites changed (`ctx.net.rooms`). `first` = this connection's first snapshot. */
  'room:updated': { first: boolean };
  /** Fact (net): a line was appended to a room (a received line · my pending line · a system line). */
  'room:line': { line: RoomLine };
  /** Fact (net): the send state of my line changed (ack). */
  'room:lineUpdated': { line: RoomLine };
  /** Fact (net): a room invite arrived. */
  'room:invited': { invite: RoomInvite };
  /** Fact (net): the requested page of lines arrived. */
  'room:history': { room: RoomId };
  /** Fact (net): the unread total of group rooms changed. */
  'room:unreadChanged': { total: number };
  /** Fact (net): a room request was refused (`message` is Korean). */
  'room:error': { code: RoomErrorCode; message: string };
}
/* ── end [2026-09-14] the messenger · NPC quests · group rooms ── */

/* ── [2026-09-14] the intel broker · per-NPC trust (`src/meta/README.md` Decisions) ──────
 * The gimmick lock itself does not travel as an event — the one road to the map is `ctx.missionIntel` (the same
 * convention as `missionPlanet`: set before `game:newMission` is emitted), and the two here are **facts for redrawing
 * the screen**. */
import type { IntelSpec } from './intel';

export interface GameEvents {
  /** Fact (meta): the intel held changed — a purchase · discarding it (a region reassignment) · being spent on a raid · a server document load. */
  'intel:changed': { spec: IntelSpec | null };
  /** Fact (meta): intel was bought (the lock-on effect · the toast listen). `cost` is the credits that actually left. */
  'intel:purchased': { spec: IntelSpec; cost: number };
  /** Fact (meta): an NPC's personal trust changed. `levelUp` when `level` rose (the messenger toasts it). */
  'meta:npcTrustChanged': { npc: string; trust: number; level: number; delta: number; levelUp: boolean };
}
/* ── end [2026-09-14] the intel broker · per-NPC trust ── */

/* ── [2026-09-14] the music player · library · mining UI 2nd pass ──────────────────────────────
 * Music is **state, not sound** (user's decision) — so housing/ owns it, not audio/, and ui/'s player window draws
 * from this one fact. */
import type { MusicPlayerState } from './housing';

export interface GameEvents {
  /** Fact (housing): the music player state changed — on · off · skipping a track · toggling repeat · a change in the record rack's contents. */
  'housing:musicChanged': { state: MusicPlayerState };
}
/* ── end [2026-09-14] the music player ── */

/* ── [2026-09-15] fall feedback (docs/TODO.md B-14) ────────────────────────────────────────────
 * For a local fall the existing `player:fell` alone is enough — the landing sound (audio `fall_impact`), the screen
 * shake (player raises `camera:shake`) and the red vignette (ui `.fall-vignette`) all listen to it. A squadmate's fall
 * is re-emitted as the fact below by player/, which received the `fall` wire (`FallMessage`) — audio plays it with
 * distance falloff. The HUD does not react to a squadmate's fall. */
export interface GameEvents {
  /** Fact (player): squadmate `peerId` fell at `position` and lost `damage` (a received `FallMessage`, past the range · membership checks). Sound only. */
  'player:remoteFell': { peerId: PeerId; position: THREE.Vector3; damage: number };
}
/* ── end [2026-09-15] fall feedback ── */

/* ── [2026-09-15] android squadmates · raid entry loading (`src/allies/README.md` Decisions — the contract itself is the closing sections of `shared/allies.ts` · `net.ts`) ── */
import type { AllyId, AllyRosterEntry } from './allies';
/* appended (2026-09-15): `이어하기` · `레이드 포기` from the title */
import type { RaidResumeOffer } from './raidResume';
import type { ItemRequestKind } from './types';
export interface GameEvents {
  /** Fact (allies, every client): my squad's android roster changed. `evicted` = the units sent back to their bays by a human joining · an overflow (they are in `removed` too). */
  'ally:rosterChanged': { roster: readonly AllyRosterEntry[]; added: readonly AllyId[]; removed: readonly AllyId[]; evicted: readonly AllyId[] };
  /**
   * Fact (net): the relay sent one android back to its bay (`lobby:androidReturned`). `human_joined` = a human joined
   * and the latest recruited unit dropped out (to the whole lobby) · `full` = the squad was full and it could not be
   * taken in (to the requester only).
   */
  'net:androidReturned': { bay: number; reason: 'human_joined' | 'full' };
  /** Fact (allies, every client): it took damage (on a replica, when the snapshot hp drops). */
  'ally:damaged': { id: AllyId; amount: number; hp: number; shield: number };
  /** Fact (allies, every client): it went down. */
  'ally:downed': { id: AllyId; name: string };
  /** Fact (allies, every client): it got back up. `by` = the PeerId of whoever revived it (null when unknown). */
  'ally:revived': { id: AllyId; by: PeerId | null };
  /** Fact (allies, every client): it bled out and died. */
  'ally:died': { id: AllyId; name: string };
  /** Fact (allies, every client): it fired a shot — player draws the muzzle flash · tracer, audio plays the report. The vectors are reused (read and use them at once). */
  'ally:fired': { id: AllyId; from: THREE.Vector3; to: THREE.Vector3; weaponDefId: string | null };
  /** Command (allies → ui/Pings, every client): draw a ping under the android's name (the ping list · callout chat · off-screen arrow). */
  'ally:ping': { id: AllyId; name: string; slot: number; kind: PingKind; position: THREE.Vector3; label?: string; enemyId?: number };
  /** Command (allies → ui/ChatLog, every client): one chat line under the android's name (never relayed). */
  'ally:chat': { id: AllyId; name: string; slot: number; text: string };
  /** Command (allies → player/RemotePods, every client): drop a drop pod. */
  'ally:podDrop': { id: AllyId; position: THREE.Vector3; yaw: number };
  /** Fact (inventory, the squad leader's client): an extracted android's loot went into the stash. `lost` = how many did not fit because the stash was full. */
  'ally:deposited': { id: AllyId; name: string; count: number; lost: number };
  /**
   * Fact (ui/Pings, every client): a ping was placed — local and remote alike, **including the target info**
   * (`ping:placedV2` + `label` · `enemyId`). `owner` = the PeerId of whoever placed it (local = null). For a ping an
   * android placed, `owner` is the android id. allies reads it as an order.
   */
  /** `containerId` (2026-09-19) = the loot-container id a `'crate'` ping snapped onto (`WorldRef.getLootContainers`); `label` stays a display string. */
  'ping:placedV3': { id: number; position: THREE.Vector3; kind: PingKind; expires: number; owner: PeerId | null; label?: string; enemyId?: number; containerId?: string };
  /** Fact (inventory, local): the local player requested an item (middle-click · the menu). `position` = the local player's feet. To a remote host, `allyq item`. */
  'inventory:itemRequested': { kind: ItemRequestKind; defId: string | null; ammoType: string | null; position: THREE.Vector3 };
  /** Fact (inventory, local): the local player opened a container window. To a remote host, `allyq viewing`. */
  'inventory:containerViewed': { containerId: string };
  /** Command (allies → inventory, the squad leader's client): put these into my stash (drop the overflow) → `ally:deposited`. */
  'inventory:allyDeposit': { id: AllyId; name: string; items: readonly ItemInstance[] };
  /** Fact (hub, every client): the launch countdown ended and the fade to black started (the authority launches `RAID_LOAD_FADE_OUT_S` later). */
  'raid:loadBegin': Record<string, never>;
  /** Fact (game/LoadGate): loading progress — `local` = my progress, `squad` = the squad (human) average, `waiting` = how many people are not done, `remainingS` = time left until the timeout. */
  'raid:loadProgress': { local: number; squad: number; waiting: number; remainingS: number };
  /** Fact (game/LoadGate): the loading hold was released — the fade in starts. `timedOut` = it gave up waiting. */
  'raid:loadReleased': { timedOut: boolean };
}
/* ── end [2026-09-15] android squadmates · raid entry loading ── */

/* ══ appended: 2026-09-15 — the sandworm eruption check reworked · the thumper (owner: enemies/sandworm · gadgets). `src/enemies/README.md` Decisions ══ */
/* (gadgets 2026-09-15: the bus's event table is `GameEvents` — a separately declared `Events` interface is not merged, so `bus.emit` does not know this key.) */
export interface GameEvents {
  /**
   * Command (gadgets → enemies/sandworm, emitted **on the host only**): summon a sandworm here, **guaranteed** — a
   * thumper struck the ground for the fifth time. The director starts the omen only when no worm has appeared in this
   * raid yet (once per raid) and ignores it once one has (the device just keeps pounding — user's decision). On an
   * eruption `sandworm:erupted` goes out as usual, and gadgets destroys the thumpers within that radius.
   */
  'sandworm:summon': { position: THREE.Vector3; source: 'thumper' };
}
/* ── end [2026-09-15] the sandworm · the thumper ── */

/* ══ appended: 2026-09-15 — `이어하기` · `레이드 포기` from the title (owner: game/parts/Resume). `src/game/README.md` Decisions ══ */
export interface GameEvents {
  /** Fact (game): the raid the title will offer changed (it appeared · disappeared · its roster · a server check starting/ending). ui/menus/TitleMenu redraws. */
  'raid:resumeChanged': { offer: RaidResumeOffer | null; checking: boolean };
}
/* ── end [2026-09-15] `이어하기` · `레이드 포기` from the title ── */

/* ══ appended: 2026-09-16 — the result screen → ship return fade (owner: ui/menus/ShipReturn) ══ */
export interface GameEvents {
  /**
   * Command (a ui result-screen button · game's automatic return → ui): go back to the ship from the result screen
   * (`complete` · `dead`) — fade out → black + the loading gauge → (`hub:enter` in the middle, and once the ship
   * scene's shaders have compiled) fade in. Ignored while one is already running.
   * Emitting `hub:enter` directly makes the ship pop out of the result screen in one frame — from a result screen,
   * emit this instead.
   */
  'ui:shipReturn': Record<string, never>;
}
/* ── end [2026-09-16] the result screen → ship return fade ── */

/* ══ appended: 2026-09-16 — the ship track tutorial's stat guidance (owner: progression/ui/SheetBody) ══ */
export interface GameEvents {
  /**
   * Fact (progression ui): the sum of the character sheet's **uncommitted ＋ points** changed (＋ · － · revert ·
   * confirm · a forced discard). The investment itself is still `progress:statChanged`. The tutorial's `stats` step
   * picks its 「능력치 하나 상승」 objective and its focus (the ＋ column ↔ the confirm button) from this.
   */
  'progress:statPending': { total: number };
}
/* ── end [2026-09-16] the ship track tutorial's stat guidance ── */

/* ══ appended 2026-09-21: reload hold · ally healing (owner: weapons · gadgets · implants · player · ui) ══ */

/* ══ appended: 2026-09-21 [W] — the reload hold · using a healing consumable on an ally (owner: weapons; reader: ui) ══ */
export interface GameEvents {
  /**
   * Fact (weapons): the running reload was **frozen** — its timer stopped where it was and no `weapon:reloadFinished`
   * will come until `weapon:reloadResumed`. It is **not** a cancel: `weapon:reloadCancelled` still means the progress
   * is gone. The crosshair ring must stop counting down on this one, because it runs its own local countdown off
   * `weapon:reloadStarted {duration}` and would otherwise fill to 100 % while the gun stands still.
   * Sent again with a different `reason` only after a resume — overlapping reasons are one hold.
   */
  'weapon:reloadPaused': { weaponId: string; reason: import('./types').ReloadPauseReason };
  /** Fact (weapons): the hold ended and the reload runs on from where it stopped. `remaining` = seconds still to go. */
  'weapon:reloadResumed': { weaponId: string; remaining: number };
  /**
   * Fact (weapons): which squadmate a **right-click** would use the healing consumable in hand on — the body at the
   * smallest angle off the crosshair inside `HEAL_ALLY_AIM_CONE_DEG` and `HEAL_ALLY_RANGE_START`.
   * `inHand` false = the thing in hand cannot be given to anybody (a gun, a grenade, a gadget), so the prompt has
   * nothing to say at all and `kind` is null. `inHand` true with `name` null = it **can** be given but nobody is
   * valid right now (none aimed at, out of range, behind a wall, downed, or the gift would do nothing for them) —
   * the right button must then *look* unavailable rather than silently do nothing. Sent only when it changes.
   */
  'heal:allyTargetChanged': { name: string | null; inHand: boolean; kind: 'heal' | 'shield' | null };
  /**
   * Fact (weapons): the right-button hold that treats `name` (the same ring as `heal:holdChanged`, its own label —
   * `kind` decides whether that reads 회복 or 실드 충전). `t` = 0..1 of the item's use time, `-1` /
   * `holding: false` = cancelled or finished. There is **no movement penalty** on this hold —
   * `CONSUMABLE_SLOW_MUL` is the self use only.
   */
  'heal:allyHoldChanged': { holding: boolean; t: number; dur: number; name: string | null; kind: 'heal' | 'shield' };
}
/* ── end [2026-09-21 W] the reload hold · using a healing consumable on an ally ── */

/* ══ appended 2026-09-21: rover parts · hostility · wreck crates (owner: world/rover) ══ */

export interface GameEvents {
  /**
   * Fact (every client): the vehicle has just turned **hostile** — the player side dealt more than
   * `ROVER_AGGRO_DAMAGE` and it now shoots the attacker and their squad for the rest of the raid. It fires once,
   * on the transition, on the authority and on a replica alike (a replica learns it from `rover state`), so the
   * person who was not shooting still gets told why the turrets swung around. `ui/` owns the toast.
   */
  'rover:hostile': Record<string, never>;
}

export interface GameEvents {
  /**
   * Fact (net): a pair's player trust moved on the relay (`trust:gain`). `reason` raid = the shared-raid grant, like =
   * a like; `mine` (likes) true = I sent it, false = they liked me. `points` is the pair's new total.
   */
  'net:trustChanged': { code: import('./social').PlayerCode; name: string; points: number; delta: number; reason: 'raid' | 'like'; mine?: boolean };
  /** Fact (net): my like window for the last raid changed (relay `trust:window`, a raid start, a refusal). Re-read `ctx.net.trust.canLike`. */
  'net:trustWindow': { open: boolean };
  /** Fact (net): the relay refused my like (`trust:refused`). `message` is the Korean line to show. */
  'net:trustRefused': { code: import('./social').PlayerCode; error: import('./playerTrust').TrustLikeError; message: string };
}

export interface GameEvents {
  /** Fact (meta): the mailbox changed — delivery, read, claim, delete, or a profile reload. `ui/` redraws the button and window. */
  'mail:changed': { unread: number; total: number };
  /** Fact (meta): a new mail arrived (`send` accepted it). No toast — the mail button's red dot pops (`ui/hud/Community`). */
  'mail:received': { id: string; from: string };
  /** The ship mail window opened / closed (`ui/hud/Community`; blocker `COMMUNITY_BLOCKER`, token `MAIL_WINDOW_TOKEN`). */
  'ui:mailToggled': { open: boolean };
}

export interface GameEvents {
  /**
   * 2026-09-21 (owner: survey/): a subject's account progress crossed a whole percent (`percent` = floor of
   * `progress × 100`). meta/ reads it for the `survey` NPC objective.
   */
  'survey:progress': { subjectId: string; progress: number; percent: number };
}
