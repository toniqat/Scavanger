import * as THREE from 'three';
import {
  CORPSE_INTERACT_RADIUS, CORPSE_LIFETIME, CORPSE_LOOT_CHANCE, Random, corpseLootRandom,
  type CorpseLootOpts, type EnemyDeathDir, type EnemyType, type GameContext, type Interactable, type InteractableKind, type ItemInstance,
} from '@/shared';
/* appended (2026-09-12): 아이템 회수 계약 — 레이드 루팅 표식 */
import { markRaidFound, raidFoundSeed } from '@/shared';

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
  /** 2026-09-13: 전리품 입력 (스폰 거점 · 남은 수류탄) — 호스트는 `Enemy` 에서, 리플리카는 `ee corpse.si/gc/gk` 에서. */
  loot?: CorpseLootOpts | undefined;
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
  /** 2026-09-11 (C-4): `Interactable.kind` — readers (빛기둥 · 정찰 스캔) no longer guess from the `corpse:` prefix. */
  readonly kind: InteractableKind = 'corpse';
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
  /** 2026-09-17: 몸이 땅으로 가라앉는 중 — 상호작용 불가 (`EnemySystem.update` 가 매 프레임 `anim.fade` 로 세운다). */
  sinking = false;
  private items: ItemInstance[] | null = null;

  /**
   * `lootOpts` (2026-09-13): 스폰 거점 · 남은 수류탄 — `rollCorpseOn` 의 부가 인자. 지상 드론 스캔 미리보기
   * (`gadgets/drones/parts/Scan`)가 같은 값으로 굴리므로 공개 필드다.
   */
  constructor(private readonly ctx: GameContext, readonly enemyId: number, readonly type: EnemyType, position: THREE.Vector3, readonly weaponId: string | undefined, private readonly seed: number, readonly lootOpts: CorpseLootOpts | null = null) {
    this.id = `corpse:${enemyId}`;
    this.position.copy(position);
  }

  getPrompt(): string | null {
    if (this.looted) return '수색 완료';
    return '시체 수색';
  }

  canInteract(): boolean {
    const ctx = this.ctx;
    if (this.looted || this.sinking || !ctx.isGameplayActive()) return false;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return false;
    return !!ctx.inventory && typeof ctx.inventory.openContainerItems === 'function';
  }

  interact(): void {
    const ctx = this.ctx;
    const inv = ctx.inventory;
    if (this.looted || !inv || typeof inv.openContainerItems !== 'function') return;
    if (!this.items) {
      // 2026-09-12: 시드 식은 `shared/lootRolls` 한 곳 — 지상 드론 스캔(`gadgets/drones/parts/Scan`)이 같은 식으로 미리 굴린다
      const rng = corpseLootRandom(this.seed, this.enemyId);
      // 2026-09-09: 행성의 등급 상한을 적용한다 (`rollCorpseOn`; 행성이 null 이면 `rollCorpse` 와 완전히 같다).
      this.items = ctx.loot && typeof ctx.loot.rollCorpseOn === 'function' ? ctx.loot.rollCorpseOn(this.type, rng, this.weaponId, ctx.missionPlanet, this.lootOpts ?? undefined) : [];
      // 2026-09-12: raid loot (named drops included) carries the raid-found mark — null outside a real raid (훈련장)
      markRaidFound(this.items, raidFoundSeed(ctx));
    }
    this.hidePillar = true;
    inv.openContainerItems(this.id, this.items, this.position, '시체');
    if (this.items.length === 0) this.looted = true;   // nothing to take: searched
  }
}

export class CorpseManager {
  private readonly corpses = new Map<number, Corpse>();
  private ctx: GameContext | null = null;
  /**
   * 2026-09-14 4차 — 이번 레이드가 시체를 붙잡아 두는 시간(초). 평소는 `CORPSE_LIFETIME`,
   * **튜토리얼 레이드는 `Infinity`** (`EnemySystem.corpseLifetime` 이 `world:ready` 에서 넣는다).
   * 튜토리얼에서 45초는 「수치가 너무 짧다」가 아니라 **규칙이 다른 것**이다 — 가르치려고 놓아 둔 고정 드롭
   * 두 구는 플레이어가 목표 패널을 읽으며 걸어가는 동안 사라지면 안 되므로, 플레이어 시체(`ctx.corpses`)와
   * 같이 **레이드가 끝날 때까지** 남는다. 그래서 새 수치를 만들지 않았다.
   */
  lifetime = CORPSE_LIFETIME;

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
    const c = new Corpse(ctx, enemyId, type, position, weaponId, seed, opts?.loot ?? null);
    c.life = this.lifetime;
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
