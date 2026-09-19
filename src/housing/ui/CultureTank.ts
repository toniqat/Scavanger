import type { CultureSlotInfo, EmbeddedView, GameContext, HarvestDestination, HoldAskHandle, ItemDef, ItemInstance, PlacedFurniture } from '@/shared';
import { cultureSlotsForLevel, openHoldAsk } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { SocketAsk, paintSocketDots, socketTipRows } from './SocketFlow';
import { StationMenu } from './StationMenu';
import type { StationMenuItem } from './StationMenu';
import { StationTip } from './StationTip';
import type { TipRow, TipSpec } from './StationTip';
import { buildStationShell, mountStationGrids, paintStationLevel } from './StationShell';
import type { StationGridsView, StationShell } from './StationShell';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import { clear, clockText, el, renderClock, renderClockText, setText, toggleClass } from './dom';

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;
/** Fallback fluid colour when a medium def carries none. */
const FLUID_FALLBACK = '#8fe8ff';
const fin = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** The medium's bonus ratio (0 … 1). Read as 1 on an old build whose contract field is not there yet. */
const mediumRatio = (info: CultureSlotInfo): number => {
  const r = fin(info.mediumBonusRatio);
  return r === null ? 1 : Math.max(0, Math.min(1, r));
};

interface TankCard {
  slot: number;
  wrap: HTMLElement;
  cell: HTMLElement;
  fluid: HTMLElement;
  /** The culture scaffold's grid pattern (2026-09-13) — shown only while one is in. */
  scaffold: HTMLElement;
  /** The socket dots inside the glass (2026-09-13). */
  socks: HTMLElement;
  glyph: HTMLElement;
  name: HTMLElement;
  time: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  /** 2026-09-17: the 「배양 시작」 button under the tube — enabled only on a not-yet-started slot holding a medium + a strain (→ a 1 s hold confirm). */
  start: HTMLButtonElement;
  /** Medium id painted last time (`''` = none, `null` = never painted) — a null → medium change plays the rising fluid. */
  medium: string | null;
}

/** 2026-09-17: one row of the tank list on the left (`.hs-rail-item`) — name + one dot per tube + the red dot (the same grain as the grow station list). */
interface TankRailItem {
  uid: string;
  el: HTMLElement;
  dots: HTMLElement[];
  red: HTMLElement;
}

/** The mark the smoke test · CSS find the culture start confirm popup by (`.sh-ask[data-ask]`). */
export const CULTURE_START_ASK_ID = 'cult-start';

/**
 * **The culture screen** (culture tank A-14, 2026-09-11 · screen rework 2026-09-12 · culture tubes 2026-09-13 — `openCultureTank(uid)` ← E on a culture tank).
 *
 * The frame is the shared `StationShell` and **the harvest rules are exactly the grow station's** (user's decision): a finished
 * slot is **double-click = the ship stash first · drag onto a grid = that grid** (`ProductDrag`), clearing the medium is the
 * **right-click menu** (`StationMenu`), and the detail is the **hover card** (`StationTip`).
 *
 * **2026-09-13 (user's decision)**: the slots stand as **three tall glass culture tubes side by side** — always 3 columns, and a
 * tube the level has not opened yet is a dashed empty tube + `Lv.N 필요`. One tube = the cap (`.cult-cap`) · the glass
 * (`.cult-cell[data-slot]` = the drop target) · the base (`.cult-base`). A strain that goes in floats its glyph in the fluid.
 * Under the tube = name · `HH:MM:SS` (or 「수확 가능」 · the medium durability) · the progress bar. A medium dropped **on that tube** fills that one tube and the fluid runs up once (transforms only).
 *
 * **2026-09-13 (cooking material tiers)**: a medium carries **durability** and the slot does not empty on harvest — **the fluid level = the medium durability ÷ its maximum**.
 * The slot order is **medium → (culture scaffold) → strain**; the scaffold shows as a **grid pattern** inside the glass
 * (`.cult-scaffold`), the medium sockets as **small dots** low in the glass (`SocketFlow.paintSocketDots`). Drops: a medium
 * `fillMedium` · a scaffold `insertScaffold` · a strain `insertStrain` · a medium socket takes the grow station screen's flow
 * (full = pick → a 1 s hold, `SocketAsk`). Right-click gives 「스캐폴드 빼기」 (`takeScaffold`) while there is no strain, and
 * 「배지 비우기」 on a slot with sockets goes through a 1 s hold warning. The hover card = medium · durability · culture speed (the ratio folded in) · sockets · scaffold · strain · time left · the product (meat of that species with a scaffold — housing folds it into `yieldDefId`).
 *
 * **2026-09-17 (user's decision)**: ① inserting a strain does not start the culture — the **「배양 시작」** button under the tube asks
 * 「배양을 시작하겠습니까?」 through the shared `openHoldAsk` (confirm = a `UI_HOLD_CONFIRM_S` hold, Enter does not confirm, Escape = cancel, initial focus = 취소),
 * and only a confirm lets `startCulture` start the timer. Before the start, right-click takes the strain · the scaffold · a new medium back. ② A ship may hold
 * several culture tanks, so the **leftmost rail** is the tank list (the same `.hs-rail-item` as the grow station list — name + a dot per tube + the red dot).
 */
