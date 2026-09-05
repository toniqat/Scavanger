import type * as THREE from 'three';
import type { GamePhase, ItemInstance, MissionStats, EnemyType, Stance } from './types';
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
  'ping:placed': { id: number; position: THREE.Vector3; kind: 'ground' | 'enemy' | 'crate' | 'extraction'; expires: number };
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
  'net:remotePing': { id: PeerId; position: THREE.Vector3; kind: 'ground' | 'enemy' | 'crate' | 'extraction' };
  'net:chat': { id: PeerId; name: string; text: string };
  /** Command (ui → ui): open/close the multiplayer lobby screen. Owner: ui/menus/LobbyMenu. */
  'ui:lobbyToggled': { open: boolean };
}

export type GameEventName = keyof GameEvents;
