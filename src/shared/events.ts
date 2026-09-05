import type * as THREE from 'three';
import type { GamePhase, ItemInstance, MissionStats, EnemyType, Stance, HubShipKind, ChatKind, PingKind } from './types';
import type { EquipSlot, WeightState } from './gear';
import type { ImplantId, ScanTarget } from './implants';
import type { DeployableKind, GadgetId } from './gadgets';
import type { PlayerProfile, SkillId, StatId } from './progression';
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
  'weapon:equipped': { slot: 'primary' | 'secondary'; weaponId: string; name: string; magSize: number; ammoInMag: number; reserveRounds: number };
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
  /** Command from Inventory → Weapons: loadout changed (equip/unequip). */
  'loadout:changed': { primary: ItemInstance | null; secondary: ItemInstance | null };
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
  'net:remoteGrenade': { id: PeerId; position: THREE.Vector3; velocity: THREE.Vector3 };
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

  /* ══ appended: tactical kit (2026-09-05) ═══════════════════════════════════ */

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
  'player:rolled': { position: THREE.Vector3; direction: THREE.Vector3 };
  /** Downed (multiplayer): revivable with a defibrillator until `bleedout` seconds pass. */
  'player:downed': { position: THREE.Vector3; bleedout: number };
  'player:revived': { by: string | null; hp: number };
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
  'quickbar:changed': { slots: (ItemInstance | null)[] };
  'quickbar:used': { index: number; item: ItemInstance };
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
}

export type GameEventName = keyof GameEvents;
