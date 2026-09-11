import type {
  EmbeddedView, FurnitureDef, GameContext, GrowSlotInfo, GrowTier, ItemInstance, PlacedFurniture,
} from '@/shared';
import {
  GROW_SLOTS_PER_TIER, GROW_TIER_DRAW_ORDER, GROW_TIER_LABEL_KO, SOIL_TAG_COLOR, SOIL_TAG_LABEL_KO, growTiersForLevel,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { CHIP_SIZE, clear, el, formatRemaining, levelText, renderCost, setText, toggleClass } from './dom';

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;

interface SlotCard {
  tier: GrowTier;
  slot: number;
  pot: HTMLElement;
  soil: HTMLElement;
  crop: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  line: HTMLElement;
  sub: HTMLElement;
  harvest: HTMLButtonElement;
  clear: HTMLButtonElement;
}

/**
 * **재배 화면** (온실 개편, 2026-09-11 — `openGrowStation(uid)` ← E on a 재배 스테이션).
 *
 * 좌 = 재배층, 우 = 가방 + 함선 창고. 한 층은 **가로로 긴 하얀 바** 하나이고 그 위에 **위가 살짝 잘린 원**
 * (토양을 담는 곳)이 `GROW_SLOTS_PER_TIER` 개 놓인다. 흙을 부으면 원 안이 토양 색(`SOIL_TAG_COLOR`)으로 80 %
 * 높이까지 차고, 씨앗을 심으면 그 위에 씨앗 · 새싹이 보이며 진행바 · 남은 실시간 · 수확 버튼이 함께 산다.
 *
 * 오른쪽은 `ctx.inventory.createTradeGrids` 가 그리는 **진짜 가방 · 함선 창고 격자**(제작 창과 같은 칸 크기
 * 54 px)다: 토양이나 씨앗을 끌어서 원에 떨어뜨리면 `fillSoil` / `plantSeedAt` 이 돌고, 규칙이 거절하면
 * 한국어 사유가 메시지 줄에 뜬다. 잠긴 층은 흐리게 + 「Lv.N 강화로 열립니다」이고 드롭 대상이 아니다
 * (`dropSelector` 가 `:not(.is-locked)` 이다).
 *
 * 화면은 상태를 **읽기만** 한다 — 타이머는 `ShipState.grows` 에 있고, 1초 틱은 글자 · 바 · 버튼만 다시 칠한다.
 *
 * **강화 줄** (2026-09-11): 재배층을 여는 것은 가구 레벨인데 `upgradeFurniture` 를 부르는 UI 가 게임 어디에도
 * 없어 Lv.2 · Lv.3 이 닿을 수 없는 콘텐츠였다 (옛 방 메뉴가 Phase 8 에 시설 관리로 리다이렉트되면서 사라졌다).
 * 그래서 이 화면이 자기 스테이션을 강화한다 — 재배층 열 **위**에 `Lv.n / 3` · 다음 레벨이 여는 층 · 비용 칩
 * (`renderCost` → `shared/itemChip`) · 「강화」 버튼 한 줄. 사유는 전부 `furnitureUpgradeBlock(uid)` 의 한국어
 * 한 줄이고 (버튼 비활성 + 인라인), 성공하면 `housing:changed` → `refresh()` 가 새 층을 그리고 우측 격자도
 * 다시 그린다 (재료가 가방 · 창고에서 빠지므로). 되돌릴 수 있는 확정이라 1초 홀드는 쓰지 않는다.
 */
export class GrowStation extends HousingPanel {
  private uid = '';
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly tiersEl: HTMLElement;
  private readonly upRow: HTMLElement;
  private readonly upLevel: HTMLElement;
  private readonly upNext: HTMLElement;
  private readonly upCost: HTMLElement;
  private readonly upNote: HTMLElement;
  private readonly btnUp: HTMLButtonElement;
  private readonly invHost: HTMLElement;
  private readonly invNote: HTMLElement;
  private readonly btnAll: HTMLButtonElement;
  private grids: EmbeddedView | null = null;
  private cards: SlotCard[] = [];
  private timer = 0;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'grow', 'grow-station');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '재배 스테이션', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const body = el('div', { cls: 'gs-body', parent: f });
    const left = el('div', { cls: 'gs-left', parent: body });

    // 강화 줄 — 재배층을 여는 유일한 입구 (가구 레벨 = 재배층 수)
    this.upRow = el('div', { cls: 'gs-up', parent: left });
    const upMain = el('div', { cls: 'gs-up-main', parent: this.upRow });
    const upHead = el('div', { cls: 'gs-up-head', parent: upMain });
    this.upLevel = el('span', { cls: 'lv', text: '', parent: upHead });
    this.upNext = el('span', { cls: 'next', text: '', parent: upHead });
    this.upCost = el('div', { cls: 'gs-up-cost', parent: upMain });
    this.upNote = el('div', { cls: 'gs-up-note', text: '', parent: upMain });
    this.btnUp = this.button(this.upRow, '강화', () => this.upgrade(), 'small primary gs-up-btn');

    this.tiersEl = el('div', { cls: 'gs-tiers', parent: left });

    const right = el('div', { cls: 'gs-right', parent: body });
    el('div', { cls: 'ui-label', text: '가방 · 함선 창고', parent: right });
    this.invNote = el('div', { cls: 'hint', text: '토양 · 씨앗을 왼쪽 재배 칸으로 끌어다 놓으세요.', parent: right });
    this.invHost = el('div', { cls: 'gs-inv', parent: right });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const footLeft = el('div', { cls: 'left', parent: foot });
    this.btnAll = this.button(footLeft, '모두 수확', () => this.harvestAll(), 'primary');
    el('div', { cls: 'hint', text: '작물은 현실 시간에 맞춰 자랍니다 — 함선을 떠나도 계속 자랍니다.', parent: footLeft });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 재배 스테이션. */
  openStation(uid: string): void {
    this.uid = uid;
    this.openPanel();
    this.mountGrids();
    this.startTicking();
    this.ctx.bus.emit('ui:growToggled', { open: true, uid });
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    this.stopTicking();
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
    if (wasOpen) this.ctx.bus.emit('ui:growToggled', { open: false, uid: null });
  }

  /**
   * The 가방 / 함선 창고 grids are built **lazily**: housing/ is registered before inventory/, so `ctx.inventory`
   * does not exist yet when this panel is constructed. Same cell edge as the 제작 창 (the view's default, 54 px).
   */
  private mountGrids(): void {
    if (this.grids) return;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.createTradeGrids !== 'function') {
      setText(this.invNote, '인벤토리를 사용할 수 없습니다');
      return;
    }
    setText(this.invNote, '토양 · 씨앗을 왼쪽 재배 칸으로 끌어다 놓으세요.');
    this.grids = inv.createTradeGrids(this.invHost, {
      grids: ['bag', 'stash'],
      dropSelector: '.gs-pot:not(.is-locked)',
      onTake: (item, _gridId, target) => this.dropOn(item, target),
    });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the 가방 / 창고 onto a 재배 칸 (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('토양 · 씨앗을 재배 칸으로 끌어다 놓으세요', 'info'); return; }
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
    this.refresh();
  }

  private harvest(tier: GrowTier, slot: number): void {
    const reason = this.housing.harvestAt(this.uid, tier, slot);
    this.showMsg(reason ?? '수확 완료 — 가방이 차면 함선 창고로 들어갑니다', reason ? 'warning' : 'success');
    this.refresh();
  }

  private clearSoil(tier: GrowTier, slot: number): void {
    const reason = this.housing.clearSoil(this.uid, tier, slot);
    this.showMsg(reason ?? '흙을 비웠습니다 (남은 횟수는 돌려받지 않습니다)', reason ? 'warning' : 'info');
    this.refresh();
  }

  /**
   * 스테이션 한 단계 강화 = 재배층 한 층 개방. 규칙 · 재료 소모는 전부 `HousingRef.upgradeFurniture` 안에 있고
   * 여기서는 그 앞에 `furnitureUpgradeBlock` 의 한국어 사유를 한 번 더 보여 줄 뿐이다 (버튼이 이미 비활성이라
   * 보통은 닿지 않지만, 두 번 클릭 사이에 재료가 빠졌을 수 있다).
   */
  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.showMsg(reason, 'warning'); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      const opened = growTiersForLevel(before + 1).filter((t) => !growTiersForLevel(before).includes(t));
      const what = opened.map((t) => GROW_TIER_LABEL_KO[t]).join(' · ');
      this.showMsg(`재배 스테이션 Lv.${before + 1}${what ? ` — ${what} 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
    this.refresh();                 // 새 층 + 재료가 빠진 가방 · 창고를 곧바로 그린다
  }

  private harvestAll(): void {
    const n = this.housing.harvestAllStation(this.uid);
    this.showMsg(n > 0 ? `${n}칸 수확 완료` : '수확할 수 있는 칸이 없습니다', n > 0 ? 'success' : 'info');
    this.refresh();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const station = h.getPlacedByUid(this.uid);
    const def = station ? h.getFurnitureDef(station.defId) : undefined;
    setText(this.title, station ? `재배 스테이션 · 방 ${station.room + 1}` : '재배 스테이션');
    const open = station ? h.getGrowSlots(this.uid).filter((s) => !s.locked).length / GROW_SLOTS_PER_TIER : 0;
    setText(this.subtitle, station
      ? `Lv.${station.level} / ${def?.maxLevel ?? station.level} · 재배층 ${open}층 · 층마다 ${GROW_SLOTS_PER_TIER}칸`
      : '재배 스테이션이 사라졌습니다.');

    this.paintUpgrade(station, def);
    this.build(h.getGrowSlots(this.uid));
    this.grids?.refresh();          // 수확물 · 강화 재료가 오간 것이 곧바로 보이도록
    this.paint();
  }

  /** 강화 줄: 현재 레벨 · 다음 레벨이 여는 층 · 비용 칩 · 버튼 (사유는 `furnitureUpgradeBlock` 한 줄). */
  private paintUpgrade(station: PlacedFurniture | null, def: FurnitureDef | undefined): void {
    const max = def ? furnitureMaxLevel(def) : 0;
    const level = station?.level ?? 0;
    const atMax = !station || !def || level >= max;
    setText(this.upLevel, station && def ? levelText(level, max) : '—');

    const cost = station && def ? nextFurnitureCost(def, level) : null;
    if (cost) {
      renderCost(this.upCost, cost, this.housing, CHIP_SIZE);
    } else {
      clear(this.upCost);
      el('span', { cls: 'item-chip-free', text: atMax ? '최대 레벨' : '—', parent: this.upCost });
    }

    // 다음 레벨이 여는 층은 계약 `growTiersForLevel` 에서 유도한다 (코드에 층 번호를 적지 않는다)
    const opened = station && !atMax
      ? growTiersForLevel(level + 1).filter((t) => !growTiersForLevel(level).includes(t))
      : [];
    setText(this.upNext, opened.length
      ? `강화하면 ${opened.map((t) => GROW_TIER_LABEL_KO[t]).join(' · ')} 개방`
      : atMax && station ? '모든 재배층이 열렸습니다' : '');

    const reason = station ? this.housing.furnitureUpgradeBlock(this.uid) : '재배 스테이션이 사라졌습니다';
    setText(this.upNote, reason ?? '강화할 수 있습니다');
    toggleClass(this.upNote, 'ok', !reason);
    this.btnUp.disabled = !!reason;
    this.btnUp.title = reason ?? '';
    toggleClass(this.upRow, 'is-max', atMax);
  }

  /** Rebuild the 재배층 rows (the station level may have changed since the last open). */
  private build(infos: readonly GrowSlotInfo[]): void {
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
      const row = el('div', { cls: `gs-tier${locked ? ' is-locked' : ''}`, parent: this.tiersEl });
      const head = el('div', { cls: 'gs-tier-head', parent: row });
      el('span', { cls: 'name', text: GROW_TIER_LABEL_KO[tier], parent: head });
      el('span', {
        cls: 'state',
        text: locked
          // 강화 줄이 바로 위에 있으므로 어디를 누르면 열리는지까지 말한다
          ? `🔒 Lv.${rows[0].unlockLevel} 강화로 열립니다 · 위 「강화」`
          : `${rows.filter((r) => r.soilDefId).length} / ${GROW_SLOTS_PER_TIER}칸 사용 중`,
        parent: head,
      });
      const body = el('div', { cls: 'gs-tier-body', parent: row });
      body.style.gridTemplateColumns = `repeat(${GROW_SLOTS_PER_TIER}, minmax(0, 1fr))`;
      el('div', { cls: 'gs-bar', parent: body });       // 가로로 긴 하얀 바 = 한 층
      for (const info of rows) this.cards.push(this.buildSlot(body, info));
    }
  }

  private buildSlot(parent: HTMLElement, info: GrowSlotInfo): SlotCard {
    const wrap = el('div', { cls: 'gs-slot', parent });
    const pot = el('div', {
      cls: `gs-pot${info.locked ? ' is-locked' : ''}`,
      attrs: info.locked ? {} : { 'data-tier': String(info.tier), 'data-slot': String(info.slot) },
      parent: wrap,
    });
    const soil = el('i', { cls: 'gs-soil', parent: pot });
    const crop = el('span', { cls: 'gs-crop', text: '', parent: pot });
    const prog = el('div', { cls: 'gs-prog', parent: wrap });
    const fill = el('i', { parent: prog });
    const line = el('div', { cls: 'gs-line', text: '', parent: wrap });
    const sub = el('div', { cls: 'gs-sub', text: '', parent: wrap });
    const acts = el('div', { cls: 'gs-acts', parent: wrap });
    const harvest = this.button(acts, '수확', () => this.harvest(info.tier, info.slot), 'small primary');
    const clearBtn = this.button(acts, '흙 비우기', () => this.clearSoil(info.tier, info.slot), 'small');
    return { tier: info.tier, slot: info.slot, pot, soil, crop, prog, fill, line, sub, harvest, clear: clearBtn };
  }

  /** Cheap per-second repaint: soil fill, progress, countdown and button states only. */
  private paint(): void {
    const infos = this.housing.getGrowSlots(this.uid);
    const byKey = new Map<string, GrowSlotInfo>();
    for (const i of infos) byKey.set(`${i.tier}:${i.slot}`, i);
    let ready = 0;
    for (const card of this.cards) {
      const info = byKey.get(`${card.tier}:${card.slot}`);
      if (!info) continue;
      const hasSoil = !!info.soilDefId;
      const planted = !!info.seedDefId;
      if (info.ready) ready++;
      toggleClass(card.pot, 'has-soil', hasSoil);
      toggleClass(card.pot, 'is-planted', planted);
      toggleClass(card.pot, 'is-ready', info.ready);

      // 흙: 원 안이 토양 색으로 80 % 높이까지 찬다
      card.soil.style.height = hasSoil ? '80%' : '0%';
      if (info.soilTag) card.soil.style.background = SOIL_TAG_COLOR[info.soilTag];

      // 씨앗 · 새싹: 아이템 글리프 (외부 에셋 없음)
      const seedDef = info.seedDefId ? this.housing.defOf(info.seedDefId) : undefined;
      setText(card.crop, info.locked ? '✕' : planted ? (seedDef?.icon || '❁') : '');

      card.prog.hidden = !planted;
      card.fill.style.width = planted ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';

      if (info.locked) {
        setText(card.line, '잠긴 재배층');
        setText(card.sub, `Lv.${info.unlockLevel} 강화로 열립니다`);   // 강화 줄이 이 화면 위에 있다
      } else if (!hasSoil) {
        setText(card.line, '흙 없음');
        setText(card.sub, '토양을 끌어다 놓으세요');
      } else if (!planted) {
        setText(card.line, `${this.housing.nameOf(info.soilDefId!)} · 수확 ${info.soilUsesLeft}회 남음`);
        setText(card.sub, `${info.soilTag ? SOIL_TAG_LABEL_KO[info.soilTag] : '알 수 없는'} 속성 · 씨앗을 끌어다 놓으세요`);
      } else if (info.ready) {
        const name = info.yieldDefId ? this.housing.nameOf(info.yieldDefId) : '수확물';
        setText(card.line, `${name} ×${info.yieldQty} 수확 준비`);
        setText(card.sub, `흙 ${info.soilUsesLeft}회 남음 · 수확하면 1회 소모`);
      } else {
        setText(card.line, `${formatRemaining(info.remainingS)} 남음`);
        setText(card.sub, this.matchText(info));
      }

      card.harvest.hidden = !planted;
      card.harvest.disabled = !info.ready;
      card.clear.hidden = !hasSoil || planted;
    }
    this.btnAll.disabled = ready === 0;
    setText(this.btnAll, ready > 0 ? `모두 수확 (${ready})` : '모두 수확');
  }

  /** 「궁합」 한 줄: 맞으면 빨리, 아니면 느리게 자란다 (수치는 심는 순간 이미 확정돼 있다). */
  private matchText(info: GrowSlotInfo): string {
    const soil = info.soilTag ? SOIL_TAG_LABEL_KO[info.soilTag] : '알 수 없는';
    const seed = info.seedTag ? SOIL_TAG_LABEL_KO[info.seedTag] : '알 수 없는';
    return info.matched ? `${soil} 토양 · 궁합 맞음 (빠르게 자람)` : `${soil} 토양 · ${seed} 씨앗 — 궁합 어긋남 (느리게 자람)`;
  }

  override dispose(): void {
    this.stopTicking();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
