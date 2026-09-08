import * as THREE from 'three';
import { EventBus } from './EventBus';
import { Input } from './Input';
import type {
  GamePhase, WorldRef, PlayerRef, EnemyManagerRef, InventoryRef, LootRef,
  Interactable, InteractableRegistry, MissionStats, HubRef, PickupsRef, WeaponsRef, StratagemsRef,
} from './types';
import type { NetRef } from './net';
import type { MissionMode } from './types';
/* appended (Phase 11, 2026-09-07): 행성 선택 */
import type { PlanetId } from './planets';
import type { ImplantsRef } from './implants';
import type { GadgetsRef } from './gadgets';
import type { ProgressionRef } from './progression';
import type { ConsoleRef } from './console';
import type { AudioRef } from './types';
import type { HousingRef } from './housing';
import type { MetaRef } from './meta';
/* appended (2026-09-08): 튜토리얼 */
import type { TutorialRef } from './tutorial';

class InteractableRegistryImpl implements InteractableRegistry {
  private items = new Map<string, Interactable>();
  register(i: Interactable): void { this.items.set(i.id, i); }
  unregister(id: string): void { this.items.delete(id); }
  clear(): void { this.items.clear(); }
  all(): readonly Interactable[] { return Array.from(this.items.values()); }
  findBest(pos: THREE.Vector3, forward?: THREE.Vector3): Interactable | null {
    let best: Interactable | null = null;
    let bestScore = Infinity;
    const d = new THREE.Vector3();
    for (const it of this.items.values()) {
      if (!it.canInteract()) continue;
      d.subVectors(it.position, pos);
      const dist = d.length();
      if (dist > it.radius) continue;
      let score = dist;
      if (forward && dist > 0.01) {
        d.y = 0; d.normalize();
        const facing = d.dot(forward); // 1 = directly ahead
        score += (1 - facing) * 1.5;
      }
      if (score < bestScore) { bestScore = score; best = it; }
    }
    return best;
  }
}

/**
 * Single shared context passed to every system. Systems publish their public ref
 * (ctx.world, ctx.player, …) during init() and other systems read them lazily at update time.
 */
export class GameContext {
  readonly bus = new EventBus();
  readonly input = new Input();
  readonly interactables: InteractableRegistry = new InteractableRegistryImpl();

  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** DOM root for all HTML UI (HUD, inventory, menus). Systems append their own containers. */
  readonly uiRoot: HTMLElement;

  world: WorldRef | null = null;
  player: PlayerRef | null = null;
  enemies: EnemyManagerRef | null = null;
  inventory: InventoryRef | null = null;
  loot: LootRef | null = null;
  /** Multiplayer (appended). null until NetSystem publishes it; single-player behaviour when null or `!inSession`. */
  net: NetRef | null = null;
  /** Ship hub (appended). Published by hub/HubSystem. */
  hub: HubRef | null = null;
  /** World pickups (appended). Published by pickups/PickupSystem. */
  pickups: PickupsRef | null = null;
  /** Live grenades etc. (Phase 3). Published by weapons/WeaponSystem. */
  weapons: WeaponsRef | null = null;
  /** Ship calls (Phase 3). Published by stratagems/StratagemSystem. */
  stratagems: StratagemsRef | null = null;
  /* ── appended: tactical kit ── */
  /** Tactical implants. Published by implants/ImplantSystem. */
  implants: ImplantsRef | null = null;
  /** Gadget deployables. Published by gadgets/GadgetSystem. */
  gadgets: GadgetsRef | null = null;
  /** Character stats / skills / persistent profile. Published by progression/ProgressionSystem. */
  progression: ProgressionRef | null = null;
  /* ── appended (2026-09-06) ── */
  /** Developer console (dev clients only; `enabled` false elsewhere). Published by console/ConsoleSystem. */
  console: ConsoleRef | null = null;
  /** Ship housing (rooms, facilities, furniture, presets). Published by housing/HousingSystem. */
  housing: HousingRef | null = null;
  /* ── appended: Phase 5 (2026-09-06) ── */
  /** Corporations / credits / contracts / quests. Published by meta/MetaSystem. */
  meta: MetaRef | null = null;

