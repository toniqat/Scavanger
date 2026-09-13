import type { CraftRecipe, ItemDef, RoomPurpose, WorkbenchKind } from '@/shared';
import { FURNITURE_DEFS, WORKBENCH_ICON, WORKBENCH_KINDS, WORKBENCH_LABEL_KO, benchKindOf, renderItemCost } from '@/shared';
import type { BenchRecipeRow, InventorySystem } from '../InventorySystem';
import { buildTileContent, favoritesRevision } from './GridView';
import { CELL, TEXT } from './labels';

/**
 * 왼쪽 작업대 리스트의 한 칸 (2026-09-12). `null` = **빠른제작**(작업대 없이 되는 것), 나머지는 이 함선에
 * 실제로 설치된 `WorkbenchKind` 다.
 */
type BenchPick = WorkbenchKind | null;

/** 이 레시피가 「빠른제작」인가 — `station: 'field'` 면 작업대가 없어도 만들 수 있다. */
/* 현장 레시피는 자기 작업대 태그가 있어도 빠른제작이다 — 그 목록의 뜻이 "작업대 없이도 되는 것" 이다.
 * (2026-09-10 부터 탄약 · 붕대 · 연막에도 `bench` 가 붙었다. 그것은 작업대 창에 뜨라는 표시일 뿐이다.) */
const isFieldRecipe = (r: CraftRecipe): boolean => r.station === 'field';

/**
 * **작업대가 속한 시설** (2026-09-13, 사용자 결정). 원본은 `data/furniture.csv` 의 `room` 열이다 — 인터랙션이
 * `workbench_<kind>` 인 가구(`benchKindOf`)의 방 용도를 그대로 읽는다. 여기에 두 번째 표를 적지 않는다:
 * 작업대를 다른 방으로 옮기려면 csv 한 칸만 고치면 된다. 은퇴 가구 · `any` 는 건너뛰고, 모르는 kind 는 작업실이다.
 */
const BENCH_FACILITY: ReadonlyMap<WorkbenchKind, RoomPurpose> = (() => {
  const m = new Map<WorkbenchKind, RoomPurpose>();
  for (const d of FURNITURE_DEFS) {
    if (d.retired || d.room === 'any') continue;
    const kind = benchKindOf(d.interaction);
    if (kind && !m.has(kind)) m.set(kind, d.room);
  }
  return m;
})();

/** 이 작업대(`null` = 빠른제작)가 속한 시설. 빠른제작은 작업실 소속이다 (사용자 결정). */
export function benchFacility(kind: WorkbenchKind | null): RoomPurpose {
  return kind ? BENCH_FACILITY.get(kind) ?? 'workshop' : 'workshop';
}

interface RowView {
  recipe: CraftRecipe;
  locked: boolean;
  el: HTMLElement;
  /** Host of the `renderItemCost` chips (Phase 8) — the time chip is its sibling. */
  costsEl: HTMLElement;
  inputsEl: HTMLElement;
  button: HTMLButtonElement;
  fill: HTMLElement;
  /* 2026-09-09 (제작 수량) */
  /** Runs of the recipe one hold buys (≥ 1). Reset to 1 whenever the row list is rebuilt. */
  count: number;
  /** `산출물 이름 ×n` — repainted when the count changes. */
  nameEl: HTMLElement;
  /** The `◀ n ▶` readout in the middle of the stepper. */
  countEl: HTMLElement;
  lessBtn: HTMLButtonElement;
  moreBtn: HTMLButtonElement;
}

