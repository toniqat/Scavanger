import type * as THREE from 'three';
import type { GamePhase, ItemInstance, MissionStats, EnemyType, Stance, HubShipKind, ChatKind, PingKind, WeaponSlot, SocketSlot, StratagemId } from './types';
/* appended (2026-09-09): 레이드 플레이 개선 — 구조물 · 재해 · 의사소통 휠 */
import type { StructureKind, HazardKind } from './types';
/* appended (2026-09-11) */
import type { LadderDef } from './types';
import type { CommsId } from './comms';
/* appended (Phase 10): varied enemy deaths / probabilistic corpse looting */
import type { EnemyDeathDir } from './types';
/* appended (2026-09-08): 폐금속 공급 — 고철 노드 */
import type { GatherNodeKind } from './types';
import type { LobbyErrorCode, LobbyState, PeerId } from './net';
import type { EquipSlot, WeightState } from './gear';
import type { ImplantId, ScanTarget } from './implants';
import type { DeployableKind, GadgetId } from './gadgets';
/* appended (2026-09-11): 드론 · 네임드 로그 */
import type { DroneKind, DroneReleaseReason } from './drones';
import type { NamedRogueType } from './named';
import type { PlayerProfile, SkillId, StatId } from './progression';
import type { EquippedImplant } from './progression';
/* appended (2026-09-06): ship housing payloads */
import type { FacilityId, PlacedFurniture, RoomPurpose, ShipState } from './housing';
/* appended (2026-09-08): 튜토리얼 */
import type { TutorialStepId } from './tutorial';

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

  /* ── world (owner: world/WorldSystem) ───────────────────────────────── */
  /** `planet` (appended, Phase 11): what the world was generated for; null = the seeded biome draw. */
  'world:ready': { seed: number; playerSpawn: THREE.Vector3; planet?: PlanetId | null };
  'world:cleared': Record<string, never>;
  /** A crate was interacted with; Inventory opens the container window. */
  'crate:open': { crateId: string; tier: number; position: THREE.Vector3 };
  'crate:looted': { crateId: string };   // emitted by inventory when container becomes empty

  /* ── player (owner: player/PlayerSystem) ────────────────────────────── */
  'player:spawned': { position: THREE.Vector3 };
  'player:healthChanged': { hp: number; maxHp: number; delta: number };
  'player:damaged': { amount: number; hp: number; from?: THREE.Vector3 };
  'player:died': { position: THREE.Vector3 };
  'player:stimUsed': { hp: number };
  'player:sprintChanged': { sprinting: boolean };
  'player:aimChanged': { aiming: boolean };
  'player:landed': { impactSpeed: number };
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
  'enemy:killed': { id: number; type: EnemyType; position: THREE.Vector3; by?: string | null; deathDir?: EnemyDeathDir };
  'enemy:attacked': { id: number; type: EnemyType; damage: number; position: THREE.Vector3 };
  'enemy:alerted': { id: number; type: EnemyType; position: THREE.Vector3 };
  'enemy:waveStarted': { index: number; count: number };
  /** Command (enemies → player): apply a movement slow (speed × factor) for `duration` seconds (spewer acid). */
  'player:applySlow': { duration: number; factor: number };

  /* ── inventory / items (owner: inventory/InventorySystem) ───────────── */
  'inventory:opened': { containerId: string | null };
  'inventory:closed': Record<string, never>;
  'inventory:changed': { totalValue: number; itemCount: number };
  'inventory:itemAdded': { item: ItemInstance; name: string; rarity: string };
  'inventory:itemRemoved': { item: ItemInstance };
  'inventory:full': { item: ItemInstance; name: string };
  'inventory:itemRotated': { item: ItemInstance };

  /* ── extraction (owner: extraction/ExtractionSystem) ────────────────── */
  'extraction:activated': { pointId: string; position: THREE.Vector3; duration: number };
  'extraction:tick': { remaining: number; total: number };
  'extraction:shipIncoming': { position: THREE.Vector3; eta: number };
  'extraction:shipLanded': { position: THREE.Vector3 };
  'extraction:boarded': Record<string, never>;
  'extraction:liftoff': { position: THREE.Vector3 };
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
  'net:lobbyLeft': { reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' };
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
  'net:remoteGrenade': { id: PeerId; position: THREE.Vector3; velocity: THREE.Vector3; fuse?: number };
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
  /** Shared cooldown (seconds left, total). Emitted on start, every ~0.5 s and at 0. */
  'stratagem:cooldown': { remaining: number; total: number };
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
  /** Charge / spin-up / slash wind-up readout 0..1 (−1 = cancelled). ui draws a gauge next to the reticle. */
  'weapon:chargeChanged': { weaponId: string; kind: 'charge' | 'spinup' | 'slash'; t: number };
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

  /* ── 온실 재배 (owner: housing) ── */
  /** A plot of `uid` was planted, harvested or became ready. `ready` = how many plots of that rack can be harvested now. */
  'housing:growChanged': { uid: string; ready: number };
  /** The 재배층 panel opened / closed (blocker `housing`). */
  'ui:growToggled': { open: boolean; uid: string | null };

  /* ── 함선 관리 (owner: housing, rendered by ui) ── */
  /** 함선 관리 (M) opened / closed, and which room the camera is on. ui/ draws the room list + furniture bar from this. */
  'housing:shipManageChanged': { active: boolean; room: number | null };

  /* ── 설정 (owner: ui, applied by audio) ── */
  /** A volume slider moved. audio/ persists; anything else that cares can react. */
  'audio:volumeChanged': { channel: AudioChannel; value: number };
  /** The 설정 screen opened / closed (inside the pause menu, no blocker of its own). */
  'ui:settingsToggled': { open: boolean };

  /* ── 아이템 분해 (owner: inventory) ── */
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

  /* ── 서재 책장 (owner: housing) ── */
  /** Books on shelf `uid` changed (`count` shelved); also fired when a shelf is recovered (count 0). */
  'housing:booksChanged': { uid: string; count: number };
  /** The 책장 panel opened / closed (blocker `housing`). */
  'ui:bookshelfToggled': { open: boolean; uid: string | null };
}