  /* appended (2026-09-08) */
  /** 튜토리얼 (새 프로필 안내). Published by tutorial/TutorialSystem; null while it is not registered. */
  tutorial: TutorialRef | null = null;
  /* ── appended: Phase 7 (2026-09-06) ── */
  /** Mode of the running / last mission (`game/` sets it from `game:newMission.mode` before the world generates). */
  missionMode: MissionMode = 'raid';
  /**
   * true between a rejoin's `game:newMission` and the `ghost restore` (or its timeout): the player must not hellpod-drop on
   * `world:ready`; game/ clears it after `restoreState` / the fallback respawn.
   */
  rejoinPending = false;
  /* ── appended: Phase 11 (2026-09-07) ── */
  /**
   * 목표 행성 of the running / last raid, or null when the mission was generated the old way (no planet: a seeded
   * biome + a seeded sky). Set by the **emitter** of `game:newMission` before it emits, exactly like `missionMode`,
   * so `world/` and `core/` can read it inside their synchronous handlers. A training always sets it to null.
   */
  missionPlanet: PlanetId | null = null;
  /* ── appended: Phase 8 (2026-09-06) ── */
  /** Volume settings (전체 / 효과음) for the 설정 menu. Published by audio/AudioSystem. */
  audio: AudioRef | null = null;

  /** True when this client simulates authoritative gameplay (enemies, extraction): single-player or lobby host. */
  get isAuthority(): boolean { return this.net?.isAuthority ?? true; }
  /** True while a multiplayer session (lobby started) is running. */
  get isMultiplayer(): boolean { return this.net?.inSession ?? false; }

  phase: GamePhase = 'menu';
  /** Seconds since mission start (only advances in gameplay phases). */
  missionTime = 0;
  /** Unscaled seconds since app start. */
  time = 0;
  timeScale = 1;
  stats: MissionStats = GameContext.freshStats(0);

  /** Any system that needs gameplay input blocked adds a token here (e.g. 'inventory', 'menu'). */
  readonly uiBlockers = new Set<string>();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
  }

  static freshStats(seed: number): MissionStats {
    return { seed, kills: 0, cratesOpened: 0, damageTaken: 0, timeSeconds: 0, lootValue: 0, extracted: false };
  }

  /** True when the player may move/shoot: gameplay phase and no UI blocker active. */
  isGameplayActive(): boolean {
    return this.isGameplayPhase() && this.uiBlockers.size === 0;
  }
  isGameplayPhase(): boolean {
    return this.phase === 'playing' || this.phase === 'extracting' || this.phase === 'shipLanded' || this.phase === 'liftoff';
  }
  /* ── appended: ship hub ── */
  /** Walking around a ship (personal or shared). Not a gameplay phase: no weapons, enemies, pings or map. */
  isHubPhase(): boolean {
    return this.phase === 'hub';
  }
  /**
   * True when the player may move / interact: gameplay phase OR hub phase, and no UI blocker active.
   * Movement, stances, interaction and the camera use this; shooting, pings, map, grenades keep `isGameplayActive()`.
   */
  isControlActive(): boolean {
    return (this.isGameplayPhase() || this.phase === 'hub') && this.uiBlockers.size === 0;
  }
  /* ── appended: tactical kit ── */
  /**
   * True while the player is on a mission (not in the ship / menus). Gear that may only change in the ship
   * (implant loadout, stat points, repairs) checks `!isRaidActive()`.
   */
  isRaidActive(): boolean {
    return this.isGameplayPhase() || this.phase === 'deploying';
  }
  /* ── appended: Phase 7 ── */
  /** true while a 시뮬레이션 훈련장 (not a raid) is the active mission. */
  isTraining(): boolean {
    return this.missionMode === 'training' && (this.isGameplayPhase() || this.phase === 'deploying');
  }
  setPhase(phase: GamePhase): void {
    if (phase === this.phase) return;
    const prev = this.phase;
    this.phase = phase;
    this.bus.emit('game:phaseChanged', { phase, prev });
  }
}