/**
 * Crafting panel (인벤토리 안의 `제작` 버튼, or a 작업실 bench through `InventoryRef.openBenchCraft`).
 *
 * **Phase 8**: the panel is no longer a column of `.inv-layout` — `InventoryUI` adopts `el` into a `Modeless`
 * frame that floats above the window while the grid stays interactive behind it. Only the shell and the material
 * readout changed: costs are `renderItemCost` item chips (`@/shared`) instead of text chips, the 닫기 button is
 * always visible (bench mode leaves the bench, otherwise it closes the popup through `onClose`), and the
 * `break_*` 분해 rows are gone from the list — 분해 lives in the item context menu now (`DisassemblePanel`).
 *
 * Normal mode: recipes filtered by station (`field` on a mission, `ship` in the hub) and by the crafting /
 * medicine / gardening skill. **Bench mode** (Phase 6, `sys.getBench()` set): title `WORKBENCH_LABEL_KO[kind] Lv.n`,
 * recipes from `getRecipes('ship', kind, level)` plus **locked rows** for recipes of that bench above its level, and
 * material costs scaled by the workshop discount (`sys.craftCost`).
 * Crafting is *hold to craft*: pressing the button starts `InventorySystem.craft()` and releasing before it
 * finishes cancels it, exactly like a world hold-interaction.
 *
 * **2026-09-08 (제작 UI 정리)** — three cuts, all the same complaint: this panel is for *making things*.
 *  - The hold is `CRAFT_HOLD_TIME` (1 s) for **every** recipe and the `2.0 s` 시간 칩 is gone. The press is a grace
 *    period before the materials are spent, not a simulation of work — a 돌격소총 was a 6-second press before.
 *  - The **수리 목록 underneath is gone**. `모두 수리` moved into the header (left of 닫기) and opens the modal
 *    `RepairPanel`; a single item is repaired from its right-click menu.
 *  - While the panel is open the window hides 장착 장비 · 퀵슬롯 · 화면 탭 · 가방 헤더의 제작/가치
 *    (`.inv-root.is-craft`, see `parts/Screens.setCraftOpen`) — none of it has anything to do with a recipe list.
 *
 * **2026-09-09 (제작 UI 2차)** — the row is about the **thing being made**, not about the recipe:
 *  - The output is drawn as the inventory tile it will become (`buildTileContent` at the grid's own `CELL`), always
 *    **1×1** — see the 2026-09-09 note at the call site. The thumbnail carries
 *    `data-item-tip` + `data-def-id`, the hook `ui/hud/ItemTip` delegates on — hovering it shows the usual item card.
 *  - The title is `산출물 이름 ×n` where `n` is what **one** craft makes (`준중량탄 ×90`) — it never moves; the
 *    recipe's own name and its description line are **gone**.
 *  - The hold button is **locked when the output has nowhere to go** (2026-09-09), not only when materials are
 *    short: `InventorySystem.craftHasRoom(id, n)` is asked for the quantity the stepper is showing, the row gets
 *    `.is-nospace`, and the button reads `가방·창고 공간 부족` with the reason in its `title`. Re-checked on every
 *    `paint()`, which `InventoryUI.refresh()` runs when the bench opens and on every bag / stash change.
 *  - A **제작 수량** stepper sits above the hold button, reading the **total units the hold will make**
 *    (`◀ 90 ▶` → `180` → `270`; 사용자 결정 2026-09-09 — "how many 발 do I get", not "how many runs"). The wheel over
 *    it steps too, capped by `sys.maxCraftCount(id)` (what the materials pay for), and the material chips scale with
 *    it. The step is the recipe's own `outputQty`, never a re-derived stack size.
 *  - The 키 가이드 line for the panel is empty now (`parts/Screens.setCraftOpen`): the button already reads
 *    `길게 눌러 제작`, so `1초 홀드 — 제작` was the same sentence twice.
 *
 * **2026-09-10 (제작 대개편 2단계)** — **홀드 중에는 게이지만 다시 그린다** (`frozen` → `paintProgress`).
 *  `updateCraft` 가 매 프레임 이 패널을 새로 그리는데, 94 줄 × `craftHasRoom`(가방 · 창고 격자를 통째로
 *  복사한다) 은 홀드 1 초 동안 60 번 돌 이유가 없는 계산이다. 화면에서 바뀌는 것은 채워지는 막대뿐이고,
 *  **홀드 중에 줄을 옮기지 않는다**는 규약(`applySort`)과 같은 뿌리다.
 *
 * **2026-09-12 (사용자 결정) — 4열 배치의 왼쪽 두 열이 이 패널이다.**
 *  제작 열은 이제 `[함선 작업대 목록] [제작품 목록]` 두 열이고 (`.inv-craft-benches` + `.inv-craft-main`),
 *  그 오른쪽에 `[함선 창고] [내 가방]` 이 선다 (`inventory.css` 의 `.inv-layout.is-craft`).
 *  - 2026-09-10 의 **가로 탭**(`.inv-craft-tabs`)은 **세로 작업대 리스트**로 바뀌었다. 항목은 `빠른제작`
 *    (작업대 없이 되는 것) + **이 함선에 실제로 설치된** 작업대뿐이다 (`ctx.housing.getBenchLevel > 0`) —
 *    `전체` 는 없앴다: 94 줄을 한 목록에 쏟는 것이 애초에 읽히지 않아 탭이 생긴 이유였다.
 *  - 항목을 누르면 **그 자리에서** 작업대가 바뀐다 (`InventoryRef.switchBench`; 창을 닫지 않는다). 작업대를
 *    열어 들어온 경우 그 항목이 선택된 채로 시작한다.
 *  - 제작품 목록은 **고정 높이 + 세로 스크롤**이라 창이 짧아도 목록만 움직인다.
 *
 * **2026-09-08 (튜토리얼)**: a recipe `ctx.tutorial.hides('craft', id)` refuses is **left out of the list** rather
 * than drawn with a "튜토리얼에서는 ~" reason — during the guided steps the bench shows exactly the one recipe the
 * step is asking for. The 단계 is part of the rebuild signature, so finishing or skipping the tutorial brings the
 * rest straight back.
 */