/* ══ appended: Phase 10 — UI 개선 pass (2026-09-07) ═════════════════════════════════════════════════════════ */
import type { CarryEndReason } from './types';
import type { CrewCardWire } from './net';
export interface GameEvents {
  /* ── 재장전 게이지를 크로스헤어로 (owner: weapons, drawn by ui/hud/ReloadGauge) ── */
  /**
   * A reload was aborted before it finished (melee / swap / put-away / death / a unique taking over). Genuinely new:
   * `WeaponSystem.cancelReload()` used to be silent, and the bottom-right panel only got away with it because
   * `weapon:equipped` closed its arc. A crosshair ring must be told explicitly.
   */
  'weapon:reloadCancelled': { weaponId: string };

  /* ── 회복약 2초 홀드 (owner: weapons, drawn by ui/hud/HealGauge) ── */
  /**
   * 회복약 in hand: `holding` while LMB is down, `t` = 0..1 of the use time, `t: -1` on cancel. Same contract shape
   * as `grenade:holdChanged`, so the HUD gauge is a sibling of `CookGauge`.
   * appended 2026-09-07: `dur` = the item's own use time in seconds (`ItemDef.heal.useTime`, `HEAL_HOLD_S` when a
   * def omits it) so the ring can count down real seconds; `spray` marks the 회복 스프레이 channel, where `t` is the
   * remaining gauge (0..1) rather than progress toward a use.
   */
  'heal:holdChanged': { holding: boolean; t: number; dur?: number; spray?: boolean };

  /* ── 지도 핑 (owner: ui — map screen → ping system, in-folder) ── */
  /** A ping was asked for at a world position by a surface with no aim ray (tactical-map middle click). */
  'ping:requestAt': { position: THREE.Vector3; kind: PingKind };
  /* ── appended (2026-09-09): 확인 핑 (owner: ui/hud/Pings) ── */
  /**
   * Somebody pinged an existing squad ping to say 알겠다. `id` = the acknowledged ping's local id (as in `ping:placedV2`),
   * `by` = the acker (null = the local player), `slot` = their lobby slot (colour). Fired for local and remote acks.
   */
  'ping:acked': { id: number; by: PeerId | null; name: string; slot: number };

  /* ── 마우스 커서 모드 (owner: shared/cursor.ts + Input; the art is ui/hud/GameCursor) ── */
  /**
   * A UI surface took / released the mouse. `owner` = the blocker token that asked for it, null on the last release.
   * 2026-09-07: cursor mode means the **pointer lock is released** and the real OS cursor is back (restyled in place),
   * so this is also the signal that the camera has stopped following the mouse.
   */
  'input:cursorModeChanged': { active: boolean; owner: string | null };

