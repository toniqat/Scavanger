import type { EmbeddedView, FacilityId, GameContext } from '@/shared';
import {
  Keys, MENU_BLOCKER, ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_COLOR, ROOM_PURPOSE_GLYPH, ROOM_PURPOSE_LABEL_KO,
  keyLabel,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { facilityPurposeOf } from '../Rules';
import { FacilityRows } from './FacilityRows';
import { CHIP_SIZE_SMALL, clear, el, facilityThumb, levelText, renderCost, section, setText, toggleClass } from './dom';

/**
 * 함선 tab of the inventory Tab screen. Rewritten in the Phase 9 UI pass:
 *
 *   - **left column** — 기본 시설: the two ship-wide facilities (발전기 · 창고) plus the 효과 summary.
 *   - **right column** — 방 목록: one row per room, **thumbnail + 용도 이름 + 레벨** only. The room number, the
 *     furniture count and the purpose description are gone. A room with a facility gets its upgrade cost chips, a
 *     wide **업그레이드** button on the far right and a red **🗑 제거** icon; 제거 asks for confirmation (it empties
 *     the room into furniture storage and refunds the 시설 증축 price plus every upgrade material into the
 *     함선 창고 — `HousingRef.facilityRefund` / `removeRoomFacility`). An **empty** room gets a **시설 증축** button
 *     instead, which opens a centred popup listing every purpose with the materials it costs (`purposeCost`); a
 *     purpose the rules or the materials refuse is disabled with its 한국어 reason, and 닫기 dismisses the popup.
 *     The 방 목록 is the only thing that scrolls — the panel itself never does (Phase 9 UI pass).
 *   - **도감**: removed. Books are read on a 책장 in the 서재 (`openBookshelfMenu`), not from this screen.
 *   - **bottom bar** — its own `.hs-ship-bar` strip below the columns with the **시설 관리 (M)** button on the right.
 *
 * **Embedded view contract**: it renders into the host element the inventory window owns and does **not** add a
 * `ctx.uiBlockers` token, exit the pointer lock or install a window-level Escape listener — the window owns all three.
 * `refresh()` repaints, `dispose()` removes everything it added (elements + bus subscriptions).
 *
 * 2026-09-09 (Tab closes every screen, innermost first): while the 시설 제거 confirm or the 시설 증축 popup is up, a
 * capture-phase **Tab** listener closes that popup and stops the event before `Input` records it — so the press
 * closes the popup, not the whole Tab window behind it. Installed only while a popup is open, removed in `dispose()`.
 */
export function createShipView(ctx: GameContext, housing: HousingSystem, host: HTMLElement): EmbeddedView {
  // The 함선 tab owns its height: the window frame stops scrolling and the 방 목록 scrolls instead.
  host.classList.add('is-ship');
  const root = el('div', { cls: 'hs-ship', parent: host });
  const head = el('div', { cls: 'hs-head', parent: root });
  const hl = el('div', { cls: 'hl', parent: head });
  el('div', { cls: 'title', text: '함선 관리', parent: hl });

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

  interface RoomRow {
    root: HTMLElement;
    thumb: HTMLElement;
    glyph: HTMLElement;
    name: HTMLElement;
    tag: HTMLElement;
    fac: HTMLElement;
    facCost: HTMLElement;
    facBlocked: HTMLElement;
    acts: HTMLElement;
    facBtn: HTMLButtonElement;
    buildBtn: HTMLButtonElement;
    delBtn: HTMLButtonElement;
  }
  const rows: RoomRow[] = [];

  const upgradeFacility = (id: FacilityId): void => {
    const info = housing.getFacility(id);
    if (info.blocked) { showMsg(info.blocked, 'warning'); return; }
    if (housing.upgrade(id)) showMsg(`${info.name} Lv.${info.level + 1}`, 'success');
    else showMsg('업그레이드에 실패했습니다', 'danger');
    refresh();
  };

  /* ── 시설 제거 confirmation (a modal card over the screen, never a browser dialog) ── */
  const confirmEl = el('div', { cls: 'hs-confirm', parent: root });
  confirmEl.hidden = true;
  const confirmCard = el('div', { cls: 'card', parent: confirmEl });
  const confirmTitle = el('div', { cls: 'title', text: '시설 제거', parent: confirmCard });
  const confirmBody = el('div', { cls: 'body', parent: confirmCard });
  const confirmCost = el('div', { cls: 'cost', parent: confirmCard });
  const confirmActs = el('div', { cls: 'acts', parent: confirmCard });
  const confirmCancel = el('button', { cls: 'ui-btn', text: '취소', parent: confirmActs });
  const confirmOk = el('button', { cls: 'ui-btn danger', text: '제거', parent: confirmActs });
  let pendingRoom = -1;
  /* 2026-09-09: Tab closes the innermost popup (제거 confirm / 증축 picker) before the window — see the file comment */
  let popupKeyOn = false;
  const onPopupKey = (e: KeyboardEvent): void => {
    if (e.code !== Keys.INVENTORY || ctx.uiBlockers.has(MENU_BLOCKER)) return;
    if (confirmEl.hidden && buildEl.hidden) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    ctx.bus.emit('audio:play', { id: 'ui_close' });
    if (!confirmEl.hidden) closeConfirm(); else closeBuild();
  };
  const syncPopupKey = (): void => {
    const want = !confirmEl.hidden || !buildEl.hidden;
    if (want === popupKeyOn) return;
    popupKeyOn = want;
    if (want) window.addEventListener('keydown', onPopupKey, true);
    else window.removeEventListener('keydown', onPopupKey, true);
  };
  const closeConfirm = (): void => { confirmEl.hidden = true; pendingRoom = -1; syncPopupKey(); };
  confirmCancel.addEventListener('click', (e) => { e.stopPropagation(); ctx.bus.emit('audio:play', { id: 'ui_close' }); closeConfirm(); });
  confirmEl.addEventListener('mousedown', (e) => { if (e.target === confirmEl) closeConfirm(); });
  confirmOk.addEventListener('click', (e) => {
    e.stopPropagation();
    const room = pendingRoom;
    closeConfirm();
    if (room < 0) return;
    const reason = housing.removeRoomFacility(room);
    ctx.bus.emit('audio:play', { id: reason ? 'ui_deny' : 'ui_close' });
    showMsg(reason ?? '시설을 제거하고 재료를 함선 창고로 돌려보냈습니다', reason ? 'warning' : 'success');
    refresh();
  });

  /* ── 시설 증축 popup (Phase 9 UI pass): pick a purpose for an empty room, materials shown as chips ── */
  const buildEl = el('div', { cls: 'hs-confirm hs-build', parent: root });
  buildEl.hidden = true;
  const buildCard = el('div', { cls: 'card', parent: buildEl });
  const buildTitle = el('div', { cls: 'title', text: '시설 증축', parent: buildCard });
  el('div', { cls: 'body', text: '설치할 시설을 고르세요. 재료는 가방과 함선 창고에서 함께 빠져나갑니다.', parent: buildCard });
  const buildList = el('div', { cls: 'hs-build-list', parent: buildCard });
  const buildActs = el('div', { cls: 'acts', parent: buildCard });
  const buildClose = el('button', { cls: 'ui-btn', text: '닫기', parent: buildActs });
  let buildRoom = -1;
  const closeBuild = (): void => { buildEl.hidden = true; buildRoom = -1; syncPopupKey(); };
  buildClose.addEventListener('click', (e) => { e.stopPropagation(); ctx.bus.emit('audio:play', { id: 'ui_close' }); closeBuild(); });
  buildEl.addEventListener('mousedown', (e) => { if (e.target === buildEl) closeBuild(); });

  /** Rebuild the popup body for `buildRoom` — one row per assignable purpose, disabled with its reason. */
  const renderBuild = (): void => {
    if (buildRoom < 0) return;
    setText(buildTitle, `방 ${buildRoom + 1} — 시설 증축`);
    clear(buildList);
    for (const p of ROOM_PURPOSES) {
      if (p === 'empty') continue;
      const blocked = housing.purposeBlock(buildRoom, p);
      const row = el('div', { cls: `hs-build-row${blocked ? ' is-blocked' : ''}`, parent: buildList });
      const thumb = facilityThumb(row, ROOM_PURPOSE_GLYPH[p], ROOM_PURPOSE_COLOR[p]);
      thumb.style.setProperty('--pc', ROOM_PURPOSE_COLOR[p]);
      const mid = el('div', { cls: 'mid', parent: row });
      const nl = el('div', { cls: 'name-line', parent: mid });
      el('span', { cls: 'name', text: ROOM_PURPOSE_LABEL_KO[p], parent: nl });
      if (!ROOM_PURPOSES_ACTIVE.includes(p)) el('span', { cls: 'tag dim', text: '다음 업데이트', parent: nl });
      const cost = el('div', { cls: 'cost', parent: mid });
      const affordable = renderCost(cost, housing.purposeCost(p), housing, CHIP_SIZE_SMALL);
      if (blocked) el('div', { cls: 'blocked', text: blocked, parent: mid });
      const btn = el('button', { cls: 'ui-btn small wide', text: '제작', parent: row }) as HTMLButtonElement;
      btn.disabled = !!blocked || !affordable;
      btn.title = blocked ?? `${ROOM_PURPOSE_LABEL_KO[p]} 증축`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const room = buildRoom;
        const reason = housing.purposeBlock(room, p);
        if (reason) { ctx.bus.emit('audio:play', { id: 'ui_deny' }); showMsg(reason, 'warning'); renderBuild(); return; }
        if (housing.setRoomPurpose(room, p)) {
          ctx.bus.emit('audio:play', { id: 'ui_equip' });
          showMsg(`방 ${room + 1} → ${ROOM_PURPOSE_LABEL_KO[p]} 증축 완료`, 'success');
          closeBuild();
        } else { ctx.bus.emit('audio:play', { id: 'ui_deny' }); showMsg('증축에 실패했습니다', 'danger'); }
        refresh();
      });
    }
  };

  const askBuild = (room: number): void => {
    buildRoom = room;
    renderBuild();
    buildEl.hidden = false;
    syncPopupKey();
    ctx.bus.emit('audio:play', { id: 'ui_click' });
  };

  const askRemove = (room: number): void => {
    const state = housing.getRoom(room);
    const label = ROOM_PURPOSE_LABEL_KO[state.purpose];
    const blocked = housing.purposeBlock(room, 'empty');
    if (blocked) { ctx.bus.emit('audio:play', { id: 'ui_deny' }); showMsg(blocked, 'warning'); return; }
    pendingRoom = room;
    const count = housing.getPlaced(room).length;
    setText(confirmTitle, `${label} 제거`);
    setText(confirmBody, count > 0
      ? `설치된 가구 ${count}개는 가구 창고로, 업그레이드 재료는 함선 창고로 돌아갑니다. 방은 빈 방이 됩니다.`
      : '업그레이드 재료는 함선 창고로 돌아가고 방은 빈 방이 됩니다.');
    const refund = housing.facilityRefund(room);
    clear(confirmCost);
    if (refund.length) renderCost(confirmCost, refund, housing, CHIP_SIZE_SMALL);
    else el('span', { cls: 'item-chip-free', text: '돌려받을 재료 없음', parent: confirmCost });
    confirmEl.hidden = false;
    syncPopupKey();
    ctx.bus.emit('audio:play', { id: 'ui_click' });
  };

  for (let i = 0; i < housing.state.rooms.length; i++) {
    const row = el('div', { cls: 'hs-row room', parent: roomList, attrs: { 'data-room': String(i) } });
    const thumb = facilityThumb(row, ROOM_PURPOSE_GLYPH.empty, ROOM_PURPOSE_COLOR.empty);
    const glyph = thumb.firstElementChild as HTMLElement;
    const mid = el('div', { cls: 'mid', parent: row });
    const nl = el('div', { cls: 'name-line', parent: mid });
    const name = el('span', { cls: 'name', text: ROOM_PURPOSE_LABEL_KO.empty, parent: nl });
    const tag = el('span', { cls: 'tag dim', text: '', parent: nl });
    // facility block: only rendered for a 작업실 / 사격장 room
    const fac = el('div', { cls: 'hs-room-fac', parent: mid });
    const facCost = el('div', { cls: 'cost', parent: fac });
    const facBlocked = el('div', { cls: 'blocked', text: '', parent: fac });

    const acts = el('div', { cls: 'hs-row-acts', parent: row });
    const buildBtn = el('button', { cls: 'ui-btn small wide primary', text: '시설 증축', parent: acts });
    buildBtn.addEventListener('click', (e) => { e.stopPropagation(); askBuild(i); });
    const facBtn = el('button', { cls: 'ui-btn small wide', text: '업그레이드', parent: acts });
    facBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fid = facilityPurposeOf(housing.getRoom(i).purpose);
      if (!fid) return;
      ctx.bus.emit('audio:play', { id: 'ui_click' });
      upgradeFacility(fid);
    });
    const delBtn = el('button', { cls: 'hs-del', text: '🗑', parent: acts, attrs: { 'aria-label': '시설 제거', title: '시설 제거' } });
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); askRemove(i); });

    rows.push({ root: row, thumb, glyph, name, tag, fac, facCost, facBlocked, acts, facBtn, buildBtn, delBtn });
  }

  /* 시설 관리 (M): its own bottom bar under the two columns, button on the right */
  const foot = el('div', { cls: 'hs-ship-bar', parent: root });
  el('div', { cls: 'bar-left', text: '', parent: foot });
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
    setText(manageLabel, '시설 관리');
    setText(manageKey, keyLabel(Keys.MAP));
    manageBtn.disabled = !!housing.shipManageBlock();
    facilities.refresh();
    if (!confirmEl.hidden && pendingRoom >= 0 && housing.getRoom(pendingRoom).purpose === 'empty') closeConfirm();
    if (!buildEl.hidden && buildRoom >= 0) {
      if (housing.getRoom(buildRoom).purpose !== 'empty') closeBuild();
      else renderBuild();                        // material counts / block reasons move with the state
    }
    rows.forEach((row, i) => {
      const state = housing.getRoom(i);
      const fid = facilityPurposeOf(state.purpose);
      const empty = state.purpose === 'empty';
      row.thumb.style.setProperty('--pc', ROOM_PURPOSE_COLOR[state.purpose]);
      setText(row.glyph, ROOM_PURPOSE_GLYPH[state.purpose]);
      setText(row.name, ROOM_PURPOSE_LABEL_KO[state.purpose]);
      toggleClass(row.root, 'dim', empty);
      // 제거 is offered on any assigned room the rules let go back to 빈 방; an empty room offers 시설 증축 instead
      row.delBtn.hidden = empty || !!housing.purposeBlock(i, 'empty');
      row.buildBtn.hidden = !empty;
      row.fac.hidden = !fid;
      row.facBtn.hidden = !fid;
      if (!fid) {
        setText(row.tag, '');
        row.tag.hidden = true;
        return;
      }
      const info = housing.getFacility(fid);
      setText(row.tag, levelText(info.level, info.maxLevel));
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
      confirmEl.hidden = true; buildEl.hidden = true; syncPopupKey();
      root.remove();
      host.classList.remove('is-ship');
      clear(host);
    },
  };
}