export class CraftPanel {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private stationEl: HTMLElement;
  private discountEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  /** `모두 수리` — 수리를 하는 작업대(화기 · 장비)에서만 보인다. */
  private repairBtn: HTMLButtonElement;
  /** **만든 순서(= csv 순서) 그대로**의 행 목록. 화면의 줄 순서는 `applySort` 가 DOM 에서만 바꾼다. */
  private rows: RowView[] = [];
  private sig = '';
  /** 마지막으로 DOM 에 반영한 줄 순서 (레시피 id 를 이어 붙인 것). */
  private sortSig = '';
  private holding: string | null = null;
  private onWindowUp = (): void => { this.release(); };
  /* ── 2026-09-12: 왼쪽 세로 작업대 리스트 (2026-09-10 의 가로 탭을 대신한다) ── */
  /** 리스트가 사는 열 (고를 것이 하나뿐이면 숨는다 — 레이드의 야전 제작). */
  private benchesEl: HTMLElement;
  /** 머리 · 목록이 사는 오른쪽 열 (`.inv-panel-craft` 는 이 둘의 가로 배치다). */
  private mainEl: HTMLElement;
  /** 마지막으로 그린 리스트 구성 — 같으면 DOM 을 다시 만들지 않는다. */
  private benchSig = '';
  /**
   * 홀드가 도는 동안 목록을 얼려 두기 위한 표시 (2026-09-10) — 값이 있으면 `refresh()` 가 게이지만 다시 그린다.
   * 홀드 중에는 어차피 줄을 옮기지 않기로 되어 있고(`applySort`), 94 줄 × (canCraft · maxCraftCount ·
   * craftHasRoom(격자 두 개를 복사한다)) 를 **매 프레임** 돌 이유가 없다.
   */
  private frozen: string | null = null;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    /** Phase 8: the 닫기 button outside bench mode (the window closes the modeless popup). */
    private readonly onClose: () => void = () => {},
    /** 2026-09-08: the header's `모두 수리` — the window opens the `RepairPanel` popup anchored on that button. */
    private readonly onRepair: (anchor: HTMLElement) => void = () => {},
  ) {
    this.el = document.createElement('section');
    this.el.className = 'inv-panel inv-panel-craft';
    this.el.hidden = true;

    const head = document.createElement('header');
    head.className = 'inv-head';
    const titles = document.createElement('div');
    titles.className = 'inv-head-titles';
    this.stationEl = document.createElement('div');
    this.stationEl.className = 'inv-eyebrow';
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'inv-title';
    this.titleEl.textContent = TEXT.craftPanel;
    titles.append(this.stationEl, this.titleEl);
    const actions = document.createElement('div');
    actions.className = 'inv-head-actions';
    this.discountEl = document.createElement('div');
    this.discountEl.className = 'inv-capacity inv-craft-discount';
    this.discountEl.hidden = true;
    // 2026-09-08: 수리는 패널 하단의 목록이 아니라 헤더의 이 버튼(닫기 왼쪽) → 모달 팝업
    this.repairBtn = document.createElement('button');
    this.repairBtn.type = 'button';
    this.repairBtn.className = 'inv-btn inv-repair-open';
    this.repairBtn.textContent = TEXT.bench.repairAll;
    this.repairBtn.hidden = true;
    this.repairBtn.addEventListener('click', () => this.onRepair(this.repairBtn));
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'inv-btn inv-craft-close';
    this.closeBtn.textContent = TEXT.bench.close;
    this.closeBtn.addEventListener('click', () => {
      if (this.sys.getBench()) this.sys.closeBench(); else this.onClose();
    });
    actions.append(this.discountEl, this.repairBtn, this.closeBtn);
    head.append(titles, actions);

    // 2026-09-12: 맨 왼쪽 세로 작업대 리스트 (빠른제작 + 이 함선에 설치된 작업대)
    this.benchesEl = document.createElement('div');
    this.benchesEl.className = 'inv-craft-benches';
    this.benchesEl.hidden = true;

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-craft-list';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.craftNone;

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'inv-craft-main';
    this.mainEl.append(head, this.listEl, this.emptyEl);

    this.el.append(this.benchesEl, this.mainEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return !this.el.hidden; }

  setOpen(open: boolean): void {
    if (this.el.hidden === !open) return;
    this.el.hidden = !open;
    if (!open) this.release();
    else { this.sig = ''; this.frozen = null; this.refresh(); }
  }

  /** Rebuild the rows when the available recipe set changes; otherwise just repaint counts / progress. */
  refresh(): void {
    if (this.el.hidden) return;
    /*
     * **2026-09-10 — 홀드가 도는 동안에는 게이지만.** `updateCraft` 가 매 프레임 `refreshCraft()` 를 부르므로
     * 이 함수는 홀드 1 초 동안 60 번 돈다. 레시피가 48 → 94 줄로 늘면서 그 한 번이 목록 재구성 신호 계산 +
     * 줄마다 `canCraft` · `maxCraftCount` · `craftHasRoom`(가방 · 창고 격자를 통째로 복사한다) 이 됐다.
     * 홀드 중에 바뀌는 것은 채워지는 막대뿐이고 **줄을 움직이지 않는다는 규약**(`applySort`)도 이미 있으므로,
     * 첫 프레임에 한 번 제대로 그린 뒤로는 막대만 다시 그린다.
     */
    const running = this.sys.craftProgress();
    if (running && this.frozen === running.recipeId) { this.paintProgress(running); return; }
    this.frozen = running?.recipeId ?? null;
    const bench = this.sys.getBench();
    if (bench) {
      // 2026-09-13: 머리의 영문 줄은 작업대가 속한 **시설**을 말한다 (WORKSHOP / LAB / KITCHEN BENCH)
      this.stationEl.textContent = TEXT.bench.eyebrow(benchFacility(bench.kind));
      this.titleEl.textContent = `${WORKBENCH_LABEL_KO[bench.kind]} ${TEXT.bench.level(bench.level)}`;
    } else {
      const station = this.sys.currentStation();
      this.stationEl.textContent = station === 'ship' ? TEXT.craftStationShip : TEXT.craftStationField;
      this.titleEl.textContent = TEXT.craftPanel;
    }
    const mul = this.sys.craftCostMul();
    this.discountEl.hidden = mul >= 1;
    if (mul < 1) this.discountEl.textContent = TEXT.bench.discount(Math.round((1 - mul) * 100));

    const tut = this.sys.ctx.tutorial;
    const all = this.sys.getBenchRecipes().filter((r) => !(tut?.hides('craft', r.recipe.id) ?? false));
    // 2026-09-12: 왼쪽 작업대 리스트. 작업대를 고르면 `getBenchRecipes()` 가 이미 그 작업대 것만 주므로,
    //   따로 거르는 것은 `빠른제작`(bench 없음) 하나뿐이다.
    this.buildBenches(bench?.kind ?? null);
    const recipes = bench ? all : all.filter((r) => isFieldRecipe(r.recipe));
    // 2026-09-12 (E1): 산출물 썸네일의 즐겨찾기 띠도 이 서명을 탄다 (`favoritesRevision`)
    const sig = `${bench ? `${bench.kind}:${bench.level}` : '-'}|${mul}|t${tut?.step ?? '-'}|f${favoritesRevision()}`
      + `|${recipes.map((r) => `${r.recipe.id}${r.locked ? '!' : ''}`).join('|')}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.sortSig = '';
      this.build(recipes);
    }
    this.emptyEl.hidden = recipes.length > 0;
    this.paint();
    /*
     * 2026-09-12 (정비 벤치 은퇴): `모두 수리` 는 **함선이면 언제나** 뜬다 — 예전에는 총기 · 장비 작업대를 열고
     * 들어왔을 때만이었다. "함선에서는 인벤토리에서 재료만 갖다 바치면 수리 가능"이 규칙이 됐고, 무엇을 고칠 수
     * 있는지는 `benchRepairRows` 가 정한다 (레이드 중에는 빈 목록 → 여기서도 숨긴다).
     */
    this.repairBtn.hidden = this.sys.ctx.isRaidActive();
  }

  /**
   * **왼쪽 세로 작업대 리스트** (2026-09-12, 사용자 결정). 맨 위가 `빠른제작`(작업대 없이 되는 것), 그 아래로
   * **이 함선에 실제로 설치된** 작업대(`ctx.housing.getBenchLevel(kind) > 0`)와 **지금 열고 들어온** 작업대가
   * `WORKBENCH_KINDS` 순서로 선다.
   * 누르면 그 자리에서 목록이 갈린다 (`InventoryRef.switchBench` — 창을 닫지도 열지도 않는다).
   *
   * 이름 · 글리프는 `WORKBENCH_LABEL_KO` · `WORKBENCH_ICON`(`@/shared`) 하나가 원본이라 함선 관리 화면 ·
   * 작업대 제목 · 여기가 같은 이름으로 부른다. 고를 것이 하나뿐이면(레이드의 야전 제작) 열 자체가 숨는다.
   *
   * 재료 상태를 보지 않으므로 구성이 그대로면 `is-on` 만 옮긴다.
   *
   * **2026-09-13 (사용자 결정) — 같은 시설의 작업대만.** 리스트는 지금 작업대(`active`, 없으면 빠른제작)가 속한
   * **시설**(`benchFacility` — `data/furniture.csv` 의 `room`)의 작업대만 보여 준다: 작업실 = 총기 · 장비 · 가젯 ·
   * 의학 · 가공, 연구실 = 추출기 · 조합대 · 3D 프린터, 주방 = 조리대. `빠른제작` 은 **작업실 소속**이라 작업실
   * 묶음의 맨 위에만 선다 — 가방의 `제작` 버튼(작업대 없이 연 제작 열)도 작업실 묶음이다. 리스트 안에서 고를 수
   * 있는 것은 같은 시설뿐이므로 한 번 열린 묶음은 창을 닫을 때까지 바뀌지 않는다. 항목이 하나뿐인 시설(주방)도
   * **리스트를 그대로 보여 준다**(사용자 결정) — 숨는 것은 레이드(빠른제작 하나)뿐이다.
   */
  private buildBenches(active: BenchPick): void {
    const housing = this.sys.ctx.housing;
    const bench = this.sys.getBench();
    /*
     * 지금 **열고 들어온** 작업대는 `ctx.housing` 이 뭐라 하든 목록에 있고 그 레벨로 선다 — 제목이
     * `가공 작업대 Lv.3` 인데 왼쪽 리스트에는 그 줄이 없어 아무것도 선택돼 있지 않은 화면이 나올 수 있다
     * (남의 함선 · 공유 함선처럼 가구가 `ctx.housing`(= 내 함선) 밖에 있는 경우). 제목과 리스트의 원본을
     * 하나로 묶는다.
     */
    const levelOf = (kind: WorkbenchKind): number => {
      let lv = 0;
      try { lv = Math.max(0, housing?.getBenchLevel(kind) ?? 0); } catch { lv = 0; }
      return bench && bench.kind === kind ? Math.max(lv, bench.level) : lv;
    };
    const hub = this.sys.ctx.isHubPhase();
    const facility = benchFacility(active);
    const placed = hub
      // 2026-09-13 (요리 미니게임): 조리대는 제작 창의 작업대가 아니다 — 조리대 화면(housing)에서만 요리한다
      ? WORKBENCH_KINDS.filter((k) => k !== 'cook' && benchFacility(k) === facility && (k === active || levelOf(k) > 0))
      : [];
    const picks: BenchPick[] = facility === 'workshop' ? [null, ...placed] : placed;
    this.benchesEl.hidden = !hub || picks.length === 0;
    this.benchesEl.dataset.facility = facility;
    const sig = picks.map((p) => (p === null ? '-' : `${p}:${levelOf(p)}`)).join('|');
    if (sig !== this.benchSig) {
      this.benchSig = sig;
      this.benchesEl.replaceChildren(...picks.map((pick) => {
        const level = pick ? levelOf(pick) : 0;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'inv-craft-bench';
        b.dataset.bench = pick ?? 'field';
        const ico = document.createElement('i');
        ico.className = 'inv-craft-bench-ico';
        ico.textContent = pick ? WORKBENCH_ICON[pick] : TEXT.craftTabs.icon.field ?? '✥';
        const name = document.createElement('span');
        name.className = 'inv-craft-bench-nm';
        name.textContent = pick ? WORKBENCH_LABEL_KO[pick] : TEXT.craftTabs.field;
        b.append(ico, name);
        if (pick) {
          const lv = document.createElement('span');
          lv.className = 'inv-craft-bench-lv';
          lv.textContent = TEXT.bench.level(level);
          b.appendChild(lv);
        }
        b.title = name.textContent;
        b.addEventListener('click', () => {
          if ((this.sys.getBench()?.kind ?? null) === pick) return;
          this.sys.switchBench(pick, level);
          this.sys.sfx('ui_pickup');
          this.sig = '';                 // 목록이 통째로 바뀐다
          this.frozen = null;
          this.refresh();
        });
        return b;
      }));
    }
    for (const b of this.benchesEl.children) {
      b.classList.toggle('is-on', ((b as HTMLElement).dataset.bench ?? 'field') === (active ?? 'field'));
    }
  }

  /**
   * 홀드 중의 최소 갱신 (2026-09-10): 도는 줄의 게이지 하나만 옮긴다. 재료 칩 · 정렬 · 자리 검사는
   * 손대지 않는다 — 그 셋은 홀드가 끝난 뒤 `refresh()` 의 느린 길이 한 번에 다시 그린다.
   */
  private paintProgress(job: { recipeId: string; progress: number }): void {
    for (const row of this.rows) {
      const active = row.recipe.id === job.recipeId;
      row.el.classList.toggle('is-crafting', active);
      row.fill.style.width = active ? `${Math.round(job.progress * 100)}%` : '0%';
    }
  }

  private build(recipes: readonly BenchRecipeRow[]): void {
    this.listEl.innerHTML = '';
    this.rows = [];
    for (const { recipe, locked } of recipes) {
      const row = document.createElement('div');
      row.className = 'inv-craft-row';
      row.dataset.recipe = recipe.id;
      if (locked) row.classList.add('is-bench-locked');

      const out = this.getDef(recipe.outputDefId);

      /* ── 산출물 썸네일: the tile this will become, at the grid's own cell size ── */
      const thumb = document.createElement('div');
      thumb.className = 'inv-craft-thumb';
      if (out) {
        // `data-item-tip` + `data-def-id` is what `ui/hud/ItemTip` delegates on — the same hover card the cost chips
        // and the 기업 거래 tiles get. The tile itself is inert: no drag, no context menu, no handlers.
        thumb.dataset.itemTip = '';
        thumb.dataset.defId = out.id;
        const tile = document.createElement('div');
        const item = this.sys.loot.createItem(out.id, Math.min(out.stackMax, recipe.outputQty));
        // 2026-09-09: **한 칸 고정.** 산출물을 실제 격자 크기로 그리니 4×2 돌격소총 한 줄이 탄약 한 줄의 네 배로
        // 벌어져 목록이 무너졌다 (사용자 보고). 여기서 알아야 할 것은 "무엇이 나오는가"이지 "가방에서 몇 칸을
        // 먹는가"가 아니고, 칸 수는 바로 아래 `is-nospace` 안내와 툴팁이 말해 준다. 스택 수량은 1×1 타일도 그대로
        // 그리므로(`GridView.buildTileContent` 의 `inv-tile-qty`) 준중량탄 ×90 은 예전과 똑같이 읽힌다.
        buildTileContent(tile, item, out, 1, 1, null, CELL);
        thumb.appendChild(tile);
        // A stacking def draws its own count; one that does not stack but is made in twos needs the badge.
        if (out.stackMax <= 1 && recipe.outputQty > 1) {
          const badge = document.createElement('div');
          badge.className = 'inv-craft-thumb-qty';
          badge.textContent = `×${recipe.outputQty}`;
          thumb.appendChild(badge);
        }
      }

      const info = document.createElement('div');
      info.className = 'inv-craft-info';
      const name = document.createElement('div');
      name.className = 'inv-craft-name';
      if (locked) {
        const tag = document.createElement('span');
        tag.className = 'inv-craft-locktag';
        tag.textContent = TEXT.bench.lockedLevel(recipe.benchLevel ?? 1);
        name.appendChild(tag);
      }
      const inputs = document.createElement('div');
      inputs.className = 'inv-craft-inputs';
      const costs = document.createElement('div');
      costs.className = 'inv-craft-costs';
      inputs.appendChild(costs);
      // 2026-09-09: the `.inv-craft-desc` line is gone — the thumbnail and the title say what this makes.
      info.append(name, inputs);

      /* ── 제작 수량 스테퍼 + 홀드 버튼 ── */
      const act = document.createElement('div');
      act.className = 'inv-craft-act';
      const stepper = document.createElement('div');
      stepper.className = 'inv-craft-count';
      stepper.title = TEXT.craftCount.hint;
      const lessBtn = document.createElement('button');
      lessBtn.type = 'button';
      lessBtn.className = 'inv-craft-step';
      lessBtn.textContent = '\u25c0';
      lessBtn.title = TEXT.craftCount.less;
      const countEl = document.createElement('span');
      countEl.className = 'inv-craft-count-v';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'inv-craft-step';
      moreBtn.textContent = '\u25b6';
      moreBtn.title = TEXT.craftCount.more;
      stepper.append(lessBtn, countEl, moreBtn);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inv-btn inv-craft-btn';
      const fill = document.createElement('i');
      fill.className = 'inv-craft-fill';
      const label = document.createElement('span');
      label.textContent = TEXT.craftHold;
      button.append(fill, label);
      act.append(stepper, button);

      const view: RowView = {
        recipe, locked, el: row, costsEl: costs, inputsEl: inputs, button, fill,
        count: 1, nameEl: name, countEl, lessBtn, moreBtn,
      };

      if (locked) { button.disabled = true; lessBtn.disabled = true; moreBtn.disabled = true; }
      else {
        button.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          this.press(recipe.id);
        });
        button.addEventListener('pointerleave', () => this.release());
        lessBtn.addEventListener('click', (e) => { e.stopPropagation(); this.step(view, -1); });
        moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.step(view, 1); });
        // Non-passive: the list underneath must not scroll while the wheel is spending itself on the count.
        stepper.addEventListener('wheel', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.step(view, e.deltaY < 0 ? 1 : -1);
        }, { passive: false });
      }

      row.append(thumb, info, act);
      this.listEl.appendChild(row);
      this.rows.push(view);
    }
  }

  /**
   * 2026-09-09 — move a row's 제작 수량 by `dir`, clamped to 1 … `maxCraftCount` (what the owned materials pay for).
   * A running craft owns the count it started with, so the stepper is inert while that row is holding.
   */
  private step(row: RowView, dir: number): void {
    if (row.locked || this.holding === row.recipe.id) return;
    const max = Math.max(1, this.sys.maxCraftCount(row.recipe.id));
    const next = Math.max(1, Math.min(max, row.count + dir));
    if (next === row.count) return;
    row.count = next;
    this.sys.sfx('ui_pickup');
    this.paint();
  }

  /**
   * **2026-09-10 — 지금 만들 수 있는 것이 위로.** 재료 · 숙련도 · 작업대 레벨을 전부 만족한 줄이 먼저 오고,
   * 그 안에서는 **원래 순서(csv 순서)를 유지**한다 (안정 정렬).
   *
   * - 숙련도는 애초에 `getRecipes` 가 걸러 목록에 없고, 작업대 레벨은 `locked` 다. 그래서 여기서 볼 것은
   *   `!locked && canCraft(id, 1)` 하나뿐이다 — **한 번이라도 만들 수 있나**이지 스테퍼에 걸린 수량이 아니다
   *   (◀▶ 를 올렸다고 줄이 아래로 내려가면 그 줄을 놓친다).
   * - 넣을 자리(`craftHasRoom`)는 보지 **않는다**: 가방이 찬 것은 레시피의 성질이 아니고, 그 줄은 이미
   *   `is-nospace` 로 이유를 말하고 있다.
   * - `paint()` 안에서 도므로 재료를 넣거나 빼면 (→ `afterChange` → `InventoryUI.refresh`) 정렬이 곧바로 따라온다.
   * - **홀드 중에는 줄을 움직이지 않는다.** 누르고 있는 버튼의 DOM 을 옮기면 포인터가 그 위를 떠난 것으로 읽혀
   *   (`pointerleave` → `release`) 제작이 취소된다.
   */
  private applySort(): void {
    if (this.holding || this.rows.length < 2) return;
    const order = this.rows
      .map((row, i) => ({ row, i, ready: !row.locked && this.sys.canCraft(row.recipe.id, 1) }))
      .sort((a, b) => (a.ready === b.ready ? a.i - b.i : a.ready ? -1 : 1));
    const sig = order.map((o) => o.row.recipe.id).join('|');
    if (sig === this.sortSig) return;
    this.sortSig = sig;
    for (const o of order) this.listEl.appendChild(o.row.el);
  }

  private paint(): void {
    this.applySort();
    const job = this.sys.craftProgress();
    for (const row of this.rows) {
      const active = job?.recipeId === row.recipe.id;
      // 2026-09-09 (제작 수량): the count is clamped on every paint — spending materials elsewhere (or a craft that
      // just consumed its own) lowers the ceiling, and a stale `n` would then only fail at the end of the hold.
      // A running row keeps the count it started with.
      const max = Math.max(1, this.sys.maxCraftCount(row.recipe.id));
      if (!active && row.count > max) row.count = max;
      const n = row.count;

      const ok = !row.locked && this.sys.canCraft(row.recipe.id, n);
      /*
       * 2026-09-09 (사용자 결정) — **넣을 자리부터 본다.** 재료가 다 있어도 산출물이 들어갈 칸이 없으면 1초를
       * 눌러 봐야 홀드 끝에서 거절당했다 (분해 팝업은 2026-09-08 에 이미 앞으로 옮긴 검사다). 이제 제작 목록도
       * 같다: `craftHasRoom` 을 **지금 스테퍼에 걸린 수량 그대로** 물어 버튼을 잠그고, 라벨과 툴팁이 이유를 말한다.
       * 이 `paint()` 는 `InventoryUI.refresh()` 를 타고 `afterChange()` 마다 다시 도므로 — 작업대를 열 때
       * (`setOpen` → `refresh`) 한 번, 그리고 가방 · 창고의 아이템이 바뀔 때마다 — 다시 검사된다.
       */
      const room = ok && this.sys.craftHasRoom(row.recipe.id, n);
      const ship = this.sys.ctx.isHubPhase();
      row.el.classList.toggle('is-locked', !ok);
      row.el.classList.toggle('is-nospace', ok && !room);
      row.button.disabled = row.locked || ((!ok || !room) && !active);
      row.button.title = ok && !room ? (ship ? TEXT.craftNoRoomTipShip : TEXT.craftNoRoomTipField) : '';

      const out = this.getDef(row.recipe.outputDefId);
      // `산출물 이름 ×n` (2026-09-09) — the recipe's own name is not shown any more, and `n` is what **one** craft
      // makes, so the title never moves. The lock tag, when there is one, is the element's only child, so the text
      // goes in front of it rather than through `textContent`.
      const title = out ? `${out.name} \u00d7${row.recipe.outputQty}` : row.recipe.name;
      if (row.nameEl.firstChild?.nodeType === Node.TEXT_NODE) row.nameEl.firstChild.nodeValue = title;
      else row.nameEl.insertBefore(document.createTextNode(title), row.nameEl.firstChild);

      // The stepper reads the **total units this hold will make** (사용자 결정 2026-09-09: 경량탄이면 30 · 60 · 90),
      // not the run count — `n` runs of a recipe is an implementation detail, "how many 발 do I get" is the question.
      row.countEl.textContent = String(row.recipe.outputQty * n);
      row.el.classList.toggle('is-multi', n > 1);
      row.lessBtn.disabled = row.locked || active || n <= 1;
      row.moreBtn.disabled = row.locked || active || n >= max;

      // Phase 8: thumbnail chips with 보유/필요 at the bottom right (dimmed + red 보유 when short).
      // 2026-09-09: 필요 is the recipe's cost × the 제작 수량, so the chips answer the button that is about to be held.
      const cost = this.sys.craftCost(row.recipe).map((i) => ({ defId: i.defId, qty: i.qty * n }));
      renderItemCost(row.costsEl, cost, this.getDef, (id) => this.sys.countWhere((d) => d.id === id), { size: 30 });
      // 2026-09-08: the `2.0 s` 시간 칩 is gone — every recipe holds for the same `CRAFT_HOLD_TIME` now, so there was
      //   nothing left to tell apart. The button's own fill is the readout.

      row.el.classList.toggle('is-crafting', active);
      row.fill.style.width = active ? `${Math.round(job!.progress * 100)}%` : '0%';
      const label = row.button.querySelector('span');
      if (label) {
        label.textContent = active ? TEXT.craftMaking
          : ok && !room ? (ship ? TEXT.craftNoRoomShip : TEXT.craftNoRoomField)
          : TEXT.craftHold;
      }
    }
  }

  /* ── hold to craft ────────────────────────────────────────────────────── */

  private press(recipeId: string): void {
    if (this.holding) return;
    this.holding = recipeId;
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
    // 2026-09-09: the hold buys `count` runs at once (`InventoryRef.craft(id, targetUid?, count)`) — still one
    // `CRAFT_HOLD_TIME`, however many runs it pays for.
    const count = this.rows.find((r) => r.recipe.id === recipeId)?.count ?? 1;
    void this.sys.craft(recipeId, undefined, count).then(() => {
      if (this.holding === recipeId) this.release();
      this.refresh();
    });
    this.paint();
  }

  private release(): void {
    if (!this.holding) return;
    this.holding = null;
    window.removeEventListener('pointerup', this.onWindowUp);
    window.removeEventListener('pointercancel', this.onWindowUp);
    this.sys.cancelCraft();
    this.paint();
  }

  dispose(): void {
    this.release();
    this.el.remove();
  }
}