  /* ── 컨테이너 실시간 루팅 (owner: inventory) ── */
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

  /* ── 부상자 들쳐메기 (owner: player; the remote mirror is net's) ── */
  /** We shouldered a downed squadmate (`id` null = a host-simulated ghost body). */
  'player:carryStarted': { id: NetPeerId | null; name: string | null };
  /** The carried squadmate is back on the ground. */
  'player:carryEnded': { id: NetPeerId | null; reason: CarryEndReason };
  /** A squadmate picked up / put down another squadmate (HUD markers, 분대 목록). */
  'net:remoteCarryChanged': { id: NetPeerId; carrying: NetPeerId | null };

  /* ── 발사 준비 패널 (owner: hub; the crew wire is net's) ── */
  /** A member's ship-side card arrived / changed. The local player is included (`id === net.localId`). */
  'net:crewCard': { id: NetPeerId; card: CrewCardWire };
  /** A member answered `crewq loadout`; `loadout` is inventory's opaque document — validate before rendering. */
  'net:crewLoadout': { id: NetPeerId; card: CrewCardWire; loadout: unknown };
  /** The READY panel opened / closed (blocker `HUB_READY_BLOCKER`, software cursor on). */
  'hub:readyPanelToggled': { open: boolean };
  /** A member's 장비 popup opened / closed from the READY panel; `peerId` null = closed. */
  'hub:crewLoadoutToggled': { open: boolean; peerId: NetPeerId | null };

  /* ── 배리어 방패 (owner: implants) ── */
  /** The shield was raised / lowered (distinct from the old deploy/stow of `implant:barrierChanged`). */
  'implant:barrierCarried': { up: boolean };
}

/* ══ appended: Phase 11 — 행성 선택 · 소셜 (2026-09-07) ══════════════════════════════════════════════════════ */
import type { PlanetId } from './planets';
import type { PlayOutcome, PlayerCode, SocialErrorCode, SocialSnapshot, SquadInvite, WhisperLine } from './social';

export interface GameEvents {
  /* ── 목표 행성 (owner: hub; world / core / enemies read `ctx.missionPlanet` instead) ── */
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

  /* ── 소셜 (owner: net/SocialSync; drawn by ui/) ── */
  /** A snapshot arrived. `first` = the one that came with `welcome` / the first `social:get` of this connection. */
  'social:updated': { snapshot: SocialSnapshot; first: boolean };
  /** A squad invite arrived (panel under the community thumbnail, P-hold to accept). */
  'social:invited': { invite: SquadInvite };
  /** An invite left the list: accepted, dismissed, or `SQUAD_INVITE_TTL_S` expired. */
  'social:inviteClosed': { from: PlayerCode; reason: 'accepted' | 'dismissed' | 'expired' };
  /** A whisper was sent or received (`line.out` distinguishes). ChatLog renders it, nothing else consumes it. */
  'social:whisper': { line: WhisperLine };
  /** How my 같이 하기 resolved — `joined` (a docking cutscene follows) or `invited` (they were asked). */
  'social:play': { code: PlayerCode; name: string; outcome: PlayOutcome };
  /** A social request was refused. `message` is the Korean line from `SOCIAL_ERROR_MESSAGE_KO`. */
  'social:error': { code: SocialErrorCode; message: string };

  /* ── 커뮤니티 / 귓속말 UI (owner: ui) ── */
  /** The ship's top-right 커뮤니티 panel opened / closed (blocker `COMMUNITY_BLOCKER`). */
  'ui:communityToggled': { open: boolean };
  /* appended (2026-09-07, 커서 rework): Alt freed / re-captured the mouse cursor with no screen behind it. */
  'ui:freeCursorToggled': { active: boolean };
  /**
   * Command: open the chat input in whisper mode aimed at `code` (the ESC screen's 귓속말하기 closes itself and emits
   * this). ChatLog keeps the target until the player clears it, so the next Enter also whispers.
   */
  'chat:whisperTo': { code: PlayerCode; name: string };

