import type { EmbeddedView, GameContext, GrowSlotInfo, GrowTier, HarvestDestination, ItemInstance } from '@/shared';
import {
  GROW_TIER_DRAW_ORDER, GROW_TIER_LABEL_KO, SOIL_MATCH_SPEEDUP, SOIL_MISMATCH_PENALTY, SOIL_TAG_COLOR, SOIL_TAG_LABEL_KO,
  growTiersForLevel,
} from '@/shared';
import type { SoilTag } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { StationMenu } from './StationMenu';
import { StationTip } from './StationTip';
import type { TipRow, TipSpec } from './StationTip';
import { buildStationShell, mountStationGrids, paintStationLevel } from './StationShell';
import type { StationShell } from './StationShell';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import { clear, clockText, el, renderClock, renderClockText, setText, toggleClass } from './dom';

/** How often the countdowns / plant growth are repainted while the panel is open (ms). */
const TICK_MS = 1000;
const pct = (v: number): number => Math.round(v * 100);
const keyOf = (tier: GrowTier, slot: number): string => `${tier}:${slot}`;
const tagLabel = (t: SoilTag | null): string => (t ? SOIL_TAG_LABEL_KO[t] : '알 수 없는');

interface SlotCard {
  key: string;
  wrap: HTMLElement;
  soil: HTMLElement;
  leaf: HTMLElement;
  time: HTMLElement;
}

/**
 * **재배 화면** (온실 개편 2026-09-11 · 화면 개편 2026-09-12 — `openGrowStation(uid)` ← E on a 재배 스테이션).
 *
 * 틀은 `StationShell` 공통이다: 머리줄 = 「재배 스테이션」 + `Lv. n` · 오른쪽 「업그레이드」(→ `UpgradeModal`, 1초 홀드),
 * 좌 패널 = 재배층, 우 패널 = 가방 · 함선 창고 격자 (`createTradeGrids`). 라벨 · 안내문은 없다.
 *
 * 한 층은 **하얀 바** 하나이고, 그 위에 **흙구멍**(위가 잘린 작은 원)이 `GROW_SLOTS_PER_TIER` 개 박혀 있다 — 바의 윗변이
 * 흙구멍의 윗변과 같은 높이다. 심은 작물은 구멍 위로 자란다(`--g` = 진행도, 줄기 `scaleY` + 잎 `translateY` · `scale`,
 * 전부 transform). 층 사이 간격은 **다 자란 작물의 높이**라 윗층을 덮지 않는다. 잠긴 층은 테두리만 그린다.
 *
 * 구멍 아래에는 남은 시간 `HH:MM:SS`(`:SS` 는 절반 크기) 또는 **「수확 가능」** 하나뿐이다. 나머지는 호버 카드
 * (`StationTip` — 씨앗 · 토양 · 남은 시간 · 궁합)와 우클릭 메뉴(`StationMenu` — 흙 비우기)로 옮겼다. 다 자란 작물은
 * **더블클릭 = 함선 창고 먼저**, **끌어서 격자에 놓기 = 그 격자**다 (`ProductDrag`).
 *
 * 성능 (2026-09-12 「아이템을 옮기려 할 때 프레임 드랍」): 예전에는 드롭 한 번에 `refresh()` 가 명시 호출 + 이벤트 3종
 * 으로 **3–4번** 돌았고 매번 재배층 DOM 을 통째로 다시 지었다(+ 격자 뷰 전체 `refresh`). 이제 이벤트는 마이크로태스크
 * 하나로 합쳐지고(`coalesceRefresh`), 층 DOM 은 **스테이션 레벨이 바뀔 때만** 다시 짓는다 — 나머지는 글자 · 클래스 ·
 * `--g` 만 고친다 (`debug.builds` / `debug.paints`). 드롭 강조도 애니메이션 `box-shadow` 가 아니라 배경색 한 줄이다.
 */
