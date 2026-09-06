import type { EmbeddedView, FacilityId, GameContext, RoomPurpose } from '@/shared';
import { Keys, ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_DESC_KO, ROOM_PURPOSE_LABEL_KO, WORKSHOP_ROOM_INDEX, keyLabel } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { facilityPurposeOf } from '../Rules';
import { FacilityRows } from './FacilityRows';
import { createBookDex } from './BookDex';
import { CHIP_SIZE_SMALL, clear, el, levelText, renderCost, section, setText, toggleClass } from './dom';

/**
 * 함선 tab of the inventory Tab screen (Phase 8). Rewritten in the Phase 8 UI pass:
 *
 *   - **left column** — 기본 시설: only the two ship-wide facilities (발전기 · 창고) plus the 효과 summary. 작업실 /
 *     사격장 stopped being "basic facilities": they are room facilities and are levelled from their own room row.
 *   - **right column** — 방 목록: one row per room with its purpose picker (`purposeBlock` disables what the rules
 *     refuse — room 1 is the locked 작업실), its furniture count and, for a 작업실 / 사격장 room, that facility's
 *     level, cost chips, block reason and 업그레이드 button.
 *   - **right column, below the rooms** — the 서재 **도감** (Phase 9, `ui/BookDex.ts`: one row per skill with its book,
 *     보유 / 미보유 and the current 서재 multiplier — the same renderer the 책장 panel uses).
 *   - **bottom right** — a sticky **시설 관리 (M)** button that closes the Tab window and enters `openShipManage()`,
 *     exactly like pressing M in the ship. It sticks to the bottom of the scrolling screen, so it is reachable
 *     wherever the list is scrolled.
 *
 * **Embedded view contract**: it renders into the host element the inventory window owns and does **not** add a
 * `ctx.uiBlockers` token, exit the pointer lock or install a window-level Escape listener — the window owns all three.
 * `refresh()` repaints, `dispose()` removes everything it added (elements + bus subscriptions).
 */