  /* ══ appended: 2026-09-08 batch — 임플란트 아이템 · 배리어 · 정찰 · 총알 추적 · 재개 게이트 · 분해 게이지 ═══════ */
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
   * 브라우저 전용 '좌측 클릭으로 게임 재개' gate (owner: game). Shown when the last cursor screen closed with Escape and
   * the pointer lock could not be re-taken (Chrome grants Escape no activation); hidden on the click that re-locks.
   */
  'ui:resumeGate': { shown: boolean };
  /** 아이템 분해 progress 0..1 while the hold runs (owner: inventory; the 분해 panel draws its bar from this). */
  'inventory:disassembleProgress': { uid: string; t: number; done: boolean };
  /**
   * Continuous-use item (회복 스프레이) channel started / stopped (owner: weapons). ui keeps **one** ticker alive for the
   * length of the channel instead of one per tick. `gauge` = remaining gauge 0..1.
   */
  'item:channelChanged': { uid: string; defId: string; active: boolean; gauge: number };

  /* ── appended (2026-09-08): 튜토리얼 (owner: tutorial) ── */
  /**
   * The tutorial started, advanced or ended. `step` is null when it is over; `index` / `count` are 1-based progress
   * for a readout. Every folder that hides or gates something during the tutorial re-reads `ctx.tutorial` here.
   */
  'tutorial:changed': { active: boolean; step: TutorialStepId | null; index: number; count: number };
  /** The tutorial is over — completed (`skipped: false`) or waved off from the 건너뛰기 button / console. */
  'tutorial:finished': { skipped: boolean };

  /* ── 화면 설정 (2026-09-08, owner: ui/menus/SettingsMenu) ── */
  /**
   * The 화면 설정 section changed (or was restored at startup). Applied by **`main.ts`**, the one place that holds the
   * `Engine`: bloom → `setPostProcessing`, shadows → `setShadows`, scale → `setResolutionScale`. `fullscreen` is
   * already applied by the panel itself (only a user gesture may request it) and is reported here for completeness.
   */
  'ui:displayChanged': { fullscreen: boolean; bloom: boolean; shadows: boolean; scale: number };

  /* ── 공용 함선 격납고 (2026-09-08) ── */
  /**
   * Fact (net): a member's `ship state` arrived and `ctx.net.getShipVisit(id)` now answers. hub/ waits for this
   * when a bay was entered before the layout was known.
   */
  'net:shipVisit': { id: PeerId };
  /**
   * Fact (hub): the player entered or left a 개인 함선 through a hangar bay. `peerId` = the ship's owner (our own id
   * for our own ship), null when we are back on the shared deck; `readOnly` marks someone else's ship.
   */
  'hub:shipVisit': { peerId: PeerId | null; readOnly: boolean };

  /* ── 키 가이드 (2026-09-09) ── */
  /**
   * 키 가이드 one-liner, bottom-right of the screen (drawn by `ui/hud/KeyGuide`; e.g. `R 회전 · X 버리기 · Tab 닫기`).
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

  /* ── 창문 워프 (2026-09-09): 행성 이동 is no longer a cutscene ── */
  /**
   * Fact (hub): progress of the in-ship warp seen through the viewports, emitted every frame while `hub:travel` runs.
   * `t` = 0..1 of `HUB_TRAVEL_DURATION`; `speed` = 0..1 warp intensity (ramps up over `HUB_WARP_RAMP_S`, holds, ramps
   * down over the last `HUB_WARP_RAMP_S`) — the starfield stretch, the hull shake and the audio all follow `speed`.
   * Controls stay enabled for the whole trip (the player walks around the ship); pods / terminal stay refused via
   * `ctx.hub.travelling`.
   */
  'hub:warpProgress': { planet: PlanetId; t: number; speed: number };

  /* ══ 2026-09-09: 사망/시체 · 구조선 · 분대장 · 전장의 안개 ═══════════════════════════════════════════════
   *
   * **자동 부활은 사라졌다.** `player:died` 뒤에 30초 카운트다운은 없고 `game:respawnAvailable` 도 더는
   * 발행되지 않는다 (계약에는 남는다 — 삭제 금지). 완전히 죽으면 시체가 되고, 되살아나는 길은
   * 분대원이 부르는 `rescue_drop` 뿐이다.
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

  /* ── 시체 (owner: game/parts/Corpses) ── */
  /**
   * Fact: 사망한 플레이어의 시체가 월드에 섰다. **레이드가 끝날 때까지 사라지지 않는다** (수명 · 거리 컬링 없음).
   * 루팅은 `Interactable` `pcorpse:<owner>:<n>` → 기존 컨테이너 창(`inventory:containerOpened`)이 맡는다.
   */
  'corpse:playerSpawned': { id: string; ownerId: string; ownerName: string; position: THREE.Vector3; yaw: number };
  /** Fact: 그 시체에서 마지막 아이템까지 빠졌다 (메시는 남고 프롬프트만 바뀐다). */
  'corpse:playerEmptied': { id: string; ownerId: string };

