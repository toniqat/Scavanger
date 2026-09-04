import * as THREE from 'three';
import { EventBus } from './EventBus';
import { Input } from './Input';
import type {
  GamePhase, WorldRef, PlayerRef, EnemyManagerRef, InventoryRef, LootRef,
  Interactable, InteractableRegistry, MissionStats,
} from './types';

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
  setPhase(phase: GamePhase): void {
    if (phase === this.phase) return;
    const prev = this.phase;
    this.phase = phase;
    this.bus.emit('game:phaseChanged', { phase, prev });
  }
}
