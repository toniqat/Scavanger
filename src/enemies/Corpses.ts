import * as THREE from 'three';
import { CORPSE_INTERACT_RADIUS, CORPSE_LIFETIME, Random, type EnemyType, type GameContext, type Interactable, type ItemInstance } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Lootable corpses (Phase 4). Every dead enemy registers an `Interactable` `corpse:<enemyId>` for CORPSE_LIFETIME
 * seconds; `interact()` rolls the loot once (`ctx.loot.rollCorpse`, seeded by world seed ^ enemy id so every client
 * rolls the same list) and opens the inventory's container window (`openContainerItems`). `crate:looted` with the
 * corpse id marks it searched (prompt `수색 완료`, no re-open). Corpse contents are per-client, like crates.
 * ──────────────────────────────────────────────────────────────────────────── */

export class Corpse implements Interactable {
  readonly id: string;
  readonly position = new THREE.Vector3();
  readonly radius = CORPSE_INTERACT_RADIUS;
  readonly holdTime = 0.6;
  looted = false;
  life = CORPSE_LIFETIME;
  private items: ItemInstance[] | null = null;

  constructor(private readonly ctx: GameContext, readonly enemyId: number, readonly type: EnemyType, position: THREE.Vector3, readonly weaponId: string | undefined, private readonly seed: number) {
    this.id = `corpse:${enemyId}`;
    this.position.copy(position);
  }

  getPrompt(): string | null {
    if (this.looted) return '수색 완료';
    return '시체 수색';
  }

  canInteract(): boolean {
    const ctx = this.ctx;
    if (this.looted || !ctx.isGameplayActive()) return false;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return false;
    return !!ctx.inventory && typeof ctx.inventory.openContainerItems === 'function';
  }

  interact(): void {
    const ctx = this.ctx;
    const inv = ctx.inventory;
    if (this.looted || !inv || typeof inv.openContainerItems !== 'function') return;
    if (!this.items) {
      const rng = new Random(((this.seed ^ (this.enemyId * 2654435761)) >>> 0) || 1);
      this.items = ctx.loot && typeof ctx.loot.rollCorpse === 'function' ? ctx.loot.rollCorpse(this.type, rng, this.weaponId) : [];
    }
    inv.openContainerItems(this.id, this.items, this.position, '시체');
    if (this.items.length === 0) this.looted = true;   // nothing to take: searched
  }
}

export class CorpseManager {
  private readonly corpses = new Map<number, Corpse>();
  private ctx: GameContext | null = null;

  bind(ctx: GameContext): void { this.ctx = ctx; }

  get count(): number { return this.corpses.size; }
  get(enemyId: number): Corpse | undefined { return this.corpses.get(enemyId); }
  all(): IterableIterator<Corpse> { return this.corpses.values(); }

  /** Register (or refresh) the corpse of `enemyId`. Emits `corpse:spawned`. */
  add(enemyId: number, type: EnemyType, position: THREE.Vector3, weaponId: string | undefined, seed: number): Corpse | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const prev = this.corpses.get(enemyId);
    if (prev) this.remove(enemyId);
    const c = new Corpse(ctx, enemyId, type, position, weaponId, seed);
    this.corpses.set(enemyId, c);
    ctx.interactables.register(c);
    ctx.bus.emit('corpse:spawned', { enemyId, type, position: c.position });
    return c;
  }

  /** Unregister. Emits `corpse:removed`. Returns false when unknown. */
  remove(enemyId: number): boolean {
    const c = this.corpses.get(enemyId);
    if (!c || !this.ctx) return false;
    this.corpses.delete(enemyId);
    this.ctx.interactables.unregister(c.id);
    this.ctx.bus.emit('corpse:removed', { enemyId });
    return true;
  }

  /** `crate:looted { crateId }` → a corpse container was emptied. */
  markLooted(containerId: string): void {
    if (!containerId.startsWith('corpse:')) return;
    const id = Number(containerId.slice(7));
    const c = this.corpses.get(id);
    if (c) c.looted = true;
  }

  /** Own lifetime (the enemy entity normally despawns first and removes the corpse; this is the safety net). */
  update(dt: number): void {
    for (const c of this.corpses.values()) {
      c.life -= dt;
      if (c.life <= 0) this.remove(c.enemyId);
    }
  }

  clear(): void {
    if (this.ctx) for (const c of this.corpses.values()) { this.ctx.interactables.unregister(c.id); this.ctx.bus.emit('corpse:removed', { enemyId: c.enemyId }); }
    this.corpses.clear();
  }
}
