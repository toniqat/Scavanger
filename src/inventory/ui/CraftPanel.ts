import type { CraftRecipe, ItemDef, RoomPurpose, WorkbenchKind } from '@/shared';
import { FURNITURE_DEFS, WORKBENCH_ICON, WORKBENCH_KINDS, WORKBENCH_LABEL_KO, benchKindOf, createHoldButtonCap, renderItemCost } from '@/shared';
import { getWeaponDef } from '@/items';
import type { BenchRecipeRow, InventorySystem } from '../InventorySystem';
import { buildTileContent, favoritesRevision, shelfWantedRevision } from './GridView';
import { Tooltip } from './Tooltip';
import { inventoryTooltipLookups } from './TipPin';
import { CELL, TEXT, categoryLabel, rarityLabel, weaponClassLabel } from './labels';

/**
 * 왼쪽 작업대 리스트의 한 칸 (2026-09-12). `null` = **빠른제작**(작업대 없이 되는 것), 나머지는 이 함선에
 * 실제로 설치된 `WorkbenchKind` 다.
 */
type BenchPick = WorkbenchKind | null;

/** 이 레시피가 「빠른제작」인가 — `station: 'field'` 면 작업대가 없어도 만들 수 있다. */
/* 현장 레시피는 자기 작업대 태그가 있어도 빠른제작이다 — 그 목록의 뜻이 "작업대 없이도 되는 것" 이다.
 * (2026-09-10 부터 탄약 · 붕대 · 연막에도 `bench` 가 붙었다. 그것은 작업대 창에 뜨라는 표시일 뿐이다.) */
const isFieldRecipe = (r: CraftRecipe): boolean => r.station === 'field';

/** 조합 목록의 가로 칸 수 (사용자 결정 「가로 최대 4칸」). CSS 는 `--inv-craft-cols` 로 이 값을 받는다. */
export const CRAFT_LIST_COLS = 4;

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

/** 왼쪽 조합 목록의 한 칸 — 산출물 썸네일 하나. 재료 · 수량 · 버튼은 전부 오른쪽 상세 패널이 갖는다. */
interface CellView {
  recipe: CraftRecipe;
  locked: boolean;
  el: HTMLElement;
}

/**
 * **제작 상세 패널** (2026-09-15 2차, 사용자 결정) — 이 폴더 밖에서도 쓸 수 있도록 조각으로 떼어 놓은 모양.
 * 조리대 화면(`housing`)이 같은 카드를 그리고 싶을 때 `CraftDetail` 의 DOM 과 갱신 규약을 그대로 가져간다.
 */
export interface CraftDetailHandle {
  /** 패널 루트 (`.inv-craft-detail`). 부른 쪽이 원하는 자리에 붙인다. */
  readonly el: HTMLElement;
  /** 지금 그려진 레시피 id (없으면 null). */
  readonly recipeId: string | null;
  /** 이 레시피를 그린다 (같은 레시피면 수치만 갱신). null = 빈 패널. */
  show(recipe: CraftRecipe | null, locked: boolean): void;
  /** 재료 · 보유 수 · 수량 상한 · 버튼 상태만 다시 계산한다. */
  paint(): void;
  /** 홀드 중의 최소 갱신 — 게이지만. */
  paintProgress(progress: number): void;
  /** 이 패널이 지금 들고 있는 제작 수량(런 수 ≥ 1). */
  readonly count: number;
  dispose(): void;
}

