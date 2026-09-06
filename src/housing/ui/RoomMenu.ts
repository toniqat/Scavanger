import type { FacilityId, GameContext, RoomPurpose } from '@/shared';
import { ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_DESC_KO, ROOM_PURPOSE_LABEL_KO, furnitureFootprint } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { clear, el, levelText, renderCost, setText, toggleClass } from './dom';

const YAW_LABEL = ['0°', '90°', '180°', '270°'];

/**
 * 방 메뉴 (`openRoomMenu(room)`): purpose picker (active purposes highlighted, the other seven carry a
 * "다음 업데이트" badge but can still be assigned for decoration), room level upgrade (작업실 / 사격장), furniture
 * storage (placeable here? · qty · 배치 → housing mode with that piece selected), placed furniture (upgrade /
 * recover), craftable furniture (cost, red when short) and the 하우징 모드 button.
 */
export class RoomMenu extends HousingPanel {
  private room = 0;
  private title: HTMLElement;
  private subtitle: HTMLElement;
  private purposeGrid: HTMLElement;
  private purposeHint: HTMLElement;
  private secLevel: HTMLElement;
  private levelText: HTMLElement;
  private levelCost: HTMLElement;
  private levelBlocked: HTMLElement;
  private btnLevel: HTMLButtonElement;
  private storageList: HTMLElement;
  private placedList: HTMLElement;
  private craftList: HTMLElement;
  private btnHousing: HTMLButtonElement;
  private housingHint: HTMLElement;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'room', 'room-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '방', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });
    this.button(head, '시설', () => { this.close(false); housing.openFacilityMenu(); }, 'small');

    const page = el('div', { cls: 'hs-page', parent: f });

    const secPurpose = this.section(page, '용도');
    this.purposeGrid = el('div', { cls: 'hs-purposes', parent: secPurpose });
    for (const p of ROOM_PURPOSES) {
      const b = el('button', { cls: 'hs-purpose', parent: this.purposeGrid, attrs: { 'data-purpose': p } });
      el('span', { cls: 'name', text: ROOM_PURPOSE_LABEL_KO[p], parent: b });
      if (!ROOM_PURPOSES_ACTIVE.includes(p)) el('span', { cls: 'badge', text: '다음 업데이트', parent: b });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
    }
    this.purposeHint = el('div', { cls: 'hint', text: '', parent: secPurpose });

    this.secLevel = this.section(page, '방 레벨');
    const lvRow = el('div', { cls: 'hs-row', parent: this.secLevel });
    const lvMid = el('div', { cls: 'mid', parent: lvRow });
    this.levelText = el('div', { cls: 'name', text: '', parent: lvMid });
    this.levelCost = el('div', { cls: 'cost', parent: lvMid });
    this.levelBlocked = el('div', { cls: 'blocked', text: '', parent: lvMid });
    this.btnLevel = this.button(lvRow, '업그레이드', () => this.upgradeRoom(), 'small');

    const secStorage = this.section(page, '가구 창고');
    this.storageList = el('div', { cls: 'hs-list', parent: secStorage });
    const secPlaced = this.section(page, '설치된 가구');
    this.placedList = el('div', { cls: 'hs-list', parent: secPlaced });
    const secCraft = this.section(page, '가구 제작');
    this.craftList = el('div', { cls: 'hs-list', parent: secCraft });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const footLeft = el('div', { cls: 'left', parent: foot });
    this.btnHousing = this.button(footLeft, '하우징 모드', () => this.startHousing(), 'primary');
    this.housingHint = el('div', { cls: 'hint', text: '', parent: footLeft });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  get currentRoom(): number { return this.room; }

