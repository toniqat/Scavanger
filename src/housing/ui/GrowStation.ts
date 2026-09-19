import type {
  EmbeddedView, GameContext, GrowSlotInfo, GrowTier, HarvestDestination, ItemDef, ItemInstance, PlacedFurniture,
} from '@/shared';
import {
  GROW_TIER_DRAW_ORDER, SOIL_MATCH_SPEEDUP, SOIL_MISMATCH_PENALTY, SOIL_TAG_COLOR, SOIL_TAG_LABEL_KO,
} from '@/shared';
import type { SoilTag } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, growStationSpeedPct, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { SocketAsk, paintSocketDots, socketTipRows } from './SocketFlow';
import { StationMenu } from './StationMenu';
import { StationTip } from './StationTip';
import type { TipRow, TipSpec } from './StationTip';
import { buildStationShell, mountStationGrids, paintStationLevel, paintStationMeta } from './StationShell';
import type { StationGridsView, StationShell } from './StationShell';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import { clear, clockText, el, renderClock, renderClockText, setText, toggleClass } from './dom';

/** How often the countdowns / plant growth are repainted while the panel is open (ms). */
const TICK_MS = 1000;
const pct = (v: number): number => Math.round(v * 100);
const keyOf = (tier: GrowTier, slot: number): string => `${tier}:${slot}`;
const tagLabel = (t: SoilTag | null): string => (t ? SOIL_TAG_LABEL_KO[t] : '알 수 없는');
/** The `성장 속도 +n%` meta line — the speed the station level gives (`Rules.growStationSpeedPct`, 2026-09-13). */
const speedText = (level: number): string => `성장 속도 +${growStationSpeedPct(level)}%`;
/** The soil's bonus ratio (0 … 1). Read as 1 on an old build whose contract field is not there yet. */
const soilRatio = (info: GrowSlotInfo): number =>
  (typeof info.soilBonusRatio === 'number' && Number.isFinite(info.soilBonusRatio) ? Math.max(0, Math.min(1, info.soilBonusRatio)) : 1);
const fin = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);

/**
 * The hovered **region** (2026-09-12, user's decision): over the pot (`.gs-pot`) it is the soil card, and the plant area above
 * it · the clock · the whole rest of the slot are the crop card. Because the target is 「not just the plant image but the whole
 * space a plant grows into」, `.gs-plant` got its `pointer-events` back — the drop target is still the one `.gs-pot[data-tier]`, and the two never overlap.
 */
type TipRegion = 'soil' | 'plant';
const regionOf = (t: Element | null): TipRegion => (t?.closest('.gs-pot') ? 'soil' : 'plant');

interface SlotCard {
  key: string;
  wrap: HTMLElement;
  soil: HTMLElement;
  /** The socket dots inside the pot (2026-09-13). */
  socks: HTMLElement;
  leaf: HTMLElement;
  time: HTMLElement;
}

/** One row of the leftmost station list (`.hs-rail`): name + 3×3 status dots + the red dot. */
interface RailItem {
  uid: string;
  el: HTMLElement;
  dots: HTMLElement[];
  red: HTMLElement;
}