/**
 * Crafting panel (인벤토리 안의 `제작` 버튼, or a 작업실 bench through `InventoryRef.openBenchCraft`).
 *
 * ## 2026-09-15 2차 — **목록 + 상세** (사용자 결정, 제작 UI 전면 개편)
 *
 * 94 줄짜리 세로 목록(줄마다 썸네일 · 이름 · 재료 칩 · 스테퍼 · 버튼)이 한 화면에 세 줄밖에 못 담았고, 줄 안의
 * 모든 것이 스테퍼 하나 때문에 가로로 눌렸다. 이제 패널은 **왼쪽 = 조합 목록 · 오른쪽 = 고른 것의 상세** 다:
 *
 *  - **왼쪽 `.inv-craft-list`**: 산출물 **썸네일만**의 격자(가로 `CRAFT_LIST_COLS` = 4칸). 칸은
 *    `.inv-craft-cell[data-recipe]` 이고 잠긴 줄(작업대 레벨)은 `.is-bench-locked`, 지금 재료가 모자란 줄은
 *    `.is-locked` 다. **지금 만들 수 있는 것이 앞으로** 오고(안정 정렬), 재료가 바뀔 때마다(제작 · 아이템 획득 →
 *    `afterChange` → `InventoryUI.refresh` → `paint()`) 다시 정렬한다.
 *  - **오른쪽 `.inv-craft-detail`**: 위에서 아래로 ① 산출물 썸네일 + 이름 · 종류, ② **아이템 툴팁 그대로의**
 *    설명 · 스펙(`ui/Tooltip` 을 그 자리에 붙여 쓴다 — 스펙 줄을 두 번 적지 않는다), ③ 현재 보유 수,
 *    ④ 재료 **썸네일**(「재료 부족: …」 같은 글자 줄은 없다 — 모자란 것은 칩이 스스로 빨갛게 말한다),
 *    ⑤ 가로 수량 조절(`지금 목표 / 최대`), ⑥ 길게 눌러 제작 버튼(1초 홀드 게이지 + 좌클릭 홀드 키캡).
 *  - 고를 것이 하나도 없는 작업대는 목록 · 상세 대신 **가운데 한 줄** `제작할 수 있는 레시피가 없습니다.` 를 그린다.
 *  - **산출물이 가는 곳**은 함선이면 창고 먼저 · 차면 가방, 레이드 현장은 가방뿐이다 (`parts/Crafting.addCraftOutputs`).
 *    보유 수도 같은 범위를 센다 (`InventoryRef.craftCountDef`).
 *
 * ⚠ 튜토리얼의 스포트라이트 선택자 `.inv-craft-row[data-recipe="…"] .inv-craft-btn` 이 계속 맞도록, **상세 패널이
 * `.inv-craft-row` 라는 이름도 함께 갖는다** (그 안에 `.inv-craft-btn` 이 있다). 그리고 목록이 다시 만들어질 때
 * 고른 것이 없으면 **첫 칸을 자동으로 고른다** — 튜토리얼은 그 단계의 레시피 하나만 남기므로 그 하나가 곧 상세다.
 *
 * ## 그대로인 것
 *
 * - **왼쪽 세로 작업대 리스트**(`.inv-craft-benches`, 2026-09-12) · 같은 시설의 작업대만(2026-09-13).
 * - 홀드는 모든 레시피가 같은 `CRAFT_HOLD_TIME`(1 s)이고, **홀드 중에는 게이지만 다시 그린다**(`frozen`).
 * - 튜토리얼이 감춘 레시피는 목록에서 아예 빠진다(`ctx.tutorial.hides('craft', id)`).
 * - 창이 `.inv-root.is-craft` 인 동안 장착 장비 · 퀵슬롯 · 화면 탭 · 가방 헤더의 제작/가치는 숨는다
 *   (`parts/Screens.setCraftOpen`).
 */
export class CraftPanel {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private bodyEl: HTMLElement;
  private stationEl: HTMLElement;
  private discountEl: HTMLElement;
  private closeBtn: HTMLButtonElement;
  /** **만든 순서(= csv 순서) 그대로**의 칸 목록. 화면의 순서는 `applySort` 가 DOM 에서만 바꾼다. */
  private cells: CellView[] = [];
  private sig = '';
  /** 마지막으로 DOM 에 반영한 칸 순서 (레시피 id 를 이어 붙인 것). */
  private sortSig = '';
  /** 오른쪽 상세 패널이 지금 들고 있는 레시피 id. */
  private selected: string | null = null;
  private detail: CraftDetail;
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
   * 홀드 중에는 어차피 칸을 옮기지 않기로 되어 있고(`applySort`), 94 칸 × (canCraft · maxCraftCount ·
   * craftHasRoom(격자 두 개를 복사한다)) 를 **매 프레임** 돌 이유가 없다.
   */
  private frozen: string | null = null;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    /** Phase 8: the 닫기 button outside bench mode (the window closes the modeless popup). */
    private readonly onClose: () => void = () => {},
    /**
     * @deprecated 2026-09-14 — 헤더의 `모두 수리` 가 가방 필터 줄로 옮겨 가면서 이 패널은 더 이상 부르지 않는다.
     * 인자는 호출부를 흔들지 않으려고 남겨 둔다 (계약은 추가만, 삭제 금지와 같은 결).
     */
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
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'inv-btn inv-craft-close';
    this.closeBtn.textContent = TEXT.bench.close;
    this.closeBtn.addEventListener('click', () => {
      if (this.sys.getBench()) this.sys.closeBench(); else this.onClose();
    });
    actions.append(this.discountEl, this.closeBtn);
    head.append(titles, actions);