export function createShipView(ctx: GameContext, housing: HousingSystem, host: HTMLElement): EmbeddedView {
  const root = el('div', { cls: 'hs-ship', parent: host });
  const head = el('div', { cls: 'hs-head', parent: root });
  const hl = el('div', { cls: 'hl', parent: head });
  el('div', { cls: 'title', text: '함선 관리', parent: hl });
  const subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

  const msg = el('div', { cls: 'form-msg hs-msg', parent: root });
  msg.hidden = true;
  let msgTimer = 0;
  const showMsg = (text: string, kind: 'info' | 'success' | 'warning' | 'danger' = 'info'): void => {
    msg.textContent = text;
    msg.className = `form-msg hs-msg ${kind}`;
    msg.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = window.setTimeout(() => { msg.hidden = true; }, 4500);
  };

  const cols = el('div', { cls: 'hs-ship-cols', parent: root });
  const colLeft = el('div', { cls: 'hs-ship-col left', parent: cols });
  const colRight = el('div', { cls: 'hs-ship-col right', parent: cols });

  // 기본 시설: the ship-wide pair only (작업실 / 사격장 live in the 방 목록 on the right)
  const facilities = new FacilityRows(colLeft, ctx, housing, showMsg, ['generator', 'storage'], '기본 시설');

  const secRooms = section(colRight, '방 목록');
  const roomList = el('div', { cls: 'hs-list rooms', parent: secRooms });
  el('div', { cls: 'hint', text: `방 하나를 골라 작업실 · 사격장 등 용도를 지정합니다. 가구 배치는 시설 관리(${keyLabel(Keys.MAP)})에서 합니다.`, parent: secRooms });

  interface RoomRow {
    root: HTMLElement;
    name: HTMLElement;
    tag: HTMLElement;
    select: HTMLSelectElement;
    desc: HTMLElement;
    fac: HTMLElement;
    facCost: HTMLElement;
    facBlocked: HTMLElement;
    facBtn: HTMLButtonElement;
  }
  const rows: RoomRow[] = [];

  const upgradeFacility = (id: FacilityId): void => {
    const info = housing.getFacility(id);
    if (info.blocked) { showMsg(info.blocked, 'warning'); return; }
    if (housing.upgrade(id)) showMsg(`${info.name} Lv.${info.level + 1}`, 'success');
    else showMsg('업그레이드에 실패했습니다', 'danger');
    refresh();
  };

  for (let i = 0; i < housing.state.rooms.length; i++) {
    const row = el('div', { cls: 'hs-row room', parent: roomList, attrs: { 'data-room': String(i) } });
    const mid = el('div', { cls: 'mid', parent: row });
    const nl = el('div', { cls: 'name-line', parent: mid });
    const name = el('span', { cls: 'name', text: `방 ${i + 1}`, parent: nl });
    const tag = el('span', { cls: 'tag dim', text: '', parent: nl });
    const desc = el('div', { cls: 'desc', text: '', parent: mid });
    // facility block: only rendered for a 작업실 / 사격장 room
    const fac = el('div', { cls: 'hs-room-fac', parent: mid });
    const facCost = el('div', { cls: 'cost', parent: fac });
    const facBlocked = el('div', { cls: 'blocked', text: '', parent: fac });
    const facBtn = el('button', { cls: 'ui-btn small', text: '업그레이드', parent: fac });
    facBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fid = facilityPurposeOf(housing.getRoom(i).purpose);
      if (!fid) return;
      ctx.bus.emit('audio:play', { id: 'ui_click' });
      upgradeFacility(fid);
    });

    const select = el('select', { cls: 'ui-input purpose', parent: row }) as HTMLSelectElement;
    for (const p of ROOM_PURPOSES) {
      const opt = el('option', { text: ROOM_PURPOSE_LABEL_KO[p] + (ROOM_PURPOSES_ACTIVE.includes(p) ? '' : ' (장식)'), parent: select }) as HTMLOptionElement;
      opt.value = p;
    }
    // the inventory window owns the keyboard: never let a game key escape from the picker
    select.addEventListener('keydown', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      const purpose = select.value as RoomPurpose;
      const reason = housing.purposeBlock(i, purpose);
      if (reason) { showMsg(reason, 'warning'); refresh(); return; }
      if (housing.setRoomPurpose(i, purpose)) showMsg(`방 ${i + 1} → ${ROOM_PURPOSE_LABEL_KO[purpose]}`, 'success');
      refresh();
    });
    rows.push({ root: row, name, tag, select, desc, fac, facCost, facBlocked, facBtn });
  }

  /* 도감 (Phase 9): under the 방 목록, same renderer as the 책장 panel */
  const secDex = section(colRight, '도감');
  el('div', { cls: 'hint', text: '서재의 책장에 꽂아 본 서적이 남습니다. 배율은 지금 꽂혀 있는 책으로 계산됩니다.', parent: secDex });
  const dex = createBookDex(ctx, housing, secDex);

  /* 시설 관리 (M): sticky in the bottom-right corner of the scrolling screen */
  const foot = el('div', { cls: 'hs-ship-foot', parent: root });
  const manageBtn = el('button', { cls: 'ui-btn primary hs-manage-btn', parent: foot }) as HTMLButtonElement;
  const manageLabel = el('span', { text: '시설 관리', parent: manageBtn });
  const manageKey = el('kbd', { cls: 'hs-keycap', text: keyLabel(Keys.MAP), parent: manageBtn });
  manageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    const blocked = housing.shipManageBlock();
    if (blocked) { showMsg(blocked, 'warning'); return; }
    // close the Tab window first: 시설 관리 drives an unlocked cursor and takes its own blocker
    try { ctx.inventory?.closeAll(); } catch { /* inventory not ready */ }
    housing.openShipManage();
  });

  function refresh(): void {
    const assigned = housing.state.rooms.filter((r) => r.purpose !== 'empty').length;
    setText(subtitle, `용도가 정해진 방 ${assigned} / ${housing.state.rooms.length} · 발전기 Lv.${housing.state.generatorLevel}`);
    setText(manageLabel, '시설 관리');
    setText(manageKey, keyLabel(Keys.MAP));
    manageBtn.disabled = !!housing.shipManageBlock();
    facilities.refresh();
    dex.refresh();
    rows.forEach((row, i) => {
      const state = housing.getRoom(i);
      const fid = facilityPurposeOf(state.purpose);
      const count = housing.getPlaced(i).length;
      const locked = i === WORKSHOP_ROOM_INDEX;
      setText(row.name, `방 ${i + 1} · ${ROOM_PURPOSE_LABEL_KO[state.purpose]}`);
      setText(row.tag, locked ? '기본' : '');
      row.tag.hidden = !locked;
      setText(row.desc, `${count > 0 ? `가구 ${count}개` : '가구 없음'} · ${ROOM_PURPOSE_DESC_KO[state.purpose]}`);
      toggleClass(row.root, 'dim', state.purpose === 'empty');
      toggleClass(row.root, 'is-locked', locked);
      row.select.disabled = locked;
      row.select.title = locked ? `방 ${WORKSHOP_ROOM_INDEX + 1}은(는) 기본 작업실입니다` : '';
      if (row.select.value !== state.purpose) row.select.value = state.purpose;
      for (const opt of Array.from(row.select.options)) {
        const p = opt.value as RoomPurpose;
        const block = p !== state.purpose ? housing.purposeBlock(i, p) : null;
        opt.disabled = !!block;
        opt.title = block ?? '';
      }
      // facility level line (작업실 / 사격장 only)
      row.fac.hidden = !fid;
      if (!fid) return;
      const info = housing.getFacility(fid);
      setText(row.tag, `${info.name} ${levelText(info.level, info.maxLevel)}`);
      row.tag.hidden = false;
      if (info.nextCost) renderCost(row.facCost, info.nextCost, housing, CHIP_SIZE_SMALL);
      else { clear(row.facCost); el('span', { cls: 'item-chip-free', text: info.level >= info.maxLevel ? '최대 레벨' : '—', parent: row.facCost }); }
      setText(row.facBlocked, info.blocked ?? '업그레이드 가능');
      toggleClass(row.facBlocked, 'ok', !info.blocked);
      row.facBtn.disabled = !!info.blocked;
      row.facBtn.title = info.blocked ?? '';
    });
  }

  const unsubs = [
    ctx.bus.on('housing:changed', () => refresh()),
    ctx.bus.on('inventory:changed', () => refresh()),
    ctx.bus.on('inventory:stashChanged', () => refresh()),
    ctx.bus.on('input:bindingsChanged', () => refresh()),
  ];

  refresh();

  return {
    refresh,
    dispose(): void {
      for (const u of unsubs) u();
      unsubs.length = 0;
      clearTimeout(msgTimer);
      root.remove();
      clear(host);
    },
  };
}
