import type { GameEventName, PlacedFurniture, WorkbenchKind } from '@/shared';
import { FACILITY_LABEL_KO, STASH_COLS, STASH_ROWS_BY_STORAGE_LEVEL, WORKBENCH_LABEL_KO, benchKindOf } from '@/shared';
import { furnitureMaxLevel, generatorRequirement, nextFurnitureCost, stashSizeFor } from '../Rules';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import type { HousingSystem } from '../HousingSystem';

/**
 * **창고 업그레이드 모달** (2026-09-16, 사용자 결정) — `HousingRef.openStorageUpgrade()` 의 구현.
 *
 * 부르는 곳이 **하우징 밖**이다: 인벤토리 Tab 화면의 창고 머리줄과 작업대 창의 머리줄이 「업그레이드」 한 줄로 이것만
 * 부른다. 그래서 가구 화면(`HousingPanel`)이 열려 있다고 가정하지 않고, 모달을 `ctx.uiRoot` 직계에 `standalone` 으로
 * 붙인다 (`UpgradeModalOptions` — `.interactive` · 인벤토리 창 위 z · Tab 도 스스로 닫기).
 *
 * 모양과 규칙은 **가구 업그레이드와 완전히 같다** (사용자 결정 「기존 모달을 재사용한다」): 재료 칩 · 발전기 요구 칩 ·
 * `UI_HOLD_CONFIRM_S` 홀드 확정 · Enter 삼킴 · Escape 는 `ctx.escape`. 여기서 정하는 것은 **내용**뿐이다.
 *
 * 열려 있는 동안 재료가 오갈 수 있으므로(가방 ↔ 창고 이동, 다른 화면에서의 제작) 아래 사건마다 다시 그린다. 구독은
 * 여는 순간 걸고 `onClose` 에서 끊는다 — 닫힌 모달이 버스를 계속 붙들지 않게.
 */
const REFRESH_EVENTS: readonly GameEventName[] = [
  'housing:changed', 'housing:facilityUpgraded', 'inventory:changed', 'inventory:stashChanged',
];

/**
 * 이 모달이 지금 올리고 있는 **대상** (2026-09-16, 사용자 보고 「작업대의 업그레이드를 눌렀는데 창고 창이 떴다」).
 *
 * 예전에는 대상이 창고 시설 하나로 **박혀** 있었다 — 그래서 같은 한 줄(`openStorageUpgrade`)을 부르는 작업대 창의
 * 머리 버튼도 창고 창을 열었다. 이제 대상은 「무엇을 열었는가」로 정해진다: 시설(창고) 또는 **배치된 가구 한 대**.
 */
type UpgradeSubject = { kind: 'storage' } | { kind: 'bench'; bench: WorkbenchKind };

/** 이 레벨의 창고 칸 수 = `STASH_ROWS_BY_STORAGE_LEVEL[level] × STASH_COLS` (표에서만 읽는다 — 수를 적지 않는다). */
function cellsAt(level: number): number {
  const { cols, rows } = stashSizeFor(level);
  return cols * rows;
}

