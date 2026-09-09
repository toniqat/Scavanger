import * as THREE from 'three';
import {
  CORPSE_INTERACT_RADIUS, CORPSE_LIFETIME, CORPSE_LOOT_CHANCE, Random,
  type EnemyDeathDir, type EnemyType, type GameContext, type Interactable, type ItemInstance,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Lootable corpses (Phase 4). A dead enemy whose corpse *rolled searchable* registers an `Interactable`
 * `corpse:<enemyId>` for CORPSE_LIFETIME seconds; `interact()` rolls the loot once (`ctx.loot.rollCorpse`, seeded by
 * world seed ^ enemy id so every client rolls the same list) and opens the inventory's container window
 * (`openContainerItems`). `crate:looted` with the corpse id marks it searched (prompt `수색 완료`, no re-open).
 * Corpse contents are per-client, like crates.
 *
 * Phase 10 — **probabilistic looting**: `CORPSE_LOOT_CHANCE[type]` (trash bug 0.1 / 상위 버그 0.35 / boss + rogue 1)
 * decides whether a body can be searched at all. The roll runs on its own seeded stream (`rollCorpseLootable`), never
 * on the `rng` that feeds `rollCorpse` — `src/inventory/__selftest__.ts` asserts exact `rollCorpse` output for
 * `warrior` / `rogue` / `rogue_boss` at seeds 5 / 11 / 3, so any shift of that stream would break it. A body that
 * fails the roll simply gets no interactable; the corpse mesh stays in the world as before.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Host authority for a corpse mirrored over `ee corpse` (`lt` → lootable, `dd` → fall direction). */
export interface CorpseWireOpts {
  /** undefined = decide locally from the seeded stream (same result); the wire value always wins when present. */
  lootable?: boolean | undefined;
  deathDir?: EnemyDeathDir | undefined;
}

/**
 * Can this body be searched? Independent seeded stream (`worldSeed ^ (enemyId * 0x9e3779b1)`) so host and every
 * replica agree without a wire field and the `rollCorpse` stream stays byte-identical to Phase 9.
 */
export function rollCorpseLootable(seed: number, enemyId: number, type: EnemyType): boolean {
  const chance = CORPSE_LOOT_CHANCE[type] ?? 1;
  if (chance >= 1) return true;
  if (chance <= 0) return false;
  return new Random(((seed ^ (enemyId * 0x9e3779b1)) >>> 0) || 1).chance(chance);
}

export class Corpse implements Interactable {
  readonly id: string;
  readonly position = new THREE.Vector3();
  readonly radius = CORPSE_INTERACT_RADIUS;
  readonly holdTime = 0.6;
  looted = false;
  /**
   * 2026-09-08: this client has opened the body at least once → `ui/hud/Detection` stops drawing its 빛기둥 while the
   * corpse stays searchable (there may be loot left). Deliberately **not** synced: another player looting the same
   * body leaves our pillar up, and ours never clears theirs.
   */
  hidePillar = false;
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
      // 2026-09-09: 행성의 등급 상한을 적용한다 (`rollCorpseOn`; 행성이 null 이면 `rollCorpse` 와 완전히 같다).
      this.items = ctx.loot && typeof ctx.loot.rollCorpseOn === 'function' ? ctx.loot.rollCorpseOn(this.type, rng, this.weaponId, ctx.missionPlanet) : [];
    }
    this.hidePillar = true;
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

  /**
   * Register (or refresh) the corpse of `enemyId`. Emits `corpse:spawned` either way — Phase 10: a body that fails the
   * `CORPSE_LOOT_CHANCE` roll gets **no interactable** and the event carries `lootable: false`, so a listener can tell
   * "there is a body here" from "there is loot here". `opts` lets the host's `ee corpse` override the local roll.
   */
  add(enemyId: number, type: EnemyType, position: THREE.Vector3, weaponId: string | undefined, seed: number, opts?: CorpseWireOpts): Corpse | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const prev = this.corpses.get(enemyId);
    if (prev) this.remove(enemyId);
    const lootable = opts?.lootable ?? rollCorpseLootable(seed, enemyId, type);
    const deathDir = opts?.deathDir;
    if (!lootable) {
      ctx.bus.emit('corpse:spawned', { enemyId, type, position: position.clone(), lootable: false, deathDir });
      return null;
    }
    const c = new Corpse(ctx, enemyId, type, position, weaponId, seed);
    this.corpses.set(enemyId, c);
    ctx.interactables.register(c);
    ctx.bus.emit('corpse:spawned', { enemyId, type, position: c.position, lootable: true, deathDir });
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