  /* ── 구조선 투하 (owner: stratagems/parts/Rescue) ── */
  /** Fact: 분대 공용 잔여 횟수가 바뀌었다 (미션 시작의 초기값 방송 포함). */
  'rescue:countChanged': { left: number; total: number };
  /** Fact: 구조선 호출이 확정됐다 (횟수는 이 시점에 차감된다). `target` = 되살아날 분대원의 PeerId. */
  'rescue:called': { callId: string; target: string; targetName: string; by: string; position: THREE.Vector3; eta: number };
  /** Fact: 구조 포드가 착륙해 그 분대원이 다시 섰다. */
  'rescue:landed': { callId: string; target: string; position: THREE.Vector3 };
  /** Command (ui → stratagems): 구조선 선택 화면에서 이 분대원을 고른다 (`null` = 선택 해제). */
  'rescue:selectTarget': { peerId: string | null };

  /* ── 분대장(호스트) (owner: game/parts/Leader) ── */
  /** Fact: 호스트가 완전히 사망해 시체 옆에 분대장 기기가 떨어졌다 (`Interactable` `leader_device`, 3초 홀드). */
  'leader:deviceDropped': { position: THREE.Vector3; hostId: string };
  /** Fact: 누군가 기기를 집어 분대장을 이어받았다 (기기는 사라진다). */
  'leader:deviceTaken': { by: string; byName: string };
  /** Command (ui/hub → net): 이 분대원에게 분대장을 넘긴다 (커뮤니티 우클릭 · 함선 안 상호작용). */
  'leader:transferRequested': { peerId: string };

  /* ── 전장의 안개 (owner: world/Fog) ── */
  /**
   * Fact: 안개 마스크가 자랐다. 지도는 이 이벤트에만 반응해 캐시된 안개 레이어를 다시 그린다 —
   * 매 프레임 `FogRef.mask` 를 훑지 않는다. `explored` = 0..1 탐색률.
   */
  'fog:revealed': { revision: number; explored: number };
  /**
   * Fact: 아직 못 보던 랜드마크를 처음 발견했다 (탈출 신호소 · 둥지 · 상자 …). 토스트 · 지도 아이콘 · 나침반이
   * 이걸 기준으로 켜진다. `kind` 는 지도 마커의 종류와 같은 이름을 쓴다.
   */
  /* 2026-09-09 (레이드 플레이 개선): `structure` (버려진 전진기지 · 연구실 · 불시착 함선), `rail` (선로 · 플랫폼),
     `grove` (거대 버섯 군락 = 독성 포자 발생지) 추가 — union 은 추가만 한다. */
  'fog:discovered': {
    kind: 'extraction' | 'nest' | 'crate' | 'outpost' | 'gather' | 'structure' | 'rail' | 'grove';
    id: string; position: THREE.Vector3;
  };

  /* ── 원격 강하 포드 (owner: player/RemotePlayerSystem) ── */
  /**
   * Fact: 원격 분대원의 강하 포드가 떨어지기 시작했다. `kind` 0 = 미션 시작, 1 = 구조선.
   * 2026-09-09 이전에는 아군이 그냥 자리에 나타났다 — 이제 포드가 보인다.
   */
  'net:remotePodDrop': { id: string; position: THREE.Vector3; yaw: number; kind: 0 | 1 };

  /* ══ 2026-09-09: 레이드 플레이 개선 — 의사소통 · 구조물 · 선로 · 재해 · 로그 강하 ═══════════════════════
   * 소유 폴더는 각 절 머리에. 전부 **추가**이고 기존 이벤트는 손대지 않았다.
   * ══════════════════════════════════════════════════════════════════════════════════════════════════════ */

