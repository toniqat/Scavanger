import type { FacilityId, GameContext } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { HousingPanel } from './Panel';
import { clear, el, levelText, renderCost, setText, toggleClass } from './dom';

const FACILITY_DESC: Readonly<Record<FacilityId, string>> = {
  generator: '모든 시설과 작업대는 발전기 레벨 이상으로 올릴 수 없습니다.',
  storage: '함선 창고(Tab)의 칸 수를 늘립니다.',
  workshop: '작업실 방의 레벨. 제작 재료 비용을 줄입니다.',
  range: '사격장 방의 레벨. 프리셋 슬롯과 사격 숙련 상승량을 늘립니다.',
};

/**
 * 시설 메뉴 (`openFacilityMenu()`): generator / storage / workshop / range rows with level, pip bar, next cost
 * (red when short), 한국어 block reason and the upgrade button; a summary of every derived number underneath.
 */
export class FacilityMenu extends HousingPanel {
  private rows = new Map<FacilityId, { root: HTMLElement; level: HTMLElement; pips: HTMLElement; cost: HTMLElement; blocked: HTMLElement; btn: HTMLButtonElement }>();
  private summary: HTMLElement;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'facility', 'facility-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '함선 시설', parent: hl });
    el('div', { cls: 'subtitle', text: '발전기가 다른 모든 업그레이드의 상한입니다.', parent: hl });
    this.button(head, '프리셋', () => { this.close(false); housing.openPresetMenu(); }, 'small');

    const page = el('div', { cls: 'hs-page', parent: f });
    const sec = this.section(page, '시설');
    const list = el('div', { cls: 'hs-list', parent: sec });
    for (const info of housing.getFacilities()) {
      const row = el('div', { cls: 'hs-row facility', parent: list, attrs: { 'data-facility': info.id } });
      const mid = el('div', { cls: 'mid', parent: row });
      const nl = el('div', { cls: 'name-line', parent: mid });
      el('span', { cls: 'name', text: info.name, parent: nl });
      const level = el('span', { cls: 'tag', text: '', parent: nl });
      const pips = el('div', { cls: 'pips', parent: nl });
      for (let i = 0; i < info.maxLevel; i++) el('i', { parent: pips });
      el('div', { cls: 'desc', text: FACILITY_DESC[info.id], parent: mid });
      const cost = el('div', { cls: 'cost', parent: mid });
      const blocked = el('div', { cls: 'blocked', text: '', parent: mid });
      const btn = this.button(row, '업그레이드', () => this.upgrade(info.id), 'small');
      this.rows.set(info.id, { root: row, level, pips, cost, blocked, btn });
    }
    const secSum = this.section(page, '효과');
    this.summary = el('div', { cls: 'hs-summary', parent: secSum });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    el('div', { cls: 'left', parent: foot });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  open(): void { this.openPanel(); }

  private upgrade(id: FacilityId): void {
    const info = this.housing.getFacility(id);
    if (info.blocked) { this.showMsg(info.blocked, 'warning'); return; }
    if (this.housing.upgrade(id)) this.showMsg(`${info.name} Lv.${info.level + 1}`, 'success');
    else this.showMsg('업그레이드에 실패했습니다', 'danger');
    this.refresh();
  }

  refresh(): void {
    const h = this.housing;
    for (const info of h.getFacilities()) {
      const r = this.rows.get(info.id)!;
      setText(r.level, levelText(info.level, info.maxLevel));
      const pips = Array.from(r.pips.children) as HTMLElement[];
      pips.forEach((p, i) => toggleClass(p, 'on', i < info.level));
      if (info.nextCost) renderCost(r.cost, info.nextCost, h.countDef, h.nameOf);
      else { clear(r.cost); el('span', { cls: 'mat free', text: info.level >= info.maxLevel ? '최대 레벨' : '—', parent: r.cost }); }
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
    line('작업대', (['gun', 'gear', 'gadget', 'medical'] as const).map((k) => `${k === 'gun' ? '총기' : k === 'gear' ? '장비' : k === 'gadget' ? '가젯' : '의학'} Lv.${h.getBenchLevel(k)}`).join(' · '));
  }
}
