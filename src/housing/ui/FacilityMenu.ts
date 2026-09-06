import type { GameContext } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { FacilityRows } from './FacilityRows';
import { HousingPanel } from './Panel';
import { el } from './dom';

/**
 * 시설 메뉴 (`openFacilityMenu()`): the shared `FacilityRows` renderer (generator / storage / workshop / range rows
 * with level, pip bar, item-chip cost, 한국어 block reason and the upgrade button, plus the derived summary) inside a
 * standalone housing panel. The 함선 tab of the Tab screen renders the very same rows through `createShipView`.
 */
export class FacilityMenu extends HousingPanel {
  private facilities: FacilityRows;

  constructor(ctx: GameContext, housing: HousingSystem) {
    super(ctx, 'facility', 'facility-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '함선 시설', parent: hl });
    el('div', { cls: 'subtitle', text: '발전기가 다른 모든 업그레이드의 상한입니다.', parent: hl });
    this.button(head, '프리셋', () => { this.close(false); housing.openPresetMenu(); }, 'small');

    const page = el('div', { cls: 'hs-page', parent: f });
    this.facilities = new FacilityRows(page, ctx, housing, (text, kind) => this.showMsg(text, kind));

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    el('div', { cls: 'left', parent: foot });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  open(): void { this.openPanel(); }

  refresh(): void { this.facilities.refresh(); }
}
