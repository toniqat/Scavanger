import type { ItemDef, LoadoutSlot } from '@/shared';
import { renderItemCost } from '@/shared';
import type { BenchRepairRow, InventorySystem } from '../InventorySystem';
import { Modeless } from './Modeless';
import { SLOT_LABEL, TEXT } from './labels';

/**
 * **장비 수리 팝업** (2026-09-08).
 *
 * 수리는 작업대 패널 **하단의 목록**이었다 — 레시피를 읽으려고 연 화면의 절반을, 지금 고칠 생각이 없는 장비가
 * 늘 차지하고 있었다. 이제 작업대 헤더의 `모두 수리`(닫기 왼쪽)가 이 팝업을 연다:
 *
 *   - **목록** — 닳은 장비 한 줄에 하나(`benchRepairRows(wornOnly)`). 가로로 긴 패널이고, 이름 아래에 내구도
 *     막대와 `현재 / 최대`, 오른쪽에 그 하나를 고치는 데 드는 재료 칩, 맨 오른쪽에 **×**.
 *   - **×** — 그 항목만 `모두 수리`에서 뺀다(줄은 남고 흐려진다, 다시 누르면 돌아온다). 팝업을 닫으면 초기화된다
 *     (사용자 결정) — 한 번의 `모두 수리`를 위한 임시 선택이지 저장하는 설정이 아니다.
 *   - **소모 재료** — 목록 아래에 제외를 뺀 **합계**를 `보유/필요` 칩으로. × 를 누를 때마다 그 자리에서 다시 센다.
 *
 * 개별 수리는 아이템 우클릭 메뉴의 `수리` 가 갖는다 (`ui/parts/ContextMenu`) — 이 팝업은 일괄 작업만 한다.
 *
 * 모달처럼 보이지만 셸은 다른 팝업과 같은 `Modeless` 다: blocker 도 포인터 락도 건드리지 않고(창이 이미 둘 다
 * 쥐고 있다), Escape · 닫기 · 바깥 클릭으로 닫힌다. 뒤를 덮는 어두운 판(`scrim`)만 이 파일이 따로 갖는다.
 */
