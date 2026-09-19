import type { GameEventName, PlacedFurniture, WorkbenchKind } from '@/shared';
import { FACILITY_LABEL_KO, STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL, WORKBENCH_LABEL_KO, benchKindOf } from '@/shared';
import { furnitureMaxLevel, generatorRequirement, nextFurnitureCost, stashSizeFor } from '../Rules';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import type { HousingSystem } from '../HousingSystem';

/**
 * **The stash upgrade modal** (2026-09-16, user's decision) — the implementation of `HousingRef.openStorageUpgrade()`.
 *
 * Its callers are **outside housing**: the stash header row of the inventory Tab screen and the workbench window's
 * header row both call this one line from their 「업그레이드」. So it does not assume a furniture screen (`HousingPanel`)
 * is open and mounts the modal `standalone` as a direct child of `ctx.uiRoot` (`UpgradeModalOptions` — `.interactive` ·
 * z above the inventory window · closes itself on Tab too).
 *
 * The look and the rules are **exactly the furniture upgrade's** (user's decision 「reuse the existing modal」): material
 * chips · generator requirement chips · the `UI_HOLD_CONFIRM_S` hold confirm · Enter swallowed · Escape through `ctx.escape`.
 * Only the **content** is decided here.
 *
 * Materials can come and go while it is open (bag ↔ stash moves, a craft on another screen), so it redraws on each of
 * the events below. The subscription is made when it opens and cut in `onClose` — a closed modal must not keep the bus.
 */
const REFRESH_EVENTS: readonly GameEventName[] = [
  'housing:changed', 'housing:facilityUpgraded', 'inventory:changed', 'inventory:stashChanged',
];

/**
 * The **subject** this modal is raising right now (2026-09-16, user's report 「the workbench's upgrade was pressed and
 * the stash window came up」).
 *
 * The subject used to be **nailed** to the one stash facility — so the workbench window's header button, calling that
 * same line (`openStorageUpgrade`), opened the stash window too. Now the subject follows 「what was opened」: a facility
 * (the stash) or **one placed piece of furniture**.
 */
type UpgradeSubject = { kind: 'storage' } | { kind: 'bench'; bench: WorkbenchKind };

/** The stash cell count at this level = `STASH_ROWS_BY_STORAGE_LEVEL[level] × STASH_COLS` (read from the table only — no number is written here). */
function cellsAt(level: number): number {
  const { cols, rows } = stashSizeFor(level);
  return cols * rows;
}

/**
 * The **one placed piece** of that workbench kind — with several it is the **highest level** one, on the same basis as
 * `getBenchLevel` (the recipe gate looks at that one piece, so that is the one to raise). null when there is none.
 */
function benchFurnitureOf(sys: HousingSystem, bench: WorkbenchKind): PlacedFurniture | null {
  let best: PlacedFurniture | null = null;
  for (const f of sys.getPlaced()) {
    const def = sys.getFurnitureDef(f.defId);
    if (!def || benchKindOf(def.interaction) !== bench) continue;
    if (!best || f.level > best.level) best = f;
  }
  return best;
}

export class StorageUpgrade {
  private readonly modal: UpgradeModal;
  private offs: Array<() => void> = [];
  private subject: UpgradeSubject = { kind: 'storage' };

  constructor(private readonly sys: HousingSystem) {
    this.modal = new UpgradeModal(sys.ctx, sys.ctx.uiRoot, sys, {
      standalone: true,
      onClose: () => this.unbind(),
    });
  }

  get isOpen(): boolean { return this.modal.isOpen; }

  /**
   * Pressing the same 「업그레이드」 button again closes it (the button is a toggle). Called again with a **different
   * subject** it swaps to that subject instead of closing — it blocks the accident opposite to the workbench press that
   * put the stash window up.
   */
  toggle(subject: UpgradeSubject = { kind: 'storage' }): void {
    const same = this.subject.kind === subject.kind
      && (subject.kind !== 'bench' || (this.subject as { bench?: WorkbenchKind }).bench === subject.bench);
    this.subject = subject;
    if (this.modal.isOpen) {
      if (same) { this.modal.close(); return; }
      this.modal.refresh();
      return;
    }
    const bus = this.sys.ctx.bus;
    for (const e of REFRESH_EVENTS) this.offs.push(bus.on(e, () => this.modal.refresh()));
    this.modal.open(() => this.spec(), () => this.run());
  }

  close(): void { this.modal.close(); }

  dispose(): void { this.unbind(); this.modal.dispose(); }

