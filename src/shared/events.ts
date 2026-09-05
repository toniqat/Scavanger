import type * as THREE from 'three';
import type { GamePhase, ItemInstance, MissionStats, EnemyType, Stance, HubShipKind, ChatKind, PingKind, WeaponSlot, SocketSlot, StratagemId } from './types';
import type { LobbyErrorCode, LobbyState, PeerId } from './net';

/**
 * Every cross-module message goes through the typed EventBus with these payloads.
 * Naming: `<domain>:<fact or command>`. Commands are imperative, facts are past tense.
 */
export interface GameEvents {
  /* ── game flow (owner: game/GameFlowSystem) ─────────────────────────── */
  'game:phaseChanged': { phase: GamePhase; prev: GamePhase };
  /** Command: start a fresh mission. World must generate synchronously and then emit world:ready. */
  'game:newMission': { seed: number };
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
  'loadout:changed': { primary: ItemInstance | null; secondary: ItemInstance | null; primary2: ItemInstance | null; bag: ItemInstance | null };
  /** Active weapon's ADS zoom changed (equip/swap). HUD shows the scope overlay while aiming when `scope` is true. */
  'weapon:scopeChanged': { zoom: number; scope: boolean };

  /* ── enemies (owner: enemies/EnemySystem) ───────────────────────────── */
  'enemy:spawned': { id: number; type: EnemyType; position: THREE.Vector3 };
  'enemy:damaged': { id: number; type: EnemyType; amount: number; position: THREE.Vector3; hp: number };
  'enemy:killed': { id: number; type: EnemyType; position: THREE.Vector3 };
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
  'net:gameStarting': { seed: number; lobby: LobbyState };
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
}

export type GameEventName = keyof GameEvents;