export class RepairPanel {
  /** 팝업 프레임 + 뒤를 덮는 판을 함께 담는 껍데기 (`InventoryUI.modelessLayer` 에 붙는다). */
  readonly el: HTMLElement;
  private readonly shell: Modeless;
  private readonly scrim: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly totalEl: HTMLElement;
  private readonly totalChips: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly msgEl: HTMLElement;
  private msgTimer: number | null = null;
  /** × 로 이번 열림에서 뺀 항목들 (닫으면 비운다). */
  private excluded = new Set<string>();

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
  ) {
    // 닫기 버튼 · 바깥 클릭으로 셸이 스스로 닫힐 때도 뒤를 덮는 판과 제외 표시를 같이 치운다
    this.shell = new Modeless('repair', () => this.afterClose());
    this.shell.withHeader(TEXT.bench.repairEyebrow, TEXT.bench.repairModal);

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-repair-list';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.bench.repairNone;

    this.totalEl = document.createElement('div');
    this.totalEl.className = 'inv-rep-total';
    const totalCap = document.createElement('div');
    totalCap.className = 'inv-eyebrow';
    totalCap.textContent = TEXT.bench.repairTotal;
    this.totalChips = document.createElement('div');
    this.totalChips.className = 'inv-rep-total-chips';
    this.totalEl.append(totalCap, this.totalChips);

    this.msgEl = document.createElement('div');
    this.msgEl.className = 'inv-repair-msg';
    this.msgEl.hidden = true;

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'inv-rep-hint';
    this.hintEl.textContent = TEXT.bench.repairHint;

    this.runBtn = document.createElement('button');
    this.runBtn.type = 'button';
    this.runBtn.className = 'inv-btn inv-repair-all';
    this.runBtn.textContent = TEXT.bench.repairAll;
    this.runBtn.addEventListener('click', () => this.runAll());

    this.shell.body.append(this.listEl, this.emptyEl, this.totalEl, this.msgEl, this.hintEl, this.runBtn);

    // 뒤를 덮는 판. 클릭은 `Modeless` 의 document 리스너가 "바깥"으로 보고 닫아 준다.
    this.scrim = document.createElement('div');
    this.scrim.className = 'inv-rep-scrim';
    this.scrim.hidden = true;

    this.el = document.createElement('div');
    this.el.className = 'inv-rep-host';
    this.el.append(this.scrim, this.shell.el);
  }

  get isOpen(): boolean { return this.shell.isOpen; }

  /** 작업대 헤더의 `모두 수리`. 화면 한가운데에 뜬다 (anchor 는 그 버튼의 클릭을 "바깥"에서 빼기 위한 것뿐). */
  open(anchor: HTMLElement | null = null): void {
    if (this.shell.isOpen) { this.close(); return; }
    this.excluded.clear();
    this.hideMsg();
    this.scrim.hidden = false;
    this.shell.open(anchor, true);
    this.refresh();
    // 2026-09-09 키 가이드: mouse-only popup, so the line is the close entry alone (Tab closes this before the window)
    this.sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.repair', keys: [] });
  }

  /** Escape · 창이 닫힐 때. 열려 있었으면 true (Escape 가 소비된다). */
  close(): boolean {
    const was = this.shell.close();
    this.afterClose();
    return was;
  }

  /** 셸이 스스로 닫힌 뒤(닫기 버튼 · 바깥 클릭)와 `close()` 둘 다가 지나가는 뒤처리. */
  private afterClose(): void {
    const wasUp = !this.scrim.hidden;
    this.scrim.hidden = true;
    this.excluded.clear();
    this.hideMsg();
    if (wasUp) this.sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.repair', keys: null });
  }

  /** 목록 · 합계 · 버튼을 지금 상태로 다시 그린다 (열려 있을 때만). */
  refresh(): void {
    if (!this.shell.isOpen) return;
    const rows = this.sys.benchRepairRows(true);
    // 사라진 항목의 제외 표시는 같이 지운다 (수리되어 목록에서 빠졌거나, 버려졌거나)
    const live = new Set(rows.map((r) => r.uid));
    for (const uid of [...this.excluded]) if (!live.has(uid)) this.excluded.delete(uid);

    this.listEl.replaceChildren();
    for (const r of rows) this.listEl.appendChild(this.buildRow(r));
    this.emptyEl.hidden = rows.length > 0;
    this.listEl.hidden = rows.length === 0;

    const picked = rows.filter((r) => !this.excluded.has(r.uid));
    this.paintTotal(picked);
    this.runBtn.textContent = TEXT.bench.repairRun(picked.length);
    this.runBtn.disabled = picked.length === 0;
    this.shell.place();
  }

  private buildRow(r: BenchRepairRow): HTMLElement {
    const max = Math.max(1, r.dur.max);
    const cur = Math.max(0, Math.min(max, r.dur.durability));
    const frac = cur / max;
    const off = this.excluded.has(r.uid);

    const row = document.createElement('div');
    row.className = `inv-repair-row${cur <= 0 ? ' is-broken' : ''}${off ? ' is-excluded' : ''}${r.short ? ' is-short-row' : ''}`;
    row.dataset.uid = r.uid;

    const where = document.createElement('div');
    where.className = 'inv-repair-slot';
    where.textContent = r.where ? SLOT_LABEL[r.where as LoadoutSlot] : TEXT.bag;

    const mid = document.createElement('div');
    mid.className = 'inv-repair-mid';
    const name = document.createElement('div');
    name.className = 'inv-repair-name';
    name.textContent = off ? `${r.def.name} · ${TEXT.bench.repairExcluded}`
      : cur <= 0 ? `${r.def.name} · ${TEXT.broken}` : r.def.name;
    const bar = document.createElement('div');
    bar.className = `inv-repair-bar ${frac > 0.5 ? 'ok' : frac > 0.2 ? 'warn' : 'low'}`;
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(frac * 100)}%`;
    bar.appendChild(fill);
    const text = document.createElement('div');
    text.className = 'inv-repair-dur';
    text.textContent = `${Math.round(cur)} / ${Math.round(max)}`;
    mid.append(name, bar, text);

    const cost = document.createElement('div');
    cost.className = `inv-repair-cost${r.short ? ' is-short' : ''}`;
    const have = new Map(r.cost.map((c) => [c.defId, c.have]));
    renderItemCost(cost, r.cost, this.getDef, (id) => have.get(id) ?? 0, { size: 28 });

    // × — 그 항목만 `모두 수리`에서 뺀다 (다시 누르면 되돌린다)
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'inv-repair-drop';
    drop.textContent = off ? '+' : '×';
    drop.title = off ? TEXT.bench.repairKeep : TEXT.bench.repairDrop;
    drop.addEventListener('click', () => {
      if (this.excluded.has(r.uid)) this.excluded.delete(r.uid); else this.excluded.add(r.uid);
      this.sys.sfx('ui_drop');
      this.refresh();
    });

    row.append(where, mid, cost, drop);
    return row;
  }

  /** 제외를 뺀 합계 재료 (`보유/필요`). 같은 재료를 쓰는 두 장비는 한 칩으로 합쳐진다. */
  private paintTotal(rows: readonly BenchRepairRow[]): void {
    const need = new Map<string, number>();
    const have = new Map<string, number>();
    for (const r of rows) {
      for (const c of r.cost) {
        need.set(c.defId, (need.get(c.defId) ?? 0) + c.qty);
        have.set(c.defId, c.have);
      }
    }
    const cost = [...need].map(([defId, qty]) => ({ defId, qty }));
    this.totalChips.replaceChildren();
    if (cost.length === 0) {
      const none = document.createElement('div');
      none.className = 'inv-rep-total-none';
      none.textContent = TEXT.bench.repairTotalNone;
      this.totalChips.appendChild(none);
      return;
    }
    renderItemCost(this.totalChips, cost, this.getDef, (id) => have.get(id) ?? 0, { size: 30 });
  }

  private runAll(): void {
    const { done, skipped } = this.sys.benchRepairAll(this.excluded);
    this.sys.sfx(done > 0 ? 'ui_equip' : 'ui_error');
    this.showMsg(TEXT.bench.repairAllResult(done, skipped), done > 0 ? 'ok' : 'bad');
    this.refresh();
  }

  private showMsg(text: string, kind: 'ok' | 'bad'): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `inv-repair-msg is-${kind}`;
    this.msgEl.hidden = false;
    if (this.msgTimer !== null) clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.hideMsg(), 3000);
  }

  private hideMsg(): void {
    if (this.msgTimer !== null) { clearTimeout(this.msgTimer); this.msgTimer = null; }
    this.msgEl.hidden = true;
  }

  dispose(): void {
    this.hideMsg();
    this.shell.dispose();
    this.el.remove();
  }
}