/**
 * **The grow station screen** (greenhouse rework 2026-09-11 · screen rework 2026-09-12 — `openGrowStation(uid)` ← E on a grow station).
 *
 * The frame is the shared `StationShell`: the station card = 「재배 스테이션」 + `Lv. n` + the growth speed (`meta`) · 「업그레이드」
 * at the card's top right (→ `UpgradeModal`, a 1 s hold) · the tiers, and beside it the ship stash card · the bag card (2026-09-13 card layout).
 *
 * **2026-09-13 (user's decision)**: all three tiers are open from Lv.1, and an upgrade raises the **growth speed** by
 * `GROW_STATION_SPEED_PER_LEVEL` (`data/tuning.csv`) per level. An upgrade shortens the time left on crops already growing too, on the spot.
 *
 * A tier is one **white bar** with `GROW_SLOTS_PER_TIER` **pots** (small circles cut off at the top) set into it — the bar's top edge
 * sits at the pots' top edge. A planted crop grows up out of the pot (`--g` = progress, stem `scaleY` + leaf `translateY` · `scale`,
 * all transforms). The gap between tiers is **the height of a full-grown crop**, so it never covers the tier above. A locked tier is an outline only.
 *
 * The one line under the pot **is the same height in every state** (2026-09-12, user's decision): with no soil 「토양 필요」 (red),
 * with soil only `00:00` (dimmed), while growing `HH:MM:SS`, and when ripe 「수확 가능」 (green). CSS nails down the font size · line
 * height · box height and `:SS` is the same size as `HH:MM`, so a state change never moves the slot by a pixel.
 *
 * **2026-09-13 (cooking material tiers)**: poured soil carries **durability** and **sockets**, and the slot does not empty on harvest.
 * The sockets show as **small dots inside the pot** (one per socket slot, the filled ones marked — `SocketFlow.paintSocketDots`), while
 * durability · bonus ratio · the socket list are on the pot's hover card (the clock line below the pot is unchanged). Soil worn all the
 * way down (`soilBonusRatio` 0) goes pale (`.is-worn`). A soil socket dropped on a pot is inserted (`insertGrowSocket`); with the slots
 * full it asks which socket to replace and then warns with a 1 s hold (`SocketAsk`). A refusal — a medium socket, a slot with no soil —
 * is toasted with housing's Korean reason. 「흙 비우기」 goes through a 「소켓도 함께 사라집니다」 1 s hold when there are sockets.
 *
 * Everything else is a **hover card per region** (`StationTip`) — over the pot the soil (kind · tag · durability · bonus · sockets),
 * over the plant space above it the crop (seed · time left · match · harvest). The right-click menu (`StationMenu`) is 흙 비우기, and a
 * ripe crop is **double-click = the ship stash first**, **drag onto a grid = that grid** (`ProductDrag`).
 *
 * The leftmost **station list** (`StationShell.rail`) lays the ship's grow stations out vertically and sums each one's 9 slots up in
 * 3×3 dots — grey = growing, black = nothing to grow (locked slots included), green = ready to harvest — and puts a red dot on it when
 * any slot is ripe. The list is built once on open and only its dots are repainted on the 1 s tick.
 *
 * Performance (2026-09-12 「a frame drop when trying to move an item」): one drop used to run `refresh()` **3–4 times** (an explicit call
 * plus three events) and rebuilt the whole tier DOM every time (+ a full `refresh` of the grid views). Now the events are coalesced into
 * one microtask (`coalesceRefresh`) and the tier DOM is rebuilt **only when the station level changes** — the rest only fixes text ·
 * classes · `--g` (`debug.builds` / `debug.paints`). The drop highlight is one background-colour line too, not an animated `box-shadow`.
 */
