import type { FacilityId, GameContext } from '@/shared';
import { FACILITY_COLOR, FACILITY_GLYPH } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { CHIP_SIZE, clear, el, facilityThumb, levelText, renderCost, section, setText, toggleClass } from './dom';

type Msg = (text: string, kind: 'info' | 'success' | 'warning' | 'danger') => void;

interface Row {
  root: HTMLElement;
  level: HTMLElement;
  pips: HTMLElement;
  cost: HTMLElement;
  blocked: HTMLElement;
  btn: HTMLButtonElement;
}

/**
 * 시설 rows + the derived summary for the embedded 함선 tab (`ShipView`). It only touches the host element it is
 * given: **no blocker, no pointer lock, no window listener** — the caller (the inventory window) owns those.
 *
 * Phase 8 UI pass: the caller picks **which** facilities to list. The 함선 tab passes the two ship-wide ones
 * (발전기 · 창고); 작업실 / 사격장 are room facilities now and are upgraded from their row in the 방 목록.
 *
 * Phase 9 UI pass: each row leads with the shared facility thumbnail (`FACILITY_GLYPH` / `FACILITY_COLOR`) and the
 * per-facility explainer lines are gone — the level pips, the cost chips and the block reason already say it.
 */
export class FacilityRows {
  private rows = new Map<FacilityId, Row>();
  private summary: HTMLElement;

  constructor(
    host: HTMLElement, private readonly ctx: GameContext, private readonly housing: HousingSystem,
    private readonly onMsg: Msg, private readonly ids: readonly FacilityId[] = ['generator', 'storage', 'workshop', 'range'],
    label = '시설',
  ) {
    const sec = section(host, label);
    const list = el('div', { cls: 'hs-list', parent: sec });
    for (const info of ids.map((id) => housing.getFacility(id))) {
      const row = el('div', { cls: 'hs-row facility', parent: list, attrs: { 'data-facility': info.id } });
      facilityThumb(row, FACILITY_GLYPH[info.id], FACILITY_COLOR[info.id]);
      const mid = el('div', { cls: 'mid', parent: row });
      const nl = el('div', { cls: 'name-line', parent: mid });
      el('span', { cls: 'name', text: info.name, parent: nl });
      const level = el('span', { cls: 'tag', text: '', parent: nl });
      const pips = el('div', { cls: 'pips', parent: nl });
      for (let i = 0; i < info.maxLevel; i++) el('i', { parent: pips });
      const cost = el('div', { cls: 'cost', parent: mid });
      const blocked = el('div', { cls: 'blocked', text: '', parent: mid });
      const btn = el('button', { cls: 'ui-btn small wide', text: '업그레이드', parent: row });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.upgrade(info.id);
      });
      this.rows.set(info.id, { root: row, level, pips, cost, blocked, btn });
    }
    const secSum = section(host, '효과');
    this.summary = el('div', { cls: 'hs-summary', parent: secSum });
  }

  private upgrade(id: FacilityId): void {
    const info = this.housing.getFacility(id);
    if (info.blocked) { this.onMsg(info.blocked, 'warning'); return; }
    if (this.housing.upgrade(id)) this.onMsg(`${info.name} Lv.${info.level + 1}`, 'success');
    else this.onMsg('업그레이드에 실패했습니다', 'danger');
    this.refresh();
  }

  refresh(): void {
    const h = this.housing;
    for (const info of this.ids.map((id) => h.getFacility(id))) {
      const r = this.rows.get(info.id);
      if (!r) continue;
      setText(r.level, levelText(info.level, info.maxLevel));
      const pips = Array.from(r.pips.children) as HTMLElement[];
      pips.forEach((p, i) => toggleClass(p, 'on', i < info.level));
      if (info.nextCost) renderCost(r.cost, info.nextCost, h, CHIP_SIZE);
      else { clear(r.cost); el('span', { cls: 'item-chip-free', text: info.level >= info.maxLevel ? '최대 레벨' : '—', parent: r.cost }); }
      setText(r.blocked, info.blocked ?? '업그레이드 가능');
      toggleClass(r.blocked, 'ok', !info.blocked);
      r.btn.disabled = !!info.blocked;
      r.btn.title = info.blocked ?? '';
      toggleClass(r.root, 'max', info.level >= info.maxLevel);
    }
    const stash = h.getStashSize();
    clear(this.summary);
    const line = (k: string, v: string): void => {
      const row = el('div', { cls: 'line', parent: this.summary });
      el('span', { cls: 'k', text: k, parent: row });
      el('span', { cls: 'v', text: v, parent: row });
    };
    line('창고 크기', `${stash.cols} × ${stash.rows} 칸`);
    line('제작 비용 배율', `×${h.getCraftCostMul().toFixed(2)}`);
    line('로드아웃 프리셋', `${h.getPresetCount()} 슬롯`);
    line('사격 숙련 상승', `×${h.getSkillGainMul('gun_AR').toFixed(1)}`);
    line('작업대', (['gun', 'gear', 'gadget', 'medical'] as const)
      .map((k) => `${k === 'gun' ? '총기' : k === 'gear' ? '장비' : k === 'gadget' ? '가젯' : '의학'} Lv.${h.getBenchLevel(k)}`).join(' · '));
  }
}