    // 2026-09-12: 맨 왼쪽 세로 작업대 리스트 (빠른제작 + 이 함선에 설치된 작업대)
    this.benchesEl = document.createElement('div');
    this.benchesEl.className = 'inv-craft-benches';
    this.benchesEl.hidden = true;

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-craft-list';
    this.listEl.style.setProperty('--inv-craft-cols', String(CRAFT_LIST_COLS));
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.craftNone;

    this.detail = new CraftDetail(this.sys, this.getDef, {
      onPress: (id) => this.press(id),
      onRelease: () => this.release(),
      isHolding: (id) => this.holding === id,
      onCountChanged: () => { this.sys.sfx('ui_pickup'); },
    });

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'inv-craft-body';
    this.bodyEl.append(this.listEl, this.detail.el);

    this.mainEl = document.createElement('div');
    this.mainEl.className = 'inv-craft-main';
    this.mainEl.append(head, this.bodyEl, this.emptyEl);

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

  /** Rebuild the cells when the available recipe set changes; otherwise just repaint counts / progress. */
  refresh(): void {
    if (this.el.hidden) return;
    /*
     * **2026-09-10 — 홀드가 도는 동안에는 게이지만.** `updateCraft` 가 매 프레임 `refreshCraft()` 를 부르므로
     * 이 함수는 홀드 1 초 동안 60 번 돈다. 홀드 중에 바뀌는 것은 채워지는 막대뿐이고 **칸을 움직이지 않는다는
     * 규약**(`applySort`)도 이미 있으므로, 첫 프레임에 한 번 제대로 그린 뒤로는 막대만 다시 그린다.
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
    const sig = `${bench ? `${bench.kind}:${bench.level}` : '-'}|${mul}|t${tut?.step ?? '-'}|f${favoritesRevision()}|w${shelfWantedRevision()}`
      + `|${recipes.map((r) => `${r.recipe.id}${r.locked ? '!' : ''}`).join('|')}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.sortSig = '';
      this.build(recipes);
    }
    // 목록이 비면 목록 · 상세 대신 가운데 한 줄만 (사용자 결정)
    const empty = recipes.length === 0;
    this.emptyEl.hidden = !empty;
    this.bodyEl.hidden = empty;
    this.paint();
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
   * **2026-09-13 (사용자 결정) — 같은 시설의 작업대만.** 리스트는 지금 작업대(`active`, 없으면 빠른제작)가 속한
   * **시설**(`benchFacility` — `data/furniture.csv` 의 `room`)의 작업대만 보여 준다.
   */
  private buildBenches(active: BenchPick): void {
    const housing = this.sys.ctx.housing;
    const bench = this.sys.getBench();
    /*
     * 지금 **열고 들어온** 작업대는 `ctx.housing` 이 뭐라 하든 목록에 있고 그 레벨로 선다 — 제목이
     * `가공 작업대 Lv.3` 인데 왼쪽 리스트에는 그 줄이 없어 아무것도 선택돼 있지 않은 화면이 나올 수 있다
     * (남의 함선 · 공유 함선처럼 가구가 `ctx.housing`(= 내 함선) 밖에 있는 경우).
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
          this.selected = null;          // 다른 작업대의 레시피는 남아 있을 이유가 없다
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
    for (const cell of this.cells) cell.el.classList.toggle('is-crafting', cell.recipe.id === job.recipeId);
    this.detail.paintProgress(this.detail.recipeId === job.recipeId ? job.progress : 0);
  }

  /** 왼쪽 목록: 산출물 썸네일만의 격자. 누르면 오른쪽 상세가 그 레시피로 바뀐다. */
  private build(recipes: readonly BenchRecipeRow[]): void {
    this.listEl.innerHTML = '';
    this.cells = [];
    for (const { recipe, locked } of recipes) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'inv-craft-cell';
      cell.dataset.recipe = recipe.id;
      if (locked) cell.classList.add('is-bench-locked');

      const out = this.getDef(recipe.outputDefId);
      cell.title = out ? `${out.name} ×${recipe.outputQty}` : recipe.name;
      if (out) {
        /*
         * 2026-09-09: **한 칸 고정.** 산출물을 실제 격자 크기로 그리니 4×2 돌격소총이 탄약 한 칸의 네 배로
         * 벌어져 목록이 무너졌다 (사용자 보고). 여기서 알아야 할 것은 "무엇이 나오는가"이고, 몇 칸을 먹는지는
         * 오른쪽 상세의 스펙 카드가 말한다. 스택 수량 배지는 1×1 타일도 그대로 그린다.
         */
        const tile = document.createElement('div');
        const item = this.sys.loot.createItem(out.id, Math.min(out.stackMax, recipe.outputQty));
        buildTileContent(tile, item, out, 1, 1, null, CELL);
        cell.appendChild(tile);
        // A stacking def draws its own count; one that does not stack but is made in twos needs the badge.
        if (out.stackMax <= 1 && recipe.outputQty > 1) {
          const badge = document.createElement('div');
          badge.className = 'inv-craft-thumb-qty';
          badge.textContent = `×${recipe.outputQty}`;
          cell.appendChild(badge);
        }
      }
      if (locked) {
        const tag = document.createElement('span');
        tag.className = 'inv-craft-locktag';
        tag.textContent = TEXT.bench.lockedLevel(recipe.benchLevel ?? 1);
        cell.appendChild(tag);
      }
      cell.addEventListener('click', () => this.select(recipe.id));
      this.listEl.appendChild(cell);
      this.cells.push({ recipe, locked, el: cell });
    }
    // 고른 것이 목록에서 사라졌으면 비운다 — `paint()` 가 첫 칸을 다시 고른다
    if (this.selected && !this.cells.some((c) => c.recipe.id === this.selected)) this.selected = null;
  }

  /** 왼쪽 칸을 고른다 (홀드 중에는 무시 — 누르고 있는 버튼이 다른 레시피로 바뀌면 안 된다). */
  private select(recipeId: string): void {
    if (this.holding || this.selected === recipeId) return;
    this.selected = recipeId;
    this.sys.sfx('ui_pickup');
    this.paint();
  }

  /**
   * **2026-09-10 — 지금 만들 수 있는 것이 위로.** 재료 · 숙련도 · 작업대 레벨을 전부 만족한 칸이 먼저 오고,
   * 그 안에서는 **원래 순서(csv 순서)를 유지**한다 (안정 정렬).
   *
   * - 숙련도는 애초에 `getRecipes` 가 걸러 목록에 없고, 작업대 레벨은 `locked` 다. 그래서 여기서 볼 것은
   *   `!locked && canCraft(id, 1)` 하나뿐이다 — **한 번이라도 만들 수 있나**이지 상세의 수량이 아니다.
   * - 넣을 자리(`craftHasRoom`)는 보지 **않는다**: 가방 · 창고가 찬 것은 레시피의 성질이 아니고, 상세 패널의
   *   버튼이 이미 이유를 말하고 있다.
   * - `paint()` 안에서 도므로 재료를 넣거나 빼면 (→ `afterChange` → `InventoryUI.refresh`) 정렬이 곧바로 따라온다.
   * - **홀드 중에는 칸을 움직이지 않는다.** 누르는 버튼은 오른쪽 상세에 있으므로 목록이 흔들려도 홀드가 풀리지는
   *   않지만, 눈앞에서 그림이 튀는 것은 그것대로 나쁘다.
   */
  private applySort(): void {
    if (this.holding || this.cells.length < 2) return;
    const order = this.cells
      .map((cell, i) => ({ cell, i, ready: !cell.locked && this.sys.canCraft(cell.recipe.id, 1) }))
      .sort((a, b) => (a.ready === b.ready ? a.i - b.i : a.ready ? -1 : 1));
    const sig = order.map((o) => o.cell.recipe.id).join('|');
    if (sig === this.sortSig) return;
    this.sortSig = sig;
    for (const o of order) this.listEl.appendChild(o.cell.el);
  }

  private paint(): void {
    this.applySort();
    const job = this.sys.craftProgress();
    // 고른 것이 없으면 **맨 앞 칸**을 고른다 (정렬 뒤라 「지금 만들 수 있는 것」이 맨 앞이고, 튜토리얼처럼
    // 레시피가 하나뿐인 목록에서는 그 하나다 — 스포트라이트가 상세의 버튼을 곧바로 찾는다).
    if (!this.selected) {
      const first = (this.listEl.firstElementChild as HTMLElement | null)?.dataset.recipe ?? this.cells[0]?.recipe.id ?? null;
      this.selected = first;
    }
    const picked = this.cells.find((c) => c.recipe.id === this.selected) ?? null;
    for (const cell of this.cells) {
      const active = job?.recipeId === cell.recipe.id;
      const ok = !cell.locked && this.sys.canCraft(cell.recipe.id, 1);
      cell.el.classList.toggle('is-locked', !ok);
      cell.el.classList.toggle('is-on', cell.recipe.id === this.selected);
      cell.el.classList.toggle('is-crafting', active);
    }
    this.detail.show(picked?.recipe ?? null, picked?.locked ?? false);
    this.detail.paint();
  }

  /* ── hold to craft ────────────────────────────────────────────────────── */

  private press(recipeId: string): void {
    if (this.holding) return;
    this.holding = recipeId;
    window.addEventListener('pointerup', this.onWindowUp);
    window.addEventListener('pointercancel', this.onWindowUp);
    // 2026-09-09: the hold buys `count` runs at once (`InventoryRef.craft(id, targetUid?, count)`) — still one
    // `CRAFT_HOLD_TIME`, however many runs it pays for.
    const count = this.detail.recipeId === recipeId ? this.detail.count : 1;
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
    this.detail.dispose();
    this.el.remove();
  }
}

/* ══ 오른쪽 상세 패널 ════════════════════════════════════════════════════════════════════════════════════════ */

interface CraftDetailHooks {
  /** 홀드 버튼을 눌렀다. */
  onPress(recipeId: string): void;
  /** 홀드 버튼에서 손(커서)이 떠났다. */
  onRelease(): void;
  /** 이 레시피가 지금 홀드 중인가 (스테퍼를 얼린다). */
  isHolding(recipeId: string): boolean;
  /** 수량이 바뀌었다 (소리 한 번). */
  onCountChanged(): void;
}

/**
 * **고른 레시피 하나의 상세 카드** (2026-09-15 2차, 사용자 결정).
 *
 * 조리대 화면(`housing`)이 같은 카드를 쓰고 싶으면 이 클래스를 그대로 `new` 해서 `el` 을 붙이면 된다 —
 * 공개 규약은 `CraftDetailHandle` 이다. 여기서는 **인벤토리 시스템에만** 묻는다 (`craftCost` · `craftCountDef` ·
 * `maxCraftCount` · `canCraft` · `craftHasRoom` · `craftProgress`).
 *
 * 설명 · 스펙 줄은 **직접 그리지 않는다**: `ui/Tooltip` 의 아이템 카드를 이 패널 안에 붙여
 * (`.inv-tooltip.is-embedded`) 그대로 쓴다 — 무기 게이지 · 내구도 · 소켓 · 무게 · 가치가 호버 카드와 글자 하나까지
 * 같아야 하고, 스펙 조립 규칙을 두 번 적지 않는다는 뜻이기도 하다 (「같은 수식을 두 폴더가 쓰면 shared 로 뽑는다」의 결).
 */
/* 2026-09-15 3차: 조리대 화면(`housing/ui/cook`)이 같은 상세 패널을 쓰도록 공개한다 — 홀드 버튼의 동작만 `hooks` 로 갈아 끼운다. */
export class CraftDetail implements CraftDetailHandle {
  readonly el: HTMLElement;
  private recipe: CraftRecipe | null = null;
  private locked = false;
  private readonly thumbEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly kindEl: HTMLElement;
  private readonly specHost: HTMLElement;
  private readonly spec: Tooltip;
  private readonly ownedEl: HTMLElement;
  private readonly costsEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly lessBtn: HTMLButtonElement;
  private readonly moreBtn: HTMLButtonElement;
  private readonly button: HTMLButtonElement;
  private readonly fill: HTMLElement;
  private readonly labelEl: HTMLElement;
  private readonly capEl: HTMLElement;
  /** Runs of the recipe one hold buys (≥ 1). Reset to 1 whenever the shown recipe changes. */
  private runs = 1;
  /** 마지막으로 스펙 카드를 그린 산출물 id — 같은 것이면 다시 만들지 않는다 (카드 하나가 DOM 백 줄이다). */
  private specDefId: string | null = null;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    private readonly hooks: CraftDetailHooks,
  ) {
    // ⚠ `.inv-craft-row` 라는 이름을 함께 갖는다 — 튜토리얼 스포트라이트가
    //   `.inv-craft-row[data-recipe="…"] .inv-craft-btn` 으로 홀드 버튼을 찾는다 (`src/tutorial/Steps.ts`).
    this.el = document.createElement('div');
    this.el.className = 'inv-craft-detail inv-craft-row';

    /* ① 산출물 썸네일 + 이름 · 종류 */
    const head = document.createElement('div');
    head.className = 'inv-craft-dhead';
    this.thumbEl = document.createElement('div');
    this.thumbEl.className = 'inv-craft-thumb';
    const titles = document.createElement('div');
    titles.className = 'inv-craft-dtitles';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'inv-craft-name';
    this.kindEl = document.createElement('div');
    this.kindEl.className = 'inv-craft-dkind';
    titles.append(this.nameEl, this.kindEl);
    head.append(this.thumbEl, titles);

    /* ② 설명 · 스펙 — 아이템 툴팁 카드를 그대로 붙인다 */
    this.specHost = document.createElement('div');
    this.specHost.className = 'inv-craft-spec';
    this.spec = new Tooltip(inventoryTooltipLookups(this.sys, this.sys.ctx));
    /*
     * ⚠ **클래스를 갈아 끼운다** (`inv-tooltip` → `inv-tt-card is-embedded`). 이 카드는 `.inv-layout` 안,
     * 즉 떠다니는 호버 카드보다 **DOM 앞**에 산다 — 이름을 그대로 두면 `document.querySelector('.inv-tooltip')`
     * 가 이 카드를 먼저 집는다 (「새 오버레이는 떠다니는 카드 **뒤**에 붙인다」 규약이 지키려던 바로 그것이다).
     * `Tooltip.show()` 는 `className` 을 건드리지 않으므로(`innerHTML` 과 `--rc` 만 쓴다) 한 번 갈아 끼우면 끝이고,
     * 카드 **안쪽** 클래스(`.inv-tt-*`)는 그대로라 스타일과 A 의 스펙 줄 개편이 전부 그대로 온다.
     */
    this.spec.el.className = 'inv-tt-card is-embedded';
    this.specHost.appendChild(this.spec.el);

    /* ③ 현재 보유 수 */
    this.ownedEl = document.createElement('div');
    this.ownedEl.className = 'inv-craft-owned';

    /* ④ 재료 썸네일 — 「재료 부족: …」 글자 줄은 없다 (사용자 결정): 모자란 것은 칩이 빨갛게 말한다 */
    this.costsEl = document.createElement('div');
    this.costsEl.className = 'inv-craft-costs';
    // 2026-09-14 (사용자 결정): 필요 아이템 칩의 호버 카드는 커서 **좌상단**이다 — `ui/hud/ItemTip` 이 이 속성을
    // `closest` 로 읽는다 (폴더 간 import 금지라 상수를 가져오지 않고 속성 이름만 쓴다).
    this.costsEl.dataset.tipAnchor = 'left';

    /* ⑤ 가로 수량 조절 — `지금 목표 / 최대` */
    const stepper = document.createElement('div');
    stepper.className = 'inv-craft-count';
    stepper.title = TEXT.craftCount.hint;
    this.lessBtn = document.createElement('button');
    this.lessBtn.type = 'button';
    this.lessBtn.className = 'inv-craft-step';
    this.lessBtn.textContent = '◀';
    this.lessBtn.title = TEXT.craftCount.less;
    this.countEl = document.createElement('span');
    this.countEl.className = 'inv-craft-count-v';
    this.moreBtn = document.createElement('button');
    this.moreBtn.type = 'button';
    this.moreBtn.className = 'inv-craft-step';
    this.moreBtn.textContent = '▶';
    this.moreBtn.title = TEXT.craftCount.more;
    stepper.append(this.lessBtn, this.countEl, this.moreBtn);

    /* ⑥ 길게 눌러 제작 */
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'inv-btn inv-craft-btn';
    this.fill = document.createElement('i');
    this.fill.className = 'inv-craft-fill';
    // 2026-09-15 2차 (사용자 결정): 「길게 눌러」는 글자가 아니라 라벨 왼쪽의 좌클릭 홀드 키캡이 말한다.
    this.capEl = createHoldButtonCap();
    this.labelEl = document.createElement('span');
    this.labelEl.textContent = TEXT.craftHold;
    this.button.append(this.fill, this.capEl, this.labelEl);

    this.el.append(head, this.specHost, this.ownedEl, this.costsEl, stepper, this.button);

    this.button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.recipe || this.locked) return;
      e.preventDefault();
      this.hooks.onPress(this.recipe.id);
    });
    this.button.addEventListener('pointerleave', () => this.hooks.onRelease());
    this.lessBtn.addEventListener('click', (e) => { e.stopPropagation(); this.step(-1); });
    this.moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this.step(1); });
    // Non-passive: the list underneath must not scroll while the wheel is spending itself on the count.
    stepper.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  get recipeId(): string | null { return this.recipe?.id ?? null; }
  get count(): number { return this.runs; }

  /**
   * 이 레시피를 그린다. **같은 레시피면 아무것도 다시 만들지 않는다** — `paint()` 가 매 `InventoryUI.refresh()`
   * 마다 여기를 지나므로, 썸네일 · 스펙 카드를 그때마다 새로 조립하면 카드 하나가 DOM 백 줄이라 그대로 비용이 된다.
   */
  show(recipe: CraftRecipe | null, locked: boolean): void {
    const same = !!recipe && recipe.id === this.recipe?.id;
    this.recipe = recipe;
    this.el.hidden = !recipe;
    if (!recipe) { this.locked = false; delete this.el.dataset.recipe; return; }
    if (same && locked === this.locked) return;
    this.locked = locked;
    if (!same) {
      this.runs = 1;
      this.el.dataset.recipe = recipe.id;
    }
    this.el.classList.toggle('is-bench-locked', locked);
    const out = this.getDef(recipe.outputDefId);
    /* 썸네일 · 이름 · 종류 */
    this.thumbEl.replaceChildren();
    if (out) {
      // `data-item-tip` + `data-def-id` is what `ui/hud/ItemTip` delegates on — the same hover card the cost chips get
      this.thumbEl.dataset.itemTip = '';
      this.thumbEl.dataset.defId = out.id;
      const tile = document.createElement('div');
      const item = this.sys.loot.createItem(out.id, Math.min(out.stackMax, recipe.outputQty));
      buildTileContent(tile, item, out, 1, 1, null, CELL);
      this.thumbEl.appendChild(tile);
      if (out.stackMax <= 1 && recipe.outputQty > 1) {
        const badge = document.createElement('div');
        badge.className = 'inv-craft-thumb-qty';
        badge.textContent = `×${recipe.outputQty}`;
        this.thumbEl.appendChild(badge);
      }
    }
    this.nameEl.textContent = out ? `${out.name} ×${recipe.outputQty}` : recipe.name;
    this.kindEl.textContent = out ? kindLine(out) : '';
    /* 설명 · 스펙 — 산출물이 바뀔 때만 다시 조립한다 */
    if (out && this.specDefId !== out.id) {
      this.specDefId = out.id;
      const sample = this.sys.loot.createItem(out.id, Math.min(out.stackMax, Math.max(1, recipe.outputQty)));
      this.spec.show(sample, out, 0, 0);
    } else if (!out) {
      this.specDefId = null;
      this.spec.hide();
    }
  }

  paint(): void {
    const r = this.recipe;
    if (!r) return;
    const job = this.sys.craftProgress();
    const active = job?.recipeId === r.id;
    // 2026-09-09 (제작 수량): the count is clamped on every paint — spending materials elsewhere (or a craft that
    // just consumed its own) lowers the ceiling, and a stale `n` would then only fail at the end of the hold.
    const max = Math.max(1, this.sys.maxCraftCount(r.id));
    if (!active && this.runs > max) this.runs = max;
    const n = this.runs;

    const ok = !this.locked && this.sys.canCraft(r.id, n);
    /*
     * 2026-09-09 (사용자 결정) — **넣을 자리부터 본다.** 재료가 다 있어도 산출물이 들어갈 칸이 없으면 1초를
     * 눌러 봐야 홀드 끝에서 거절당했다. 함선이면 창고 → 가방, 레이드 현장이면 가방만이다 (`roomForOutputs`).
     */
    const room = ok && this.sys.craftHasRoom(r.id, n);
    const ship = this.sys.ctx.isHubPhase();
    this.el.classList.toggle('is-locked', !ok);
    this.el.classList.toggle('is-nospace', ok && !room);
    this.button.disabled = this.locked || ((!ok || !room) && !active);
    this.button.title = ok && !room ? (ship ? TEXT.craftNoRoomTipShip : TEXT.craftNoRoomTipField) : '';

    /* ③ 현재 보유 수 — 재료를 세는 범위와 같다 (함선 = 가방 + 함선 창고, 현장 = 가방) */
    this.ownedEl.textContent = TEXT.craftOwned(this.sys.craftCountDef(r.outputDefId));

    /* ④ 재료 썸네일 — 필요량은 지금 수량을 곱한 값이다 */
    const cost = this.sys.craftCost(r).map((i) => ({ defId: i.defId, qty: i.qty * n }));
    renderItemCost(this.costsEl, cost, this.getDef, (id) => this.sys.craftCountDef(id), { size: 34 });

    /* ⑤ 수량 — `지금 목표 / 최대` (사용자 결정). 단위는 예전과 같은 **총 산출 개수**다. */
    this.countEl.textContent = `${r.outputQty * n} / ${r.outputQty * max}`;
    this.el.classList.toggle('is-multi', n > 1);
    this.lessBtn.disabled = this.locked || active || n <= 1;
    this.moreBtn.disabled = this.locked || active || n >= max;

    /* ⑥ 버튼 */
    this.el.classList.toggle('is-crafting', active);
    this.fill.style.width = active ? `${Math.round((job?.progress ?? 0) * 100)}%` : '0%';
    this.labelEl.textContent = this.locked ? TEXT.bench.lockedLevel(r.benchLevel ?? 1)
      : active ? TEXT.craftMaking
      : ok && !room ? (ship ? TEXT.craftNoRoomShip : TEXT.craftNoRoomField)
      : TEXT.craftHold;
    // 눌러도 소용없는 상태(재료 · 자리 부족)에서 「꾹 누르세요」 그림을 보여 주면 거짓말이다.
    this.capEl.style.display = this.button.disabled ? 'none' : '';
  }

  paintProgress(progress: number): void {
    const active = progress > 0;
    this.el.classList.toggle('is-crafting', active);
    this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  }

  /**
   * 2026-09-09 — move the 제작 수량 by `dir`, clamped to 1 … `maxCraftCount` (what the owned materials pay for).
   * A running craft owns the count it started with, so the stepper is inert while this row is holding.
   */
  private step(dir: number): void {
    const r = this.recipe;
    if (!r || this.locked || this.hooks.isHolding(r.id)) return;
    const max = Math.max(1, this.sys.maxCraftCount(r.id));
    const next = Math.max(1, Math.min(max, this.runs + dir));
    if (next === this.runs) return;
    this.runs = next;
    this.hooks.onCountChanged();
    this.paint();
  }

  dispose(): void {
    this.spec.dispose();
    this.el.remove();
  }
}

/**
 * `돌격소총 · 고급` / `탄약 · 일반` — 상세 머리의 **종류** 줄.
 * 무기는 계열 이름(전설 유니크는 자기 종류 — `labels.weaponClassLabel`, 2026-09-15), 나머지는 카테고리 이름이다.
 */
function kindLine(def: ItemDef): string {
  const w = def.weaponId ? getWeaponDef(def.weaponId) : undefined;
  return `${w ? weaponClassLabel(w) : categoryLabel(def)} · ${rarityLabel(def)}`;
}