export class GrowStation extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly tiersEl: HTMLElement;
  private readonly modal: UpgradeModal;
  private readonly tip: StationTip;
  private readonly menu: StationMenu;
  private readonly sockAsk: SocketAsk;
  private readonly drag: ProductDrag;
  private grids: StationGridsView | null = null;
  private cards: SlotCard[] = [];
  private builtKey = '';
  private railItems: RailItem[] = [];
  private railKey = '';
  private hoverKey: string | null = null;
  private hoverRegion: TipRegion = 'plant';
  private timer = 0;
  /** Smoke / perf counters: full tier rebuilds vs cheap repaints. */
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
    this.shell.rail.addEventListener('click', (e) => this.onRailClick(e));

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '작물은 현실 시간에 맞춰 자랍니다 — 함선을 떠나도 계속 자랍니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.tip = new StationTip(this.root);
    this.menu = new StationMenu(this.root);
    this.sockAsk = new SocketAsk(ctx, this.menu);
    // order = bottom → top: the warning popup sits above the menu, so E · Tab close that one first
    this.overlays.push(this.modal, this.menu, this.sockAsk);
    this.drag = new ProductDrag(this.tiersEl, {
      productAt: (t) => this.productAt(t),
      collect: (key, dest) => this.collect(key, dest),
      defOf: (id) => housing.defOf(id),
      // 2026-09-16: it goes to **the very cell** it was dropped on (the grids are built when the screen opens, so they come as a function)
      grids: () => this.grids,
      onDragStart: () => this.hideTip(),
    });

    this.tiersEl.addEventListener('pointerover', (e) => this.onHover(e));
    this.tiersEl.addEventListener('pointermove', (e) => { if (this.hoverKey && !this.drag.dragging) this.tip.move(e.clientX, e.clientY); });
    this.tiersEl.addEventListener('pointerleave', () => this.hideTip());
    this.tiersEl.addEventListener('contextmenu', (e) => this.onContext(e));
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one grow station. */
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
  /** A tile was dragged out of the bag / stash onto a pot (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('토양 · 씨앗 · 토양 소켓을 흙구멍으로 끌어다 놓으세요', 'info'); return; }
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
    } else if (def.growSocket) {
      this.dropSocket(t, slot, def, target);
      return;
    } else {
      this.showMsg('토양 · 씨앗 · 토양 소켓만 놓을 수 있습니다', 'warning');
      return;
    }
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(done, 'success');
    // on success housing:changed has already queued one refresh — it is not called again here
  }

  /**
   * A soil socket drop (2026-09-13). With a free socket slot, or when it cannot be inserted at all (a medium socket · no soil …),
   * housing is asked straight away; only **with soil and the slots full** does it take the replace flow (pick → a 1 s hold) — every rule and reason is inside `insertGrowSocket`.
   */
  private dropSocket(tier: GrowTier, slot: number, def: ItemDef, anchor: HTMLElement): void {
    const info = this.infoOf(keyOf(tier, slot));
    const sockets = info?.sockets ?? [];
    const slots = fin(info?.socketSlots);
    const full = !!info && !!info.soilDefId && def.growSocket?.target === 'soil' && slots > 0 && sockets.length >= slots;
    if (!full) { this.insertSocket(tier, slot, def); return; }
    this.hideTip();
    this.sockAsk.askReplace({
      anchor,
      target: 'soil',
      newDef: def,
      sockets: sockets.slice(),
      ratio: soilRatio(info),
      defOf: (id) => this.housing.defOf(id),
      nameOf: (id) => this.housing.nameOf(id),
      run: (i) => this.insertSocket(tier, slot, def, i),
    });
  }

  private insertSocket(tier: GrowTier, slot: number, def: ItemDef, replaceIndex?: number): void {
    const old = replaceIndex !== undefined ? this.infoOf(keyOf(tier, slot))?.sockets?.[replaceIndex] ?? null : null;
    const reason = this.housing.insertGrowSocket(this.uid, tier, slot, def.id, replaceIndex);
    if (reason) { this.deny(reason); return; }
    this.showMsg(old ? `${this.housing.nameOf(old)} 파괴 · ${def.name}을(를) 끼웠습니다` : `${def.name}을(를) 끼웠습니다`, 'success');
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

  /** Harvest one ripe slot — a double-click (`'stash-first'`) or a drag onto a grid (`'bag'` / `'stash'`). */
  private collect(key: string, dest: HarvestDestination): void {
    const info = this.infoOf(key);
    if (!info) return;
    const id = info.yieldDefId;
    const before = id ? this.housing.countDef(id) : 0;
    const reason = this.housing.harvestAt(this.uid, info.tier, info.slot, dest);
    if (reason) { this.deny(reason); return; }
    // 2026-09-13: a `yield` socket may add +1 — how many arrived is read as the bag + stash difference (the base count when it cannot be read)
    const got = id ? this.housing.countDef(id) - before : 0;
    const qty = got > 0 ? got : info.yieldQty;
    const bonus = got > info.yieldQty ? ` (추가 +${got - info.yieldQty})` : '';
    this.showMsg(`${id ? this.housing.nameOf(id) : '수확물'} ×${qty} 수확${bonus}`, 'success');
    this.hideTip();
  }

  private clearSoil(tier: GrowTier, slot: number, discardCrop: boolean): void {
    const reason = this.housing.clearSoil(this.uid, tier, slot, discardCrop);
    if (reason) { this.deny(reason); return; }
    this.showMsg(discardCrop ? '작물을 버리고 흙을 비웠습니다' : '흙을 비웠습니다 (흙 · 소켓은 돌려받지 않습니다)', 'info');
  }

  /* ── the upgrade modal ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!this.housing.getPlacedByUid(this.uid)) return;
    this.hideTip();
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  /** The next level's growth speed is derived from `Rules.growStationSpeedPct` (2026-09-13 — an upgrade raises speed, not tiers). */
  private upgradeSpec(): UpgradeSpec | null {
    const h = this.housing;
    const station = h.getPlacedByUid(this.uid);
    const def = station ? h.getFurnitureDef(station.defId) : undefined;
    if (!station || !def) return null;
    const level = station.level;
    const maxLevel = furnitureMaxLevel(def);
    return {
      name: def.name,
      level,
      maxLevel,
      gain: level < maxLevel
        ? `성장 속도 +${growStationSpeedPct(level)}% → +${growStationSpeedPct(level + 1)}% · 자라는 작물에도 바로 적용`
        : '',
      cost: nextFurnitureCost(def, level),
      reason: h.furnitureUpgradeBlock(this.uid),
      requirements: h.furnitureUpgradeRequirements(this.uid),
    };
  }

  /** Every rule and the material spend are inside `HousingRef.upgradeFurniture`. */
  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.deny(reason); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      this.showMsg(`재배 스테이션 Lv.${before + 1} — ${speedText(before + 1)}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
  }

  /* ── hover card · right-click ──────────────────────────────────────────── */
  private onHover(e: PointerEvent): void {
    if (this.drag.dragging) return;
    const t = e.target as Element | null;
    const key = t?.closest<HTMLElement>('.gs-slot')?.dataset.key ?? null;
    const region = regionOf(t);
    if (key === this.hoverKey && region === this.hoverRegion) return;
    this.hoverKey = key;
    this.hoverRegion = region;
    const spec = key ? this.tipSpec(key, region) : null;
    if (spec) this.tip.show(spec, e.clientX, e.clientY);
    else this.tip.hide();
  }

  private hideTip(): void {
    this.hoverKey = null;
    this.tip.hide();
  }

  /** Over the pot the soil card, over the plant space (· the clock · the rest) the crop card. */
  private tipSpec(key: string, region: TipRegion): TipSpec | null {
    const info = this.infoOf(key);
    if (!info || info.locked) return null;
    return region === 'soil' ? this.soilTip(info) : this.plantTip(info);
  }

  /** The soil part below — soil kind · tag · durability · bonus ratio · sockets (2026-09-13: in place of 「남은 수확 n회」). */
  private soilTip(info: GrowSlotInfo): TipSpec {
    if (!info.soilDefId) return { name: '빈 흙구멍', sub: '비어 있음', rows: [], foot: '토양을 끌어다 놓으세요' };
    const h = this.housing;
    const ratio = soilRatio(info);
    const dur = fin(info.soilDurability), max = fin(info.soilDurabilityMax);
    const slots = fin(info.socketSlots);
    const rows: TipRow[] = [
      { k: '속성', v: `${tagLabel(info.soilTag)} 토양` },
      { k: '내구도', v: max > 0 ? `${dur} / ${max}` : '—', tone: max > 0 && dur <= 0 ? 'bad' : undefined },
      {
        k: '보너스',
        v: ratio <= 0 ? '0 % — 흙이 다 닳았습니다' : `${pct(ratio)} % 적용 (내구도 비율)`,
        tone: ratio <= 0 ? 'bad' : ratio >= 1 ? 'good' : undefined,
      },
      ...socketTipRows((id) => h.defOf(id), (id) => h.nameOf(id), 'soil', info.sockets, slots, ratio),
    ];
    const foot = ['우클릭: 흙 비우기'];
    if (slots > 0) foot.push(info.sockets && info.sockets.length >= slots ? '토양 소켓을 놓으면 교체 (옛 소켓 파괴)' : '토양 소켓을 끌어다 놓아 끼웁니다');
    return {
      name: h.nameOf(info.soilDefId),
      sub: '토양',
      color: info.soilTag ? SOIL_TAG_COLOR[info.soilTag] : undefined,
      rows,
      foot: foot.join('\n'),
    };
  }

  /** The plant area above — seed · time left · match · harvest. */
  private plantTip(info: GrowSlotInfo): TipSpec {
    const h = this.housing;
    if (!info.seedDefId) {
      return {
        name: '빈 자리',
        sub: info.soilDefId ? '씨앗을 심을 수 있습니다' : '비어 있음',
        rows: [],
        foot: info.soilDefId ? '씨앗을 끌어다 놓으세요' : '토양을 먼저 부으세요',
      };
    }
    const rows: TipRow[] = [
      { k: '씨앗', v: `${h.nameOf(info.seedDefId)} · ${tagLabel(info.seedTag)} 토양을 좋아함` },
      { k: '남은 시간', v: info.ready ? '수확 가능' : clockText(info.remainingS), tone: info.ready ? 'good' : undefined },
      // the number was fixed into `readyAt` the moment it was planted — this only reads that multiplier back in words (a csv value).
      // 2026-09-13: the match bonus only applies as far as the soil durability ratio. Durability wears only on harvest (= after the crop is gone), so the ratio now is the ratio at planting.
      info.matched
        ? { k: '궁합', v: `맞음 · 성장 시간 −${pct(SOIL_MATCH_SPEEDUP * soilRatio(info))} %`, tone: 'good' }
        : { k: '궁합', v: `어긋남 · 성장 시간 +${pct(SOIL_MISMATCH_PENALTY)} %`, tone: 'bad' },
    ];
    // 2026-09-13: the station level's growth speed — an upgrade applies to growing crops at once
    const station = h.getPlacedByUid(this.uid);
    if (station) rows.push({ k: '스테이션', v: `Lv.${station.level} · ${speedText(station.level)}`, tone: station.level > 1 ? 'good' : undefined });
    if (info.yieldDefId) rows.push({ k: '수확물', v: `${h.nameOf(info.yieldDefId)} ×${info.yieldQty}` });
    return {
      name: h.nameOf(info.seedDefId),
      sub: info.ready ? '수확 가능' : '자라는 중',
      rows,
      foot: info.ready ? '더블클릭 · 끌어다 놓기: 수확' : '',
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
    const socketCount = info.sockets?.length ?? 0;
    const label = planted ? '작물 버리고 흙 비우기' : '흙 비우기';
    this.menu.show(e.clientX, e.clientY, [{
      label,
      danger: planted || socketCount > 0,
      run: () => {
        if (!socketCount) { this.clearSoil(info.tier, info.slot, planted); return; }
        // 2026-09-13 (user's decision 「clearing a slot loses the soil and the sockets with it」): a clear that loses permanent sockets asks with a 1 s hold
        this.sockAsk.confirm({
          id: 'hs-soil-clear',
          title: label,
          body: `소켓도 함께 사라집니다 — 끼운 소켓 ${socketCount}개와 흙은 돌려받지 않습니다.${planted ? '\n자라는 작물도 버립니다.' : ''}`,
          label: '비우기',
          run: () => this.clearSoil(info.tier, info.slot, planted),
        });
      },
    }]);
  }

  /* ── the station list on the left (`StationShell.rail`) ────────────────── */
  /** Every grow station placed in the ship — picked by `interaction` (no defId is written into the code). */
  private stations(): readonly PlacedFurniture[] {
    return this.housing.getPlaced().filter((p) => this.housing.getFurnitureDef(p.defId)?.interaction === 'grow_station');
  }

  /**
   * The list is built only when the set of stations changes. It is **not hidden even with a single station** — the 3×3 status
   * dots and the red dot answer 「is anything ripe right now」 on a one-station ship too, and it has to stand in the same place
   * and at the same width as the analyzer's tab rail, or the left edge of the two screens goes out of step.
   */
  private buildRail(list: readonly PlacedFurniture[]): void {
    const rail = this.shell.rail;
    clear(rail);
    this.railItems = [];
    rail.hidden = list.length === 0;
    list.forEach((p, i) => {
      const btn = el('button', { cls: 'hs-rail-item', attrs: { 'data-uid': p.uid }, parent: rail });
      btn.type = 'button';
      const red = el('i', { cls: 'hs-rail-red', parent: btn });   // it always takes its space and shows only while `.on`
      const name = this.housing.getFurnitureDef(p.defId)?.name ?? '재배 스테이션';
      el('span', { cls: 'hs-rail-name', text: `${name} ${i + 1}`, parent: btn });
      const dotsEl = el('span', { cls: 'hs-rail-dots', parent: btn });
      const dots = this.housing.getGrowSlots(p.uid).map(() => el('i', { parent: dotsEl }));
      this.railItems.push({ uid: p.uid, el: btn, dots, red });
    });
  }

  /** Repaints only the dot colours · the red dot · the selection mark (the same place as the 1 s tick). */
  private paintRail(): void {
    for (const it of this.railItems) {
      toggleClass(it.el, 'is-active', it.uid === this.uid);
      const slots = this.housing.getGrowSlots(it.uid);
      for (let i = 0; i < it.dots.length; i++) {
        const s = slots[i];
        const alive = !!s && !s.locked && !!s.soilDefId && !!s.seedDefId;
        toggleClass(it.dots[i], 'growing', alive && !s!.ready);      // grey = growing
        toggleClass(it.dots[i], 'ready', alive && !!s!.ready);       // green = ready to harvest (the rest are black)
      }
      toggleClass(it.red, 'on', this.housing.readyCount(it.uid) > 0);
    }
  }

  private onRailClick(e: MouseEvent): void {
    const uid = (e.target as Element | null)?.closest<HTMLElement>('.hs-rail-item')?.dataset.uid;
    if (!uid || uid === this.uid) return;
    e.stopPropagation();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.hideTip();
    this.drag.end();
    this.sockAsk.close();
    this.uid = uid;                       // `builtKey` holds the uid, so `refresh()` rebuilds the tiers
    this.refresh();
    this.ctx.bus.emit('ui:growToggled', { open: true, uid });
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const list = this.stations();
    const railKey = list.map((p) => p.uid).join(',');
    if (railKey !== this.railKey) { this.railKey = railKey; this.buildRail(list); }
    const station = h.getPlacedByUid(this.uid);
    const def = station ? h.getFurnitureDef(station.defId) : undefined;
    setText(this.shell.title, def?.name ?? '재배 스테이션');
    paintStationLevel(this.shell, station && def ? station.level : null, def ? furnitureMaxLevel(def) : 0);
    paintStationMeta(this.shell, station ? speedText(station.level) : '');
    const infos = station ? h.getGrowSlots(this.uid) : [];
    const key = station ? `${this.uid}:${station.level}` : '';
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(infos);
    }
    this.paint(infos);
    this.modal.refresh();
  }

  /** Rebuild the tier rows — only when the station (or its level) changed. */
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
      // `GrowSlotInfo.locked` is false for every tier today (2026-09-13 — `growTiersForLevel` opens all three from Lv.1), so this
      // branch and `.gs-tier.is-locked` are unreachable in play. Both are **kept on purpose**: the contract still reports `locked` ·
      // `unlockLevel`, so refilling `growTiersForLevel` revives the tier gate with no screen change (the analyzer · culture tank
      // draw their locked slots from the same field, and theirs do appear).
      const locked = rows[0].locked;
      const row = el('div', { cls: `gs-tier${locked ? ' is-locked' : ''}`, attrs: { 'data-tier-row': String(tier) }, parent: this.tiersEl });
      if (locked) continue;                                 // an un-upgraded tier is an outline only
      const body = el('div', { cls: 'gs-tier-body', parent: row });
      el('div', { cls: 'gs-bar', parent: body });           // a long white horizontal bar = one tier
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
    // the socket dots float over the soil (**inside** the pot — they do not touch the height of the clock line below it)
    const socks = el('span', { cls: 'gs-socks', parent: pot });
    socks.hidden = true;
    const time = el('div', { cls: 'gs-time hs-clock', text: '', parent: wrap });
    return { key, wrap, soil, socks, leaf, time };
  }

  /** Cheap repaint (open · every change · 1 s tick): classes, soil colour, growth `--g`, socket dots, the clock. */
  private paint(infos: readonly GrowSlotInfo[] = this.housing.getGrowSlots(this.uid)): void {
    this.debug.paints++;
    this.paintRail();
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
      // 2026-09-13: soil worn all the way down (bonus ratio 0) goes pale — it is still usable
      toggleClass(card.wrap, 'is-worn', hasSoil && soilRatio(info) <= 0);

      const color = info.soilTag ? SOIL_TAG_COLOR[info.soilTag] : '';
      if (card.soil.dataset.c !== color) { card.soil.dataset.c = color; card.soil.style.background = color; }
      paintSocketDots(card.socks, hasSoil ? info.socketSlots : 0, info.sockets?.length ?? 0);

      const g = planted ? (info.ready ? 1 : Math.max(0, Math.min(1, info.progress))) : 0;
      const gs = g.toFixed(3);
      if (card.wrap.dataset.g !== gs) { card.wrap.dataset.g = gs; card.wrap.style.setProperty('--g', gs); }

      // the seed glyph while growing, the harvest glyph once ripe (the item table's icon — no external asset)
      const iconDef = planted ? this.housing.defOf(info.ready && info.yieldDefId ? info.yieldDefId : info.seedDefId!) : undefined;
      setText(card.leaf, planted ? (iconDef?.icon || '❁') : '');

      // it always takes its space (2026-09-12, user's decision): with no soil 「토양 필요」 (red), with soil only `00:00` (dimmed).
      // CSS picks the colour · weight from `.has-soil` / `.is-planted` / `.is-ready` — the height is the same either way.
      if (!hasSoil) renderClockText(card.time, '토양 필요');
      else if (!planted) renderClockText(card.time, '00:00');
      else if (info.ready) renderClockText(card.time, '수확 가능');
      else renderClock(card.time, info.remainingS);
    }
    if (this.hoverKey && this.tip.isShown) {
      const spec = this.tipSpec(this.hoverKey, this.hoverRegion);
      if (spec) this.tip.update(spec);
      else this.hideTip();
    }
  }

  override dispose(): void {
    this.stopTicking();
    this.drag.dispose();
    this.modal.dispose();
    this.sockAsk.close();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