  /* ── 의사소통 휠 (owner: ui/hud/CommsWheel) ── */
  /**
   * Fact: 누군가 의사소통 휠에서 한 마디를 보냈다 (`H` 홀드 → 방향 선택 → 놓기). 로컬 · 원격 공통.
   * 채팅 한 줄(`ChatKind 'request'`)과 오디오는 ui/ 가 이 이벤트 하나에서 만든다.
   * `text` 는 이미 완성된 한국어 문장이다 — `contract` 처럼 숫자가 들어가는 문구는 **보낸 쪽이** 채워 보낸다.
   * `position` = 보낸 사람의 위치 (원격은 마지막 스냅샷 위치), 알 수 없으면 null.
   */
  'comms:sent': {
    id: CommsId; text: string; by: string | null; byName: string; slot: number; position: THREE.Vector3 | null;
  };
  /** Fact: 의사소통 휠이 열리고 닫혔다 (`downed` = 전투불능 2칸 배치). `hover` = 지금 가리키는 칸 index, 없으면 null. */
  'comms:wheelChanged': { open: boolean; downed: boolean; hover: number | null };

  /* ── 지역 핑 휠 (owner: ui/hud/Pings) ── */
  /**
   * Fact: 핑 버튼을 누르고 있는 동안의 좌/우 휠이 열리고 닫혔다. `downed` 면 살려줘 / 나를 버려,
   * 아니면 여기 조심해 / 저쪽으로 가자. `hover` 는 지금 향한 쪽.
   */
  'ping:wheelChanged': { open: boolean; downed: boolean; hover: 'left' | 'right' | null };

  /* ── 버려진 구조물 (owner: world/Structures) ── */
  /** Fact: 구조물의 지하실 문이 키카드로 열렸다 (키카드는 소비된다). */
  'structure:unlocked': { id: string; kind: StructureKind; by: string | null; position: THREE.Vector3 };
  /** Fact: 구조물의 컴퓨터로 행성 스캔을 돌려 주변 `radius` m 의 안개가 걷혔다 (구조물당 1회). */
  'structure:scanned': { id: string; kind: StructureKind; position: THREE.Vector3; radius: number };
  /**
   * Fact: 플레이어가 구조물(또는 선로 플랫폼)의 컨테이너를 조사했다 — **로그 강하 추첨의 유일한 계기**다.
   * `zoneId` 는 "구역당 1회" 를 세는 열쇠(구조물 id 또는 플랫폼 id)이고, enemies/ 가 이걸 듣고 굴린다.
   */
  'structure:investigated': { zoneId: string; kind: StructureKind | 'platform'; position: THREE.Vector3 };

  /* ── 선로 · 전차 (owner: world/Rails) ── */
  /** Fact: 콘솔에서 전차에 시동이 걸렸다 (호스트가 확정한 뒤). */
  'rail:tramStarted': { lineId: string; tramId: string; by: string | null };
  /** Fact: 전차가 플랫폼에 정차했다 / 다시 출발했다. */
  'rail:tramDocked': { tramId: string; platformId: string | null; docked: boolean };

  /* ── 로그 강하 (owner: enemies/RogueDrop) ── */
  /** Fact: 로그 강하가 예고됐다 (하늘의 포드 + 경보). `eta` = `ctx.time` 기준 착지까지 남은 초. */
  'rogueDrop:incoming': { dropId: string; position: THREE.Vector3; count: number; boss: boolean; eta: number };
  /** Fact: 포드가 착지해 로그들이 내렸다. */
  'rogueDrop:landed': { dropId: string; position: THREE.Vector3; count: number; boss: boolean };

  /* ── 환경 재해 (owner: world/Hazard) ── */
  /** Fact: 이번 레이드의 재해와 시작 시각이 정해졌다 (미션 시드에서, 월드 생성 직후 한 번). */
  'hazard:planned': { kind: HazardKind; startsAt: number };
  /** Fact: 시작 `HAZARD_WARN_S` 초 전 예고. HUD 경고 · 오디오가 여기 붙는다. */
  'hazard:announced': { kind: HazardKind; secondsLeft: number };
  /** Fact: 재해가 시작됐다. */
  'hazard:started': { kind: HazardKind };
  /** Fact: 진행도가 바뀌었다 (초당 몇 번 수준으로만 발행한다 — 프레임마다 쏘지 않는다). `progress` 0..1. */
  'hazard:progress': { kind: HazardKind; progress: number };
  /** Fact: 로컬 플레이어가 피해 구역에 들어갔다 / 나왔다. 시야 · 화면 효과 · 경고음이 여기 붙는다. */
  'hazard:insideChanged': { inside: boolean; kind: HazardKind | null };