export class GrowStation extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly tiersEl: HTMLElement;
  private readonly modal: UpgradeModal;
  private readonly tip: StationTip;
  private readonly menu: StationMenu;
  private readonly drag: ProductDrag;
  private grids: EmbeddedView | null = null;
  private cards: SlotCard[] = [];
  private builtKey = '';
  private hoverKey: string | null = null;
  private timer = 0;
  /** Smoke / perf counters: full 재배층 rebuilds vs cheap repaints. */
  readonly debug = { builds: 0, paints: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'grow', 'grow-station hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '재배 스테이션',
      upgrade: true,
      onUpgrade: () => this.openUpgrade(),
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    this.tiersEl = el('div', { cls: 'gs-tiers', parent: this.shell.left });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '작물은 현실 시간에 맞춰 자랍니다 — 함선을 떠나도 계속 자랍니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.tip = new StationTip(this.root);
    this.menu = new StationMenu(this.root);
    this.overlays.push(this.modal, this.menu);
    this.drag = new ProductDrag(this.tiersEl, {
      productAt: (t) => this.productAt(t),
      collect: (key, dest) => this.collect(key, dest),
      defOf: (id) => housing.defOf(id),
      onDragStart: () => this.hideTip(),
    });

    this.tiersEl.addEventListener('pointerover', (e) => this.onHover(e));
    this.tiersEl.addEventListener('pointermove', (e) => { if (this.hoverKey && !this.drag.dragging) this.tip.move(e.clientX, e.clientY); });
    this.tiersEl.addEventListener('pointerleave', () => this.hideTip());
    this.tiersEl.addEventListener('contextmenu', (e) => this.onContext(e));
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 재배 스테이션. */
  openStation(uid: string): void {
    if (uid !== this.uid) this.builtKey = '';
    this.uid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.gs-pot[data-tier]', (item, target) => this.dropOn(item, target));
    this.startTicking();
    this.ctx.bus.emit('ui:growToggled', { open: true, uid });
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    this.stopTicking();
    this.hideTip();
    this.drag.end();
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
    if (wasOpen) this.ctx.bus.emit('ui:growToggled', { open: false, uid: null });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the 가방 / 창고 onto a 흙구멍 (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('토양 · 씨앗을 흙구멍으로 끌어다 놓으세요', 'info'); return; }
    const tier = Number(target.dataset.tier);
    const slot = Number(target.dataset.slot);
    if (!Number.isInteger(tier) || !Number.isInteger(slot)) { this.showMsg('없는 재배 칸입니다', 'warning'); return; }
    const def = this.housing.defOf(item.defId);
    if (!def) { this.showMsg('알 수 없는 아이템입니다', 'warning'); return; }
    const t = tier as GrowTier;
    let reason: string | null;
    let done: string;
    if (def.soil) {
      reason = this.housing.fillSoil(this.uid, t, slot, item.defId);
      done = `${def.name}을(를) 부었습니다`;
    } else if (def.seed) {
      reason = this.housing.plantSeedAt(this.uid, t, slot, item.defId);
      done = `${def.name}을(를) 심었습니다`;
    } else {
      this.showMsg('토양이나 씨앗만 놓을 수 있습니다', 'warning');
      return;
    }
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(done, 'success');
    // 성공하면 housing:changed 가 이미 한 번의 refresh 를 예약했다 — 여기서 또 부르지 않는다
  }

  private infoOf(key: string): GrowSlotInfo | null {
    return this.housing.getGrowSlots(this.uid).find((i) => keyOf(i.tier, i.slot) === key) ?? null;
  }

  private productAt(target: Element): Product | null {
    const key = target.closest<HTMLElement>('.gs-slot')?.dataset.key;
    const info = key ? this.infoOf(key) : null;
    if (!key || !info || !info.ready || !info.yieldDefId) return null;
    return { key, defId: info.yieldDefId, qty: info.yieldQty };
  }

  /** 다 자란 칸 하나를 거둔다 — 더블클릭(`'stash-first'`) 또는 격자에 끌어다 놓기(`'bag'` / `'stash'`). */
  private collect(key: string, dest: HarvestDestination): void {
    const info = this.infoOf(key);
    if (!info) return;
    const reason = this.housing.harvestAt(this.uid, info.tier, info.slot, dest);
    if (reason) { this.deny(reason); return; }
    const name = info.yieldDefId ? this.housing.nameOf(info.yieldDefId) : '수확물';
    this.showMsg(`${name} ×${info.yieldQty} 수확`, 'success');
    this.hideTip();
  }

  private clearSoil(tier: GrowTier, slot: number, discardCrop: boolean): void {
    const reason = this.housing.clearSoil(this.uid, tier, slot, discardCrop);
    if (reason) { this.deny(reason); return; }
    this.showMsg(discardCrop ? '작물을 버리고 흙을 비웠습니다' : '흙을 비웠습니다 (남은 횟수는 돌려받지 않습니다)', 'info');
  }

  /* ── 업그레이드 (모달) ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!this.housing.getPlacedByUid(this.uid)) return;
    this.hideTip();
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  /** 다음 레벨이 여는 층은 계약 `growTiersForLevel` 에서 유도한다 (코드에 층 번호를 적지 않는다). */
  private upgradeSpec(): UpgradeSpec | null {
    const h = this.housing;
    const station = h.getPlacedByUid(this.uid);
    const def = station ? h.getFurnitureDef(station.defId) : undefined;
    if (!station || !def) return null;
    const level = station.level;
    const opened = growTiersForLevel(level + 1).filter((t) => !growTiersForLevel(level).includes(t));
    return {
      name: def.name,
      level,
      maxLevel: furnitureMaxLevel(def),
      gain: opened.length ? `${opened.map((t) => GROW_TIER_LABEL_KO[t]).join(' · ')} 개방` : '',
      cost: nextFurnitureCost(def, level),
      reason: h.furnitureUpgradeBlock(this.uid),
    };
  }

  /** 규칙 · 재료 소모는 전부 `HousingRef.upgradeFurniture` 안에 있다. */
  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.deny(reason); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      const opened = growTiersForLevel(before + 1).filter((t) => !growTiersForLevel(before).includes(t));
      const what = opened.map((t) => GROW_TIER_LABEL_KO[t]).join(' · ');
      this.showMsg(`재배 스테이션 Lv.${before + 1}${what ? ` — ${what} 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
  }

  /* ── 호버 카드 · 우클릭 ────────────────────────────────────────────────── */
  private onHover(e: PointerEvent): void {
    if (this.drag.dragging) return;
    const key = (e.target as Element | null)?.closest<HTMLElement>('.gs-slot')?.dataset.key ?? null;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    const spec = key ? this.tipSpec(key) : null;
    if (spec) this.tip.show(spec, e.clientX, e.clientY);
    else this.tip.hide();
  }

  private hideTip(): void {
    this.hoverKey = null;
    this.tip.hide();
  }

  /** 씨앗 · 토양 · 남은 시간 · 궁합 — 칸 아래에서 걷어낸 글자가 전부 여기로 왔다. */
  private tipSpec(key: string): TipSpec | null {
    const info = this.infoOf(key);
    if (!info || info.locked) return null;
    const h = this.housing;
    const planted = !!info.seedDefId;
    const hasSoil = !!info.soilDefId;
    const rows: TipRow[] = [];
    if (planted) rows.push({ k: '씨앗', v: `${h.nameOf(info.seedDefId!)} · ${tagLabel(info.seedTag)} 토양을 좋아함` });
    if (hasSoil) rows.push({ k: '토양', v: `${h.nameOf(info.soilDefId!)} · ${tagLabel(info.soilTag)} · 수확 ${info.soilUsesLeft}회 남음` });
    if (planted) {
      rows.push({ k: '남은 시간', v: info.ready ? '수확 가능' : clockText(info.remainingS), tone: info.ready ? 'good' : undefined });
      // 수치는 심는 순간 이미 `readyAt` 에 확정됐다 — 여기서는 그 배율을 말로 되읽는다 (csv 값)
      rows.push(info.matched
        ? { k: '궁합', v: `맞음 · 성장 시간 −${pct(SOIL_MATCH_SPEEDUP)} %`, tone: 'good' }
        : { k: '궁합', v: `어긋남 · 성장 시간 +${pct(SOIL_MISMATCH_PENALTY)} %`, tone: 'bad' });
      if (info.yieldDefId) rows.push({ k: '수확물', v: `${h.nameOf(info.yieldDefId)} ×${info.yieldQty}` });
    }
    const foot: string[] = [];
    if (info.ready) foot.push('더블클릭 · 끌어다 놓기: 수확');
    if (hasSoil) foot.push('우클릭: 흙 비우기');
    return {
      name: planted ? h.nameOf(info.seedDefId!) : hasSoil ? h.nameOf(info.soilDefId!) : '빈 흙구멍',
      sub: info.ready ? '수확 가능' : planted ? '자라는 중' : hasSoil ? '씨앗을 심을 수 있습니다' : '토양을 부을 수 있습니다',
      color: info.soilTag ? SOIL_TAG_COLOR[info.soilTag] : undefined,
      rows,
      foot: foot.join('\n'),
    };
  }

  private onContext(e: MouseEvent): void {
    const key = (e.target as Element | null)?.closest<HTMLElement>('.gs-slot')?.dataset.key;
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    const info = this.infoOf(key);
    if (!info || info.locked || !info.soilDefId) return;
    this.hideTip();
    const planted = !!info.seedDefId;
    this.menu.show(e.clientX, e.clientY, [{
      label: planted ? '작물 버리고 흙 비우기' : '흙 비우기',
      danger: planted,
      run: () => this.clearSoil(info.tier, info.slot, planted),
    }]);
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const station = h.getPlacedByUid(this.uid);
    const def = station ? h.getFurnitureDef(station.defId) : undefined;
    setText(this.shell.title, def?.name ?? '재배 스테이션');
    paintStationLevel(this.shell, station && def ? station.level : null, def ? furnitureMaxLevel(def) : 0);
    const infos = station ? h.getGrowSlots(this.uid) : [];
    const key = station ? `${this.uid}:${station.level}` : '';
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(infos);
    }
    this.paint(infos);
    this.modal.refresh();
  }

  /** Rebuild the 재배층 rows — only when the station (or its level) changed. */
  private build(infos: readonly GrowSlotInfo[]): void {
    this.debug.builds++;
    this.hideTip();
    clear(this.tiersEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '재배 스테이션이 없습니다', parent: this.tiersEl });
      return;
    }
    for (const tier of GROW_TIER_DRAW_ORDER) {
      const rows = infos.filter((i) => i.tier === tier);
      if (!rows.length) continue;
      const locked = rows[0].locked;
      const row = el('div', { cls: `gs-tier${locked ? ' is-locked' : ''}`, attrs: { 'data-tier-row': String(tier) }, parent: this.tiersEl });
      if (locked) continue;                                 // 강화하지 않은 층은 테두리만
      const body = el('div', { cls: 'gs-tier-body', parent: row });
      el('div', { cls: 'gs-bar', parent: body });           // 가로로 긴 하얀 바 = 한 층
      for (const info of rows) this.cards.push(this.buildSlot(body, info));
    }
  }

  private buildSlot(parent: HTMLElement, info: GrowSlotInfo): SlotCard {
    const key = keyOf(info.tier, info.slot);
    const wrap = el('div', { cls: 'gs-slot', attrs: { 'data-key': key }, parent });
    const plant = el('div', { cls: 'gs-plant', parent: wrap });
    el('i', { cls: 'gs-stem', parent: plant });
    const leaf = el('span', { cls: 'gs-leaf', text: '', parent: plant });
    const pot = el('div', { cls: 'gs-pot', attrs: { 'data-tier': String(info.tier), 'data-slot': String(info.slot) }, parent: wrap });
    const soil = el('i', { cls: 'gs-soil', parent: pot });
    const time = el('div', { cls: 'gs-time hs-clock', text: '', parent: wrap });
    return { key, wrap, soil, leaf, time };
  }

  /** Cheap repaint (open · every change · 1 s tick): classes, soil colour, growth `--g`, the clock. */
  private paint(infos: readonly GrowSlotInfo[] = this.housing.getGrowSlots(this.uid)): void {
    this.debug.paints++;
    const byKey = new Map<string, GrowSlotInfo>();
    for (const i of infos) byKey.set(keyOf(i.tier, i.slot), i);
    for (const card of this.cards) {
      const info = byKey.get(card.key);
      if (!info) continue;
      const hasSoil = !!info.soilDefId;
      const planted = !!info.seedDefId;
      toggleClass(card.wrap, 'has-soil', hasSoil);
      toggleClass(card.wrap, 'is-planted', planted);
      toggleClass(card.wrap, 'is-ready', info.ready);

      const color = info.soilTag ? SOIL_TAG_COLOR[info.soilTag] : '';
      if (card.soil.dataset.c !== color) { card.soil.dataset.c = color; card.soil.style.background = color; }

      const g = planted ? (info.ready ? 1 : Math.max(0, Math.min(1, info.progress))) : 0;
      const gs = g.toFixed(3);
      if (card.wrap.dataset.g !== gs) { card.wrap.dataset.g = gs; card.wrap.style.setProperty('--g', gs); }

      // 자라는 동안은 씨앗 글리프, 다 자라면 수확물 글리프 (아이템 표의 아이콘 — 외부 에셋 없음)
      const iconDef = planted ? this.housing.defOf(info.ready && info.yieldDefId ? info.yieldDefId : info.seedDefId!) : undefined;
      setText(card.leaf, planted ? (iconDef?.icon || '❁') : '');

      if (!planted) renderClockText(card.time, '');
      else if (info.ready) renderClockText(card.time, '수확 가능');
      else renderClock(card.time, info.remainingS);
    }
    if (this.hoverKey && this.tip.isShown) {
      const spec = this.tipSpec(this.hoverKey);
      if (spec) this.tip.update(spec);
      else this.hideTip();
    }
  }

  override dispose(): void {
    this.stopTicking();
    this.drag.dispose();
    this.modal.dispose();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
