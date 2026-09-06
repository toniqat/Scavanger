import type * as THREE from 'three';
import type { GamePhase, ItemInstance, MissionStats, EnemyType, Stance, HubShipKind, ChatKind, PingKind, WeaponSlot, SocketSlot, StratagemId } from './types';
import type { LobbyErrorCode, LobbyState, PeerId } from './net';
import type { EquipSlot, WeightState } from './gear';
import type { ImplantId, ScanTarget } from './implants';
import type { DeployableKind, GadgetId } from './gadgets';
import type { PlayerProfile, SkillId, StatId } from './progression';
/* appended (2026-09-06): ship housing payloads */
import type { FacilityId, PlacedFurniture, RoomPurpose, ShipState } from './housing';

/**
 * Every cross-module message goes through the typed EventBus with these payloads.
 * Naming: `<domain>:<fact or command>`. Commands are imperative, facts are past tense.
 */
export interface GameEvents {
  /* ── game flow (owner: game/GameFlowSystem) ─────────────────────────── */
  'game:phaseChanged': { phase: GamePhase; prev: GamePhase };
  /** Command: start a fresh mission. World must generate synchronously and then emit world:ready. */
  /** `mode` (appended, Phase 7): `'training'` = 시뮬레이션 훈련장 instead of the planet (default `'raid'`). */
  'game:newMission': { seed: number; mode?: import('./types').MissionMode };
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
  'world:ready': { seed: number; playerSpawn: THREE.Vector3 };
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
  'interact:promptChanged': { text: string | null; holdProgress: number };
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
  'enemy:killed': { id: number; type: EnemyType; position: THREE.Vector3; by?: string | null };
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
  'net:gameStarting': { seed: number; lobby: LobbyState; rejoin?: boolean; mode?: import('./types').MissionMode };
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
  'corpse:spawned': { enemyId: number; type: EnemyType; position: THREE.Vector3 };
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
  'gather:collected': { nodeId: string; defId: string; qty: number };
  'craft:started': { recipeId: string; duration: number };
  'craft:completed': { recipeId: string; item: ItemInstance };
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