  /* ── 대기 오버라이드 (owner: core/Atmosphere) ── */
  /**
   * Command: 하늘 · 포그를 일시적으로 밀어붙인다. `fogMul` = 현재 행성 포그 농도의 배수(1 = 원래대로),
   * `color` = 섞어 넣을 포그/하늘 색(0xRRGGBB, null = 그대로), `blend` = 0..1 섞는 정도.
   * 재해가 이걸로 시야를 좁히고, 재해가 끝나면 `{fogMul:1, color:null, blend:0}` 로 되돌린다.
   * core/ 는 마지막으로 받은 값 하나만 기억하고 매 프레임 팔레트 위에 얹는다.
   */
  'atmo:override': { fogMul: number; color: number | null; blend: number };

  /* ══ appended (2026-09-10): 방탄복 = 실드 · 원격 발소리 · 위험 인디케이터 ══════════════════════ */
  /**
   * Fact: 로컬 플레이어의 **실드**(방탄복이 주는 추가 체력)가 바뀌었다. `hp` 와 완전히 별개의 풀이고
   * 피해는 실드 → 체력 순으로 들어간다. 방탄복을 벗으면 `maxShield: 0`, `rarity: null`.
   * `rarity` · `tier` 는 좌하단 실드 게이지의 **칸 색과 칸 수**를 정한다 (`ARMOR_SHIELD_PER_SEGMENT` 당 한 칸).
   * 장착 · 교체 · 피격 · 충전 · 스폰 어디서든 발행된다 (`delta` = 이번 변화량, 감소는 음수).
   */
  'player:shieldChanged': { shield: number; maxShield: number; delta: number; rarity: Rarity | null; tier: number };
  /**
   * Fact: **원격** 분대원의 발이 땅에 닿았다 (로컬 플레이어는 `player:footstep`). audio 가 거리 감쇠를
   * 걸어 재생한다 — 발행하는 쪽은 거리를 재지 않는다.
   */
  'remote:footstep': { position: THREE.Vector3; sprinting: boolean; peerId: PeerId };

  /* ══ appended (2026-09-10): 서버 주소 ══════════════════════════════════════════════════════════ */
  /**
   * Fact: 접속할 릴레이 주소가 바뀌었다 (`설정 › 서버 설정`). `custom` = 사용자가 직접 적은 주소이고
   * false 면 배포 기본값(같은 오리진 `/ws`)으로 되돌아간 것이다. **재접속은 이 이벤트가 하지 않는다** —
   * `NetRef.reconnectRelay()` 를 부른 쪽이 한다.
   */
  'net:relayChanged': { url: string; custom: boolean };

  /* ══ appended (2026-09-11): 사다리 · 깨지는 창 · 옥상 스캐너 ══════════════════════════════════════════ */
  /**
   * Command → player: 로컬 플레이어가 이 사다리에 매달린다. `from` = 어디서 잡았나 (`bottom` 은 발치에서 오르기
   * 시작, `top` 은 꼭대기에서 내려가기 시작). world 의 사다리 `Interactable` 이 낸다 — 사다리 정의를 통째로 싣는다.
   */
  'ladder:grab': { ladder: LadderDef; from: 'bottom' | 'top' };
  /** Fact: 로컬 플레이어가 사다리에 매달렸다(`ladderId`) / 내려왔다(null). */
  'player:climbChanged': { ladderId: string | null };
  /**
   * Fact: 구조물 창문이 깨졌다 (이 클라이언트에서든 와이어로든). `byLocal` = 이 클라이언트가 깼다.
   * world 가 콜라이더를 빼고 유리를 감춘 **뒤에** 낸다.
   */
  'structure:glassBroken': { structureId: string; index: number; position: THREE.Vector3; byLocal: boolean };

  /* ══ appended (2026-09-11): 드론 · 원격 지뢰 · 설치 미리보기 · 네임드 로그 ═════════════════════════════════ */
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

/** One 키 가이드 entry (`ui:keyGuide`): `key` is the display label (`keyLabel(...)`), `label` the Korean action. */
export interface KeyGuideEntry {
  key: string;
  label: string;
  /** 2026-09-09: the key must be **held** (탑승 · 1초 홀드) — the guide draws a downward chevron over the keycap. */
  hold?: boolean;
}