export class CultureTank extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly slotsEl: HTMLElement;
  private readonly modal: UpgradeModal;
  private readonly tip: StationTip;
  private readonly menu: StationMenu;
  private readonly sockAsk: SocketAsk;
  private readonly drag: ProductDrag;
  private grids: StationGridsView | null = null;
  private cards: TankCard[] = [];
  private builtKey = '';
  private railItems: TankRailItem[] = [];
  private railKey = '';
  /** The open 「배양을 시작하겠습니까?」 (one at a time). Closing the screen or switching tank closes it without calling anything. */
  private startAsk: HoldAskHandle | null = null;
  /** Smoke test: confirms the open start ask with no hold. */
  startAskConfirm: (() => void) | null = null;
  private hoverSlot: number | null = null;
  private timer = 0;
  /** Smoke / perf counters. `fills` = rising-fluid animations started. */
  readonly debug = { builds: 0, paints: 0, fills: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'culture', 'culture-tank hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '배양조',
      upgrade: true,
      onUpgrade: () => this.openUpgrade(),
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    this.slotsEl = el('div', { cls: 'cult-slots', parent: this.shell.left });
    this.shell.rail.addEventListener('click', (e) => this.onRailClick(e));

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '배양은 현실 시간에 맞춰 진행됩니다 — 함선을 떠나도 계속 자랍니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.tip = new StationTip(this.root);
    this.menu = new StationMenu(this.root);
    this.sockAsk = new SocketAsk(ctx, this.menu);
    this.overlays.push(this.modal, this.menu, this.sockAsk);
    this.drag = new ProductDrag(this.slotsEl, {
      productAt: (t) => this.productAt(t),
      collect: (key, dest) => this.collect(Number(key), dest),
      defOf: (id) => housing.defOf(id),
      // 2026-09-16: it goes to **the very cell** it was dropped on (the grids are built when the screen opens, so they come as a function)
      grids: () => this.grids,
      onDragStart: () => this.hideTip(),
    });

    this.slotsEl.addEventListener('pointerover', (e) => this.onHover(e));
    this.slotsEl.addEventListener('pointermove', (e) => { if (this.hoverSlot !== null && !this.drag.dragging) this.tip.move(e.clientX, e.clientY); });
    this.slotsEl.addEventListener('pointerleave', () => this.hideTip());
    this.slotsEl.addEventListener('contextmenu', (e) => this.onContext(e));
    // the rising-fluid class is a one-shot animation — drop it when it ends so a later refill can replay it
    this.slotsEl.addEventListener('animationend', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.classList.contains('cult-fluid')) t.classList.remove('is-filling');
    });
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one culture tank. */
  openTank(uid: string): void {
    if (uid !== this.uid) this.builtKey = '';
    this.uid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.cult-cell[data-slot]', (item, target) => this.dropOn(item, target));
    this.startTicking();
  }

  override close(relock = true): void {
    this.closeStartAsk();
    this.stopTicking();
    this.hideTip();
    this.drag.end();
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the bag / stash onto a culture tube (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('배지 · 스캐폴드 · 세포주 · 배지 소켓을 배양관으로 끌어다 놓으세요', 'info'); return; }
    const slot = Number(target.dataset.slot);
    if (!Number.isInteger(slot)) { this.showMsg('없는 배양 칸입니다', 'warning'); return; }
    const def = this.housing.defOf(item.defId);
    if (!def) { this.showMsg('알 수 없는 아이템입니다', 'warning'); return; }
    let reason: string | null;
    let done: string;
    if (def.medium) {
      reason = this.housing.fillMedium(this.uid, slot, item.defId);
      done = `${def.name}을(를) 배양관 ${slot + 1}에 부었습니다`;
    } else if (def.strain) {
      reason = this.housing.insertStrain(this.uid, slot, item.defId);
      done = `${def.name}을(를) 배양관 ${slot + 1}에 넣었습니다 — 「배양 시작」을 누르면 배양이 시작됩니다`;
    } else if (def.scaffold) {
      reason = this.housing.insertScaffold(this.uid, slot, item.defId);
      done = `${def.name}을(를) 배양관 ${slot + 1}에 넣었습니다 — 이제 세포주를 넣으세요`;
    } else if (def.growSocket) {
      this.dropSocket(slot, def, target);
      return;
    } else {
      this.showMsg('영양 배지 · 배양 스캐폴드 · 세포주 · 배지 소켓만 넣을 수 있습니다', 'warning');
      return;
    }
    this.showMsg(reason ?? done, reason ? 'warning' : 'success');
  }

  /** A medium socket drop — the grow station screen's flow (only a full slot asks pick → a 1 s hold; every other judgement · reason is `insertCultureSocket`). */
  private dropSocket(slot: number, def: ItemDef, anchor: HTMLElement): void {
    const info = this.infoOf(slot);
    const sockets = info?.sockets ?? [];
    const slots = Math.max(0, Math.floor(fin(info?.socketSlots) ?? 0));
    const full = !!info && !!info.mediumDefId && def.growSocket?.target === 'medium' && slots > 0 && sockets.length >= slots;
    if (!full) { this.insertSocket(slot, def); return; }
    this.hideTip();
    this.sockAsk.askReplace({
      anchor,
      target: 'medium',
      newDef: def,
      sockets: sockets.slice(),
      ratio: mediumRatio(info),
      defOf: (id) => this.housing.defOf(id),
      nameOf: (id) => this.housing.nameOf(id),
      run: (i) => this.insertSocket(slot, def, i),
    });
  }

  private insertSocket(slot: number, def: ItemDef, replaceIndex?: number): void {
    const old = replaceIndex !== undefined ? this.infoOf(slot)?.sockets?.[replaceIndex] ?? null : null;
    const reason = this.housing.insertCultureSocket(this.uid, slot, def.id, replaceIndex);
    if (reason) { this.deny(reason); return; }
    this.showMsg(old ? `${this.housing.nameOf(old)} 파괴 · ${def.name}을(를) 끼웠습니다` : `${def.name}을(를) 끼웠습니다`, 'success');
  }

  private infoOf(slot: number): CultureSlotInfo | null {
    return this.housing.getCultureSlots(this.uid).find((i) => i.slot === slot) ?? null;
  }

  private slotAt(target: Element | null): number | null {
    const s = Number(target?.closest<HTMLElement>('.cult-slot[data-slot]')?.dataset.slot);
    return Number.isInteger(s) ? s : null;
  }

  private productAt(target: Element): Product | null {
    const slot = this.slotAt(target);
    const info = slot !== null ? this.infoOf(slot) : null;
    if (!info || !info.ready || !info.yieldDefId) return null;
    return { key: String(info.slot), defId: info.yieldDefId, qty: info.yieldQty };
  }

  private collect(slot: number, dest: HarvestDestination): void {
    const info = this.infoOf(slot);
    if (!info) return;
    const id = info.yieldDefId;
    const before = id ? this.housing.countDef(id) : 0;
    const reason = this.housing.harvestCulture(this.uid, slot, dest);
    if (reason) { this.deny(reason); return; }
    // 2026-09-13: a `yield` socket may add +1 — how many arrived is read as the bag + stash difference
    const got = id ? this.housing.countDef(id) - before : 0;
    const qty = got > 0 ? got : info.yieldQty;
    const bonus = got > info.yieldQty ? ` (추가 +${got - info.yieldQty})` : '';
    this.showMsg(`${id ? this.housing.nameOf(id) : '배양 산물'} ×${qty} 수확${bonus}`, 'success');
    this.hideTip();
  }

  private clearMedium(slot: number, discardStrain: boolean): void {
    const reason = this.housing.clearMedium(this.uid, slot, discardStrain);
    if (reason) { this.deny(reason); return; }
    this.showMsg(discardStrain ? '세포주를 버리고 배지를 비웠습니다' : '배지를 비웠습니다 (배지 · 소켓은 돌려받지 않습니다)', 'info');
  }

  /* ── starting a culture (2026-09-17) ───────────────────────────────────── */
  /** Why this slot cannot start right now (the button's `title`), null = it can. The original judgement is `startCulture` — this one is for the screen. */
  private startBlock(info: CultureSlotInfo): string | null {
    if (info.locked) return `배양조를 Lv.${info.unlockLevel} 로 강화해야 열립니다`;
    if (!info.mediumDefId) return '영양 배지를 먼저 채우세요';
    if (!info.strainDefId) return '세포주를 넣으면 배양을 시작할 수 있습니다';
    if (info.started) return info.ready ? '수확할 수 있습니다' : '배양 중입니다';
    return null;
  }

  /** 「배양 시작」 → 「배양을 시작하겠습니까?」 (a 1 s hold confirm). Only a confirm calls `startCulture`. */
  private askStart(slot: number): void {
    const info = this.infoOf(slot);
    if (!info) return;
    const block = this.startBlock(info);
    if (block) { this.deny(block); return; }
    this.hideTip();
    this.closeStartAsk();
    const h = this.housing;
    const lines = [`배지: ${h.nameOf(info.mediumDefId!)}`];
    if (info.scaffoldDefId) lines.push(`스캐폴드: ${h.nameOf(info.scaffoldDefId)}`);
    lines.push(`세포주: ${h.nameOf(info.strainDefId!)}`);
    const uid = this.uid;
    const run = (): void => {
      this.startAsk = null;
      this.startAskConfirm = null;
      if (!this.isOpen || this.uid !== uid) return;
      const reason = h.startCulture(uid, slot);
      if (reason) { this.deny(reason); return; }
      this.showMsg(`배양관 ${slot + 1} 배양을 시작했습니다`, 'success');
    };
    const clear = (): void => { this.startAsk = null; this.startAskConfirm = null; };
    const handle = openHoldAsk(this.ctx, {
      id: CULTURE_START_ASK_ID,
      title: '배양을 시작하겠습니까?',
      body: [
        `배양관 ${slot + 1}`,
        ...lines,
        '',
        '배양을 시작하면 넣은 영양 배지 · 세포주 · 스캐폴드는 다시 꺼낼 수 없습니다.',
      ].join('\n'),
      danger: true,
      buttons: [
        { label: '취소', cancel: true, run: clear },
        { label: '배양 시작', kind: 'danger', hold: true, run },
      ],
      onCancel: clear,
    });
    this.startAsk = handle;
    this.startAskConfirm = () => { if (!handle.isOpen) return; handle.close(); run(); };
  }

  /** Closes the open start ask **without calling anything** (when the screen closes · when the tank is switched). */
  private closeStartAsk(): void {
    const a = this.startAsk;
    this.startAsk = null;
    this.startAskConfirm = null;
    if (a?.isOpen) a.close();
  }

  private takeStrain(slot: number): void {
    const id = this.infoOf(slot)?.strainDefId ?? null;
    const reason = this.housing.takeStrain(this.uid, slot, 'bag-first');
    if (reason) { this.deny(reason); return; }
    this.showMsg(`${id ? this.housing.nameOf(id) : '세포주'}을(를) 돌려받았습니다`, 'info');
  }

  private takeMedium(slot: number): void {
    const id = this.infoOf(slot)?.mediumDefId ?? null;
    const reason = this.housing.takeMedium(this.uid, slot, 'bag-first');
    if (reason) { this.deny(reason); return; }
    this.showMsg(`${id ? this.housing.nameOf(id) : '영양 배지'}을(를) 돌려받았습니다`, 'info');
  }

  private takeScaffold(slot: number): void {
    const id = this.infoOf(slot)?.scaffoldDefId ?? null;
    const reason = this.housing.takeScaffold(this.uid, slot, 'bag-first');
    if (reason) { this.deny(reason); return; }
    this.showMsg(`${id ? this.housing.nameOf(id) : '배양 스캐폴드'}을(를) 돌려받았습니다`, 'info');
  }

  /** The medium durability maximum (the fluid height · the text). With no contract field it reads the old 「수확 횟수」. At least 1. */
  private mediumMax(info: CultureSlotInfo): number {
    const max = fin(info.mediumDurabilityMax);
    if (max !== null && max > 0) return max;
    const def = info.mediumDefId ? this.housing.defOf(info.mediumDefId) : undefined;
    return Math.max(1, Math.floor(def?.medium?.uses ?? 1), info.mediumUsesLeft);
  }

  /** The medium's current durability (the old uses left when there is none). */
  private mediumNow(info: CultureSlotInfo): number {
    const d = fin(info.mediumDurability);
    return d !== null && fin(info.mediumDurabilityMax) !== null ? d : info.mediumUsesLeft;
  }

  /* ── the upgrade modal ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!this.housing.getPlacedByUid(this.uid)) return;
    this.hideTip();
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  /** How many slots the next level opens is derived from the contract's `cultureSlotsForLevel`. */
  private upgradeSpec(): UpgradeSpec | null {
    const h = this.housing;
    const tank = h.getPlacedByUid(this.uid);
    const def = tank ? h.getFurnitureDef(tank.defId) : undefined;
    if (!tank || !def) return null;
    const level = tank.level;
    const opened = cultureSlotsForLevel(level + 1) - cultureSlotsForLevel(level);
    return {
      name: def.name,
      level,
      maxLevel: furnitureMaxLevel(def),
      gain: opened > 0 ? `배양관 ${opened}개 개방` : '',
      cost: nextFurnitureCost(def, level),
      reason: h.furnitureUpgradeBlock(this.uid),
      requirements: h.furnitureUpgradeRequirements(this.uid),
    };
  }

  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.deny(reason); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      const opened = cultureSlotsForLevel(before + 1) - cultureSlotsForLevel(before);
      this.showMsg(`배양조 Lv.${before + 1}${opened > 0 ? ` — 배양관 ${opened}개 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
  }

  /* ── hover card · right-click ──────────────────────────────────────────── */
  private onHover(e: PointerEvent): void {
    if (this.drag.dragging) return;
    const slot = this.slotAt(e.target as Element | null);
    if (slot === this.hoverSlot) return;
    this.hoverSlot = slot;
    const spec = slot !== null ? this.tipSpec(slot) : null;
    if (spec) this.tip.show(spec, e.clientX, e.clientY);
    else this.tip.hide();
  }

  private hideTip(): void {
    this.hoverSlot = null;
    this.tip.hide();
  }

  private tipSpec(slot: number): TipSpec | null {
    const info = this.infoOf(slot);
    if (!info || info.locked) return null;
    const h = this.housing;
    const hasMedium = !!info.mediumDefId;
    const hasStrain = !!info.strainDefId;
    const running = hasStrain && info.started !== false;
    const pending = hasStrain && !running;
    const scaffold = info.scaffoldDefId ?? null;
    const mediumDef = hasMedium ? h.defOf(info.mediumDefId!) : undefined;
    const ratio = mediumRatio(info);
    const rows: TipRow[] = [];
    if (hasMedium) {
      const now = Math.round(this.mediumNow(info)), max = Math.round(this.mediumMax(info));
      rows.push({ k: '배지', v: mediumDef?.name ?? info.mediumDefId! });
      rows.push({ k: '내구도', v: `${now} / ${max}${ratio <= 0 ? ' — 다 닳았습니다' : ''}`, tone: now <= 0 ? 'bad' : undefined });
      rows.push({ k: '배양 속도', v: speedText(info), tone: speedCut(info) > 0 ? 'good' : undefined });
      rows.push(...socketTipRows((id) => h.defOf(id), (id) => h.nameOf(id), 'medium', info.sockets, info.socketSlots, ratio));
      rows.push({ k: '스캐폴드', v: scaffold ? `${h.nameOf(scaffold)} · 수확할 때 소모` : '없음' });
    }
    if (hasStrain) {
      rows.push({ k: '세포주', v: h.nameOf(info.strainDefId!) });
      rows.push({ k: '남은 시간', v: pending ? '시작 전' : info.ready ? '수확 가능' : clockText(info.remainingS), tone: info.ready ? 'good' : undefined });
      if (info.yieldDefId) rows.push({ k: '산출물', v: `${h.nameOf(info.yieldDefId)} ×${info.yieldQty}`, tone: scaffold ? 'good' : undefined });
    }
    const foot: string[] = [];
    if (info.ready) foot.push('더블클릭 · 끌어다 놓기: 수확');
    if (pending) foot.push('「배양 시작」: 배양 시작 · 우클릭: 꺼내기');
    else if (hasMedium && scaffold && !running) foot.push('우클릭: 스캐폴드 빼기 · 배지 비우기');
    else if (hasMedium) foot.push(info.mediumReturnable ? '우클릭: 배지 빼기' : '우클릭: 배지 비우기');
    return {
      name: hasStrain ? h.nameOf(info.strainDefId!) : mediumDef?.name ?? '빈 배양관',
      sub: info.ready ? '수확 가능'
        : pending ? '시작 대기 — 「배양 시작」을 누르세요'
        : running ? (scaffold ? '스캐폴드 배양 중' : '배양 중')
          : !hasMedium ? '영양 배지를 부을 수 있습니다'
            : scaffold ? '세포주를 넣으면 종별 고기를 만듭니다'
              : '스캐폴드 · 세포주를 넣을 수 있습니다',
      color: mediumDef?.color,
      rows,
      foot: foot.join('\n'),
    };
  }

  private onContext(e: MouseEvent): void {
    const slot = this.slotAt(e.target as Element | null);
    if (slot === null) return;
    e.preventDefault();
    e.stopPropagation();
    const info = this.infoOf(slot);
    if (!info || info.locked || !info.mediumDefId) return;
    this.hideTip();
    const running = !!info.strainDefId && info.started !== false;
    const pending = !!info.strainDefId && !running;
    const socketCount = info.sockets?.length ?? 0;
    const items: StationMenuItem[] = [];
    // 2026-09-17: before the start what went in comes back — strain → scaffold (the reverse of the order they went in), and a never-used medium slot and all
    if (pending) items.push({ label: '세포주 빼기', run: () => this.takeStrain(slot) });
    if (!running && info.scaffoldDefId) items.push({ label: '스캐폴드 빼기', run: () => this.takeScaffold(slot) });
    if (info.mediumReturnable) {
      items.push({ label: '배지 빼기', run: () => this.takeMedium(slot) });
      this.menu.show(e.clientX, e.clientY, items);
      return;
    }
    const label = running ? '세포주 버리고 배지 비우기' : '배지 비우기';
    items.push({
      label,
      danger: running || socketCount > 0,
      run: () => {
        if (!socketCount) { this.clearMedium(slot, running); return; }
        this.sockAsk.confirm({
          id: 'hs-medium-clear',
          title: label,
          body: `소켓도 함께 사라집니다 — 끼운 소켓 ${socketCount}개와 배지는 돌려받지 않습니다.${running ? '\n배양 중인 세포주도 버립니다.' : ''}`,
          label: '비우기',
          run: () => this.clearMedium(slot, running),
        });
      },
    });
    this.menu.show(e.clientX, e.clientY, items);
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const list = this.tanks();
    const railKey = list.map((p) => p.uid).join(',');
    if (railKey !== this.railKey) { this.railKey = railKey; this.buildRail(list); }
    const tank = h.getPlacedByUid(this.uid);
    const def = tank ? h.getFurnitureDef(tank.defId) : undefined;
    setText(this.shell.title, def?.name ?? '배양조');
    paintStationLevel(this.shell, tank && def ? tank.level : null, def ? furnitureMaxLevel(def) : 0);
    const infos = tank ? h.getCultureSlots(this.uid) : [];
    const key = tank ? `${this.uid}:${tank.level}` : '';
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(infos);
    }
    this.paint(infos);
    this.modal.refresh();
  }

  /** Rebuild the culture tubes — only when the tank (or its level) changed. Always `CULTURE_MAX_SLOTS` tubes in 3 columns. */
  private build(infos: readonly CultureSlotInfo[]): void {
    this.debug.builds++;
    this.hideTip();
    clear(this.slotsEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '배양조가 없습니다', parent: this.slotsEl });
      return;
    }
    for (const info of infos) {
      if (info.locked) this.buildLocked(this.slotsEl, info);
      else this.cards.push(this.buildSlot(this.slotsEl, info));
    }
  }

  /** A tube the level has not opened yet: dashed empty glass + `Lv.N 필요` (no `data-slot` — not a drop target). */
  private buildLocked(parent: HTMLElement, info: CultureSlotInfo): void {
    const wrap = el('div', { cls: 'cult-slot is-locked', parent });
    const tube = el('div', { cls: 'cult-tube', parent: wrap });
    el('i', { cls: 'cult-cap', parent: tube });
    const glass = el('div', { cls: 'cult-glass', parent: tube });
    el('span', { cls: 'cult-lock', text: `Lv.${info.unlockLevel} 필요`, parent: glass });
    el('i', { cls: 'cult-base', parent: tube });
    const body = el('div', { cls: 'cult-slot-body', parent: wrap });
    el('div', { cls: 'cult-name', text: '잠긴 배양관', parent: body });
  }

  private buildSlot(parent: HTMLElement, info: CultureSlotInfo): TankCard {
    const s = String(info.slot);
    const wrap = el('div', { cls: 'cult-slot', attrs: { 'data-slot': s }, parent });
    const tube = el('div', { cls: 'cult-tube', parent: wrap });
    el('i', { cls: 'cult-cap', parent: tube });
    // the glass = the drop target. The fluid (`.cult-fluid`) rises by transform only — the drag-lag contract (it never disturbs the layout)
    const cell = el('div', { cls: 'cult-glass cult-cell', attrs: { 'data-slot': s }, parent: tube });
    const fluid = el('i', { cls: 'cult-fluid', parent: cell });
    // the culture scaffold = a grid standing in the fluid (drawn in CSS), the sockets = dots low in the glass — both `pointer-events: none`
    const scaffold = el('i', { cls: 'cult-scaffold', parent: cell });
    const glyph = el('span', { cls: 'cult-glyph', text: '', parent: cell });
    const socks = el('span', { cls: 'cult-socks', parent: cell });
    socks.hidden = true;
    el('i', { cls: 'cult-base', parent: tube });
    const body = el('div', { cls: 'cult-slot-body', parent: wrap });
    const name = el('div', { cls: 'cult-name', text: '', parent: body });
    const time = el('div', { cls: 'cult-time hs-clock', text: '', parent: body });
    const prog = el('div', { cls: 'cult-prog', parent: body });
    const fill = el('i', { parent: prog });
    // 2026-09-17: the culture start — it always takes its space (so the line height under the tube never moves) and is enabled only when it can start
    const slot = info.slot;
    const start = this.button(body, '배양 시작', () => this.askStart(slot), 'cult-start');
    start.type = 'button';
    return { slot: info.slot, wrap, cell, fluid, scaffold, socks, glyph, name, time, prog, fill, start, medium: null };
  }

  /** Cheap repaint: fluid level / colour, scaffold, socket dots, glyph, name, clock and progress only. */
  private paint(infos: readonly CultureSlotInfo[] = this.housing.getCultureSlots(this.uid)): void {
    this.debug.paints++;
    this.paintRail();
    const bySlot = new Map<number, CultureSlotInfo>();
    for (const i of infos) bySlot.set(i.slot, i);
    for (const card of this.cards) {
      const info = bySlot.get(card.slot);
      if (!info) continue;
      const hasMedium = !!info.mediumDefId;
      const hasStrain = !!info.strainDefId;
      // 2026-09-17: a strain before the start is not culturing (`is-pending` — the cell floats but does not move and the progress bar stays empty)
      const running = hasStrain && info.started !== false;
      toggleClass(card.wrap, 'has-medium', hasMedium);
      toggleClass(card.wrap, 'has-strain', hasStrain);
      toggleClass(card.wrap, 'is-pending', hasStrain && !running);
      toggleClass(card.wrap, 'is-running', running);
      toggleClass(card.wrap, 'is-ready', info.ready);
      toggleClass(card.wrap, 'has-scaffold', hasMedium && !!info.scaffoldDefId);
      toggleClass(card.wrap, 'is-worn', hasMedium && mediumRatio(info) <= 0);

      const mediumDef = hasMedium ? this.housing.defOf(info.mediumDefId!) : undefined;
      const color = hasMedium ? mediumDef?.color || FLUID_FALLBACK : '';
      if (card.fluid.dataset.c !== color) { card.fluid.dataset.c = color; card.fluid.style.setProperty('--mc', color || FLUID_FALLBACK); }
      const max = this.mediumMax(info);
      const now = this.mediumNow(info);
      // 2026-09-13: the fluid height = the medium durability ÷ its maximum (in place of the old 「남은 수확 횟수」). The slot stays at 0 too — only a thin band at the bottom.
      const lvl = hasMedium ? Math.max(0, Math.min(1, now / max)).toFixed(3) : '0';
      if (card.fluid.dataset.lvl !== lvl) { card.fluid.dataset.lvl = lvl; card.fluid.style.setProperty('--lvl', lvl); }
      // the fluid runs up once, only when a medium has just been poured (empty tube → medium) — a tube already full when the screen opens is drawn quietly
      const mediumKey = info.mediumDefId ?? '';
      if (card.medium === '' && mediumKey) {
        card.fluid.classList.remove('is-filling');
        void card.fluid.offsetWidth;                       // restart the one-shot animation
        card.fluid.classList.add('is-filling');
        this.debug.fills++;
      }
      card.medium = mediumKey;

      const scaffoldColor = info.scaffoldDefId ? this.housing.defOf(info.scaffoldDefId)?.color || '' : '';
      if (card.scaffold.dataset.c !== scaffoldColor) {
        card.scaffold.dataset.c = scaffoldColor;
        if (scaffoldColor) card.scaffold.style.setProperty('--sc', scaffoldColor); else card.scaffold.style.removeProperty('--sc');
      }
      paintSocketDots(card.socks, hasMedium ? info.socketSlots : 0, info.sockets?.length ?? 0);

      const strainDef = hasStrain ? this.housing.defOf(info.strainDefId!) : undefined;
      // the floating cell is drawn by CSS (`.cult-glyph`, while a strain is in — it sways, very slowly, only while culturing) — the colour is the culture product item's colour
      const organism = hasStrain && info.yieldDefId ? this.housing.defOf(info.yieldDefId)?.color || '' : '';
      if (card.glyph.dataset.c !== organism) { card.glyph.dataset.c = organism; if (organism) card.glyph.style.setProperty('--oc', organism); else card.glyph.style.removeProperty('--oc'); }
      setText(card.name, hasStrain ? (strainDef?.name ?? '세포주') : mediumDef?.name ?? '빈 배양관');
      const startBlock = this.startBlock(info);
      card.start.disabled = startBlock !== null;
      if (card.start.title !== (startBlock ?? '')) card.start.title = startBlock ?? '';
      if (hasStrain && !running) {
        renderClockText(card.time, '시작 대기');
      } else if (running) {
        if (info.ready) renderClockText(card.time, '수확 가능');
        else renderClock(card.time, info.remainingS);
      } else {
        renderClockText(card.time, hasMedium ? `내구도 ${Math.round(now)}/${Math.round(max)}` : '배지 필요');
      }

      // the progress bar always takes its space (so the line height under the tube does not move per state) — it merely looks empty when not culturing
      toggleClass(card.prog, 'is-idle', !running || info.ready);
      card.fill.style.width = running ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';
    }
    if (this.hoverSlot !== null && this.tip.isShown) {
      const spec = this.tipSpec(this.hoverSlot);
      if (spec) this.tip.update(spec);
      else this.hideTip();
    }
  }

  /* ── the tank list on the left (`StationShell.rail`, 2026-09-17) ──────────── */
  /** Every culture tank placed in the ship — picked by `interaction` (no defId is written into the code). */
  private tanks(): readonly PlacedFurniture[] {
    return this.housing.getPlaced().filter((p) => this.housing.getFurnitureDef(p.defId)?.interaction === 'culture_tank');
  }

  /** The list is built only when the set of tanks changes. Not hidden even with one tank (the same reason as the grow station list — the red dot · the left alignment). */
  private buildRail(list: readonly PlacedFurniture[]): void {
    const rail = this.shell.rail;
    clear(rail);
    this.railItems = [];
    rail.hidden = list.length === 0;
    list.forEach((p, i) => {
      const btn = el('button', { cls: 'hs-rail-item cult-rail-item', attrs: { 'data-uid': p.uid }, parent: rail });
      btn.type = 'button';
      const red = el('i', { cls: 'hs-rail-red', parent: btn });
      const name = this.housing.getFurnitureDef(p.defId)?.name ?? '배양조';
      el('span', { cls: 'hs-rail-name', text: `${name} ${i + 1}`, parent: btn });
      const dotsEl = el('span', { cls: 'hs-rail-dots cult-rail-dots', parent: btn });
      const dots = this.housing.getCultureSlots(p.uid).map(() => el('i', { parent: dotsEl }));
      this.railItems.push({ uid: p.uid, el: btn, dots, red });
    });
  }

  /** Repaints only the dot colours · the red dot · the selection mark (the same place as the 1 s tick). Grey = culturing · green = ready to harvest · black = anything else. */
  private paintRail(): void {
    for (const it of this.railItems) {
      toggleClass(it.el, 'is-active', it.uid === this.uid);
      const slots = this.housing.getCultureSlots(it.uid);
      let ready = 0;
      for (let i = 0; i < it.dots.length; i++) {
        const s = slots[i];
        const alive = !!s && !s.locked && !!s.strainDefId && s.started !== false;
        toggleClass(it.dots[i], 'growing', alive && !s!.ready);
        toggleClass(it.dots[i], 'ready', alive && !!s!.ready);
        if (alive && s!.ready) ready++;
      }
      toggleClass(it.red, 'on', ready > 0);
    }
  }

  private onRailClick(e: MouseEvent): void {
    const uid = (e.target as Element | null)?.closest<HTMLElement>('.hs-rail-item')?.dataset.uid;
    if (!uid || uid === this.uid) return;
    e.stopPropagation();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.closeStartAsk();
    this.hideTip();
    this.drag.end();
    this.sockAsk.close();
    this.uid = uid;                       // `builtKey` holds the uid, so `refresh()` rebuilds the tubes
    this.refresh();
  }

  override dispose(): void {
    this.closeStartAsk();
    this.stopTicking();
    this.drag.dispose();
    this.modal.dispose();
    this.sockAsk.close();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}

/** The time fraction the medium's rarity cuts × the durability ratio (2026-09-13 — the bonus shrinks as the medium wears). */
function speedCut(info: CultureSlotInfo): number {
  return Math.max(0, 1 - info.mediumSpeedMul) * mediumRatio(info);
}

/** The 「배양 속도」 row: the better the rarity the faster, and it applies only as far as the durability ratio (a socket's speed is written on its own socket row). */
function speedText(info: CultureSlotInfo): string {
  const cut = Math.round(speedCut(info) * 100);
  const full = Math.round(Math.max(0, 1 - info.mediumSpeedMul) * 100);
  if (cut <= 0) return full > 0 ? `기본 (배지 보너스 +${full} % 가 다 닳았습니다)` : '기본';
  return cut < full ? `+${cut} % (최대 +${full} %)` : `+${cut} %`;
}
