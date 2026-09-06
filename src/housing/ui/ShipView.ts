import type { EmbeddedView, GameContext, RoomPurpose } from '@/shared';
import { ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { facilityPurposeOf } from '../Rules';
import { FacilityRows } from './FacilityRows';
import { clear, el, section, setText, toggleClass } from './dom';

/**
 * 함선 tab of the inventory Tab screen (Phase 8): the shared `FacilityRows` (시설 업그레이드 + 효과 요약) plus a
 * 방 목록 with a purpose picker per room.
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

  const facilities = new FacilityRows(root, ctx, housing, showMsg);

  const secRooms = section(root, '방 목록');
  const roomList = el('div', { cls: 'hs-list rooms', parent: secRooms });
  el('div', { cls: 'hint', text: '방 안에서 함선 관리(M)를 열면 가구를 배치할 수 있습니다.', parent: secRooms });

  interface RoomRow { name: HTMLElement; tag: HTMLElement; select: HTMLSelectElement; desc: HTMLElement }
  const rows: RoomRow[] = [];
  for (let i = 0; i < housing.state.rooms.length; i++) {
    const row = el('div', { cls: 'hs-row room', parent: roomList, attrs: { 'data-room': String(i) } });
    const mid = el('div', { cls: 'mid', parent: row });
    const nl = el('div', { cls: 'name-line', parent: mid });
    const name = el('span', { cls: 'name', text: `방 ${i + 1}`, parent: nl });
    const tag = el('span', { cls: 'tag dim', text: '', parent: nl });
    const desc = el('div', { cls: 'desc', text: '', parent: mid });
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
    rows.push({ name, tag, select, desc });
  }

  function refresh(): void {
    const assigned = housing.state.rooms.filter((r) => r.purpose !== 'empty').length;
    setText(subtitle, `용도가 정해진 방 ${assigned} / ${housing.state.rooms.length} · 발전기 Lv.${housing.state.generatorLevel}`);
    facilities.refresh();
    rows.forEach((row, i) => {
      const state = housing.getRoom(i);
      const fid = facilityPurposeOf(state.purpose);
      const count = housing.getPlaced(i).length;
      setText(row.name, `방 ${i + 1} · ${ROOM_PURPOSE_LABEL_KO[state.purpose]}`);
      setText(row.tag, fid ? `Lv.${state.level}` : '');
      row.tag.hidden = !fid;
      setText(row.desc, count > 0 ? `가구 ${count}개` : '가구 없음');
      toggleClass(row.select.parentElement as HTMLElement, 'dim', state.purpose === 'empty');
      if (row.select.value !== state.purpose) row.select.value = state.purpose;
      for (const opt of Array.from(row.select.options)) {
        const p = opt.value as RoomPurpose;
        opt.disabled = p !== state.purpose && !!housing.purposeBlock(i, p);
      }
    });
  }

  const unsubs = [
    ctx.bus.on('housing:changed', () => refresh()),
    ctx.bus.on('inventory:changed', () => refresh()),
    ctx.bus.on('inventory:stashChanged', () => refresh()),
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