/**
 * 그 작업대 kind 의 **배치된 가구 한 대** — 여러 대면 `getBenchLevel` 과 같은 기준으로 **가장 높은 레벨**이다
 * (레시피 게이트가 보는 것이 그 한 대이므로 올릴 것도 그 한 대다). 없으면 null.
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
   * 같은 「업그레이드」 버튼을 또 누르면 닫힌다 (버튼이 토글이다). **다른 대상**으로 다시 부르면 닫지 않고
   * 그 대상으로 갈아 끼운다 — 작업대 창에서 눌렀는데 창고 창이 떠 있던 것과 반대의 사고를 막는다.
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

  /* ── 작업대 한 대 ───────────────────────────────────────────────────────── */
  private benchSpec(bench: WorkbenchKind): UpgradeSpec | null {
    const f = benchFurnitureOf(this.sys, bench);
    const def = f ? this.sys.getFurnitureDef(f.defId) : undefined;
    // 가구가 사라졌으면(회수 · 이동) 모달이 스스로 닫힌다 (`UpgradeModal.refresh` 의 규약)
    if (!f || !def) return null;
    return {
      name: def.name || WORKBENCH_LABEL_KO[bench],
      level: f.level,
      maxLevel: furnitureMaxLevel(def),
      // 다음 레벨이 여는 것 = 늘어나는 레시피. 수는 인벤토리의 레시피 목록에서 **센다** (여기에 표를 적지 않는다).
      gain: this.benchGain(bench, f.level),
      cost: nextFurnitureCost(def, f.level),
      reason: this.sys.furnitureUpgradeBlock(f.uid),
      requirements: this.sys.furnitureUpgradeRequirements(f.uid),
    };
  }

  /** `제작 n가지 개방` — 다음 레벨의 레시피 수에서 지금 레벨의 것을 뺀다. 인벤토리가 없으면 빈 줄이다. */
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

  /* ── 창고 시설 ─────────────────────────────────────────────────────────── */
  private storageSpec(): UpgradeSpec | null {
    const info = this.sys.getFacility('storage');
    const atMax = info.level >= info.maxLevel;
    return {
      name: FACILITY_LABEL_KO.storage,
      level: info.level,
      maxLevel: info.maxLevel,
      // 다음 레벨이 여는 것 = 늘어나는 창고 칸. 앞뒤 칸 수는 표에서 센다.
      gain: atMax ? '' : `창고 칸 ${cellsAt(info.level)}칸 → ${cellsAt(info.level + 1)}칸`,
      cost: info.nextCost,
      // `blocked` 가 발전기 게이트 · 재료 부족을 이미 한국어 한 줄로 답한다 (`Rules.facilityBlockReason`).
      // 최대 레벨은 모달이 스스로 「최대 레벨입니다」로 말하므로 여기서 겹쳐 적지 않는다.
      reason: atMax ? null : info.blocked,
      // 가구 모달과 같은 발전기 요구 칩 — 채워진 요구도 `현재/필요` 로 보여 준다 (2026-09-14 규약).
      requirements: atMax ? [] : generatorRequirement(this.sys.state, info.level + 1),
    };
  }

  private runStorage(): void {
    // 성공하면 `Rooms.upgrade` 가 `housing:stashSizeChanged` 를 쏘고 inventory 가 창고 격자를 그 크기로 맞춘다.
    if (this.sys.upgrade('storage')) this.sys.notify(`${FACILITY_LABEL_KO.storage}를 업그레이드했습니다`, 'success');
  }
}

/**
 * **작업대 한 대의 업그레이드 모달** (2026-09-16, 사용자 보고의 근본 고침) — `HousingRef.openBenchUpgrade(kind)`.
 *
 * 작업대 제작 창의 머리 버튼이 부를 자리다. 모양 · 홀드 · Escape 는 창고 갈래와 **같은 모달**이고 내용만 그 가구다.
 */
export function openBenchUpgrade(sys: HousingSystem, bench: WorkbenchKind): void {
  if (!sys.ctx) return;
  if (!benchFurnitureOf(sys, bench)) { sys.notify('배치된 작업대가 없습니다', 'warning'); return; }
  sys.storageUpgrade ??= new StorageUpgrade(sys);
  sys.storageUpgrade.toggle({ kind: 'bench', bench });
}

/**
 * `HousingRef.openStorageUpgrade()` — **누른 화면이 대상을 정한다** (2026-09-16, 사용자 보고
 * 「작업대 UI 에서 업그레이드를 눌렀는데 창고 업그레이드 창이 뜬다」).
 *
 * 이 한 줄을 부르는 곳이 둘이다: 인벤토리 Tab 창고 머리줄 · **작업대 창 머리줄**. 두 번째는 창고가 아니라 **그
 * 작업대**를 올리려는 것이므로, 제작 열이 작업대 모드일 때(`InventoryRef.getBench()`)는 그 작업대로 보낸다.
 * 제작 열이 작업대 모드이면 Tab 창은 제작 배치(`.inv-layout.is-craft`)라 창고 카드 자체가 숨어 있다 — 즉 이
 * 갈림길에 겹치는 경우가 없다. (작업대 창이 직접 `openBenchUpgrade(kind)` 를 부르게 되면 이 갈래는 그냥 지나간다.)
 */
export function openStorageUpgrade(sys: HousingSystem): void {
  if (!sys.ctx) return;
  const inv = sys.ctx.inventory;
  const bench = inv && typeof inv.getBench === 'function' ? inv.getBench() : null;
  if (bench) { openBenchUpgrade(sys, bench.kind); return; }
  // 표가 한 줄뿐이면 올릴 레벨이 없다 — 창을 띄우는 대신 아무 일도 하지 않는다.
  if (STASH_ROWS_BY_STORAGE_LEVEL.length <= 1 || STASH_COLS <= 0) return;
  sys.storageUpgrade ??= new StorageUpgrade(sys);
  sys.storageUpgrade.toggle({ kind: 'storage' });
}