  openRoom(room: number): void {
    this.room = room;
    this.openPanel();
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private pickPurpose(p: RoomPurpose): void {
    const cur = this.housing.getRoom(this.room).purpose;
    if (cur === p) return;
    const reason = this.housing.purposeBlock(this.room, p);
    if (reason) { this.showMsg(reason, 'warning'); return; }
    if (p === 'empty' && this.housing.getPlaced(this.room).length) this.showMsg('가구를 모두 회수했습니다', 'info');
    if (this.housing.setRoomPurpose(this.room, p)) this.showMsg(`방 ${this.room + 1} → ${ROOM_PURPOSE_LABEL_KO[p]}`, 'success');
    this.refresh();
  }

  private upgradeRoom(): void {
    const id = this.facilityOfRoom();
    if (!id) return;
    const info = this.housing.getFacility(id);
    if (info.blocked) { this.showMsg(info.blocked, 'warning'); return; }
    if (this.housing.upgrade(id)) this.showMsg(`${info.name} Lv.${info.level + 1}`, 'success');
    else this.showMsg('업그레이드에 실패했습니다', 'danger');
    this.refresh();
  }

  private startHousing(): void {
    const reason = this.housing.housingModeBlock(this.room);
    if (reason) { this.showMsg(reason, 'warning'); return; }
    this.close(false);                           // hub keeps the pointer lock for the housing cursor
    this.housing.enterHousingMode(this.room);
    this.relockNow();
  }

  private placeFromStorage(defId: string): void {
    const reason = this.housing.housingModeBlock(this.room);
    if (reason) { this.showMsg(reason, 'warning'); return; }
    this.close(false);
    if (this.housing.enterHousingMode(this.room)) this.housing.selectFurniture(defId);
    this.relockNow();
  }

  private relockNow(): void {
    queueMicrotask(() => { if (this.ctx.phase === 'hub' && this.ctx.uiBlockers.size === 0) this.ctx.input.requestPointerLock(); });
  }

  private facilityOfRoom(): FacilityId | null {
    const p = this.housing.getRoom(this.room).purpose;
    return p === 'workshop' ? 'workshop' : p === 'range' ? 'range' : null;
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing, room = h.getRoom(this.room), purpose = room.purpose;
    setText(this.title, `방 ${this.room + 1} · ${ROOM_PURPOSE_LABEL_KO[purpose]}`);
    setText(this.subtitle, ROOM_PURPOSE_DESC_KO[purpose]);

    // purposes
    for (const b of Array.from(this.purposeGrid.children) as HTMLButtonElement[]) {
      const p = b.dataset.purpose as RoomPurpose;
      const reason = p === purpose ? null : h.purposeBlock(this.room, p);
      toggleClass(b, 'current', p === purpose);
      toggleClass(b, 'inactive', !ROOM_PURPOSES_ACTIVE.includes(p));
      toggleClass(b, 'blocked', !!reason);
      b.title = reason ?? ROOM_PURPOSE_DESC_KO[p];
    }
    setText(this.purposeHint, purpose === 'empty' ? '용도를 정하면 방 레벨 1 이 되고 해당 가구를 설치할 수 있습니다.'
      : ROOM_PURPOSES_ACTIVE.includes(purpose) ? '빈 방으로 되돌리면 가구가 모두 가구 창고로 돌아갑니다.'
        : '이 용도는 아직 장식만 가능합니다 (다음 업데이트).');

    // room level
    const fid = this.facilityOfRoom();
    this.secLevel.hidden = !fid;
    if (fid) {
      const info = h.getFacility(fid);
      setText(this.levelText, `${info.name} ${levelText(info.level, info.maxLevel)}`);
      if (info.nextCost) renderCost(this.levelCost, info.nextCost, h.countDef, h.nameOf); else { clear(this.levelCost); el('span', { cls: 'mat free', text: '최대', parent: this.levelCost }); }
      setText(this.levelBlocked, info.blocked ?? (fid === 'workshop' ? `제작 비용 ×${h.getCraftCostMul().toFixed(2)}` : `프리셋 ${h.getPresetCount()}개 · 사격 숙련 ×${h.getSkillGainMul('gun_AR').toFixed(1)}`));
      toggleClass(this.levelBlocked, 'ok', !info.blocked);
      this.btnLevel.disabled = !!info.blocked;
      this.btnLevel.title = info.blocked ?? '';
    }

    // furniture storage
    clear(this.storageList);
    const stored = h.getStored();
    if (!stored.length) el('div', { cls: 'hs-empty', text: '가구 창고가 비어 있습니다', parent: this.storageList });
    for (const s of stored) {
      const def = h.getFurnitureDef(s.defId);
      if (!def) continue;
      const fits = def.room === 'any' || def.room === purpose;
      const row = el('div', { cls: `hs-row${fits ? '' : ' dim'}`, parent: this.storageList, attrs: { 'data-def': s.defId } });
      row.style.setProperty('--fc', def.color);
      el('div', { cls: 'swatch', parent: row });
      const mid = el('div', { cls: 'mid', parent: row });
      const nl = el('div', { cls: 'name-line', parent: mid });
      el('span', { cls: 'name', text: def.name, parent: nl });
      if (def.maxLevel > 1) el('span', { cls: 'tag', text: `Lv.${s.level}`, parent: nl });
      el('span', { cls: 'qty', text: `×${s.qty}`, parent: nl });
      el('div', { cls: 'desc', text: `${def.cols}×${def.rows} 칸 · ${fits ? '이 방에 설치 가능' : `${def.room === 'any' ? '' : ROOM_PURPOSE_LABEL_KO[def.room as RoomPurpose]} 전용`}`, parent: mid });
      const b = this.button(row, '배치', () => this.placeFromStorage(s.defId), 'small');
      b.disabled = !fits || purpose === 'empty';
      b.title = fits ? '' : '용도가 맞지 않습니다';
    }

    // placed furniture
    clear(this.placedList);
    const placed = h.getPlaced(this.room);
    if (!placed.length) el('div', { cls: 'hs-empty', text: '설치된 가구가 없습니다', parent: this.placedList });
    for (const item of placed) {
      const def = h.getFurnitureDef(item.defId);
      if (!def) continue;
      const row = el('div', { cls: 'hs-row', parent: this.placedList, attrs: { 'data-uid': item.uid } });
      row.style.setProperty('--fc', def.color);
      el('div', { cls: 'swatch', parent: row });
      const mid = el('div', { cls: 'mid', parent: row });
      const nl = el('div', { cls: 'name-line', parent: mid });
      el('span', { cls: 'name', text: def.name, parent: nl });
      if (def.maxLevel > 1) el('span', { cls: 'tag', text: `Lv.${item.level} / ${def.maxLevel}`, parent: nl });
      const fp = furnitureFootprint(def, item.yaw);
      el('div', { cls: 'desc', text: `칸 (${item.x}, ${item.y}) · ${fp.cols}×${fp.rows} · ${YAW_LABEL[item.yaw]}`, parent: mid });
      const cost = nextFurnitureCost(def, item.level);
      if (cost) {
        const costEl = el('div', { cls: 'cost', parent: mid });
        renderCost(costEl, cost, h.countDef, h.nameOf);
        const reason = h.furnitureUpgradeBlock(item.uid);
        if (reason) el('div', { cls: 'blocked', text: reason, parent: mid });
        const bu = this.button(row, '업그레이드', () => {
          if (h.upgradeFurniture(item.uid)) this.showMsg(`${def.name} Lv.${item.level}`, 'success');
          else this.showMsg(h.furnitureUpgradeBlock(item.uid) ?? '업그레이드에 실패했습니다', 'warning');
          this.refresh();
        }, 'small');
        bu.disabled = !!reason;
        bu.title = reason ?? '';
      }
      this.button(row, '회수', () => { if (h.recover(item.uid)) this.showMsg(`${def.name} 회수`, 'info'); this.refresh(); }, 'small');
    }

    // craftable furniture
    clear(this.craftList);
    const defs = h.getFurnitureFor(purpose).filter((d) => d.craft);
    if (purpose === 'empty') el('div', { cls: 'hs-empty', text: '용도를 정하면 제작 목록이 열립니다', parent: this.craftList });
    else for (const def of defs) {
      const row = el('div', { cls: 'hs-row', parent: this.craftList, attrs: { 'data-craft': def.id } });
      row.style.setProperty('--fc', def.color);
      el('div', { cls: 'swatch', parent: row });
      const mid = el('div', { cls: 'mid', parent: row });
      const nl = el('div', { cls: 'name-line', parent: mid });
      el('span', { cls: 'name', text: def.name, parent: nl });
      el('span', { cls: 'tag dim', text: `${def.cols}×${def.rows}`, parent: nl });
      el('div', { cls: 'desc', text: def.description, parent: mid });
      const costEl = el('div', { cls: 'cost', parent: mid });
      const ok = renderCost(costEl, def.craft!, h.countDef, h.nameOf);
      const b = this.button(row, '제작', () => {
        if (h.craftFurniture(def.id)) this.showMsg(`${def.name} 제작 완료 → 가구 창고`, 'success');
        else this.showMsg('재료가 부족합니다', 'warning');
        this.refresh();
      }, 'small');
      b.disabled = !ok;
      b.title = ok ? '' : '재료 부족';
    }

    // housing mode
    const hmReason = h.housingModeBlock(this.room);
    this.btnHousing.disabled = !!hmReason;
    setText(this.housingHint, hmReason ?? 'LMB 설치 · R 회전 · X 회수 · 휠 선택 · Esc 종료');
  }
}