  private unbind(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private spec(): UpgradeSpec | null {
    return this.subject.kind === 'bench' ? this.benchSpec(this.subject.bench) : this.storageSpec();
  }

  private run(): void {
    if (this.subject.kind === 'bench') { this.runBench(this.subject.bench); return; }
    this.runStorage();
  }

  /* ── one workbench ──────────────────────────────────────────────────────── */
  private benchSpec(bench: WorkbenchKind): UpgradeSpec | null {
    const f = benchFurnitureOf(this.sys, bench);
    const def = f ? this.sys.getFurnitureDef(f.defId) : undefined;
    // if the furniture is gone (recovered · moved) the modal closes itself (`UpgradeModal.refresh`'s contract)
    if (!f || !def) return null;
    return {
      name: def.name || WORKBENCH_LABEL_KO[bench],
      level: f.level,
      maxLevel: furnitureMaxLevel(def),
      // what the next level opens = more recipes. The count is **counted** from the inventory's recipe list (no table is written here).
      gain: this.benchGain(bench, f.level),
      cost: nextFurnitureCost(def, f.level),
      reason: this.sys.furnitureUpgradeBlock(f.uid),
      requirements: this.sys.furnitureUpgradeRequirements(f.uid),
    };
  }

  /** `제작 n가지 개방` — the next level's recipe count minus this level's. An empty line when there is no inventory. */
  private benchGain(bench: WorkbenchKind, level: number): string {
    const inv = this.sys.ctx.inventory;
    if (!inv || typeof inv.getRecipes !== 'function') return '';
    const now = inv.getRecipes('ship', bench, level).length;
    const next = inv.getRecipes('ship', bench, level + 1).length;
    return next > now ? `제작 ${next - now}가지 개방` : '';
  }

  private runBench(bench: WorkbenchKind): void {
    const f = benchFurnitureOf(this.sys, bench);
    const def = f ? this.sys.getFurnitureDef(f.defId) : undefined;
    if (!f || !def) return;
    const before = f.level;
    if (this.sys.upgradeFurniture(f.uid)) this.sys.notify(`${def.name} Lv.${before + 1}`, 'success');
  }

  /* ── the stash facility ────────────────────────────────────────────────── */
  private storageSpec(): UpgradeSpec | null {
    const info = this.sys.getFacility('storage');
    const atMax = info.level >= info.maxLevel;
    return {
      name: FACILITY_LABEL_KO.storage,
      level: info.level,
      maxLevel: info.maxLevel,
      // what the next level opens = more stash cells. The before / after counts come from the table.
      gain: atMax ? '' : `창고 칸 ${cellsAt(info.level)}칸 → ${cellsAt(info.level + 1)}칸`,
      cost: info.nextCost,
      // `blocked` already answers the generator gate · missing materials as one Korean line (`Rules.facilityBlockReason`).
      // Max level is said by the modal itself as 「최대 레벨입니다」, so it is not repeated here.
      reason: atMax ? null : info.blocked,
      // the same generator requirement chips as the furniture modal — a satisfied requirement shows as `현재/필요` too (the 2026-09-14 contract).
      requirements: atMax ? [] : generatorRequirement(this.sys.state, info.level + 1),
    };
  }

  private runStorage(): void {
    // on success `Rooms.upgrade` fires `housing:stashSizeChanged` and the inventory fits the stash grid to that size.
    if (this.sys.upgrade('storage')) this.sys.notify(`${FACILITY_LABEL_KO.storage}를 업그레이드했습니다`, 'success');
  }
}

/**
 * **The upgrade modal for one workbench** (2026-09-16, the root fix for the user's report) — `HousingRef.openBenchUpgrade(kind)`.
 *
 * This is what the workbench craft window's header button calls. The look · the hold · Escape are the **same modal** as
 * the stash branch; only the content is that piece of furniture.
 */
export function openBenchUpgrade(sys: HousingSystem, bench: WorkbenchKind): void {
  if (!sys.ctx) return;
  if (!benchFurnitureOf(sys, bench)) { sys.notify('배치된 작업대가 없습니다', 'warning'); return; }
  sys.storageUpgrade ??= new StorageUpgrade(sys);
  sys.storageUpgrade.toggle({ kind: 'bench', bench });
}

/**
 * `HousingRef.openStorageUpgrade()` — **the screen that pressed decides the subject** (2026-09-16, user's report
 * 「the upgrade was pressed in the workbench UI and the stash upgrade window came up」).
 *
 * Two places call this one line: the inventory Tab's stash header row · **the workbench window's header row**. The
 * second one means to raise **that workbench**, not the stash, so while the craft column is in bench mode
 * (`InventoryRef.getBench()`) it is sent to that workbench. With the craft column in bench mode the Tab window is in
 * the craft layout (`.inv-layout.is-craft`), where the stash card itself is hidden — so nothing overlaps at this fork.
 * (Once the workbench window calls `openBenchUpgrade(kind)` itself, this branch is simply passed over.)
 */
export function openStorageUpgrade(sys: HousingSystem): void {
  if (!sys.ctx) return;
  const inv = sys.ctx.inventory;
  const bench = inv && typeof inv.getBench === 'function' ? inv.getBench() : null;
  if (bench) { openBenchUpgrade(sys, bench.kind); return; }
  // with only one row in the table there is no level to raise — nothing happens instead of a window opening.
  if (STASH_ROWS_BY_STORAGE_LEVEL.length <= 1 || STASH_COLS <= 0) return;
  sys.storageUpgrade ??= new StorageUpgrade(sys);
  sys.storageUpgrade.toggle({ kind: 'storage' });
}
