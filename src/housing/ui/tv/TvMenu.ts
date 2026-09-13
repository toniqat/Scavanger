/**
 * src/housing/ui/tv/TvMenu.ts — **TV 화면** (비디오게임, 2026-09-13 · H2 — docs/plans/library-series-games.md §3).
 *
 * hub 의 TV E 가 `ctx.housing.openTvMenu(uid)` 로 연다 (같은 날부터 TV 의 E 는 켜기/끄기 토글이 아니다). 한 화면에:
 *   • 머리 — TV 이름 · 켜짐 상태 · `켜기` / `끄기` 버튼 (`toggleFurniture`)
 *   • 게임기 — 장착된 게임기 + `빼기`, 가진 게임기(가방 + 창고) 목록 + `장착` / `교체` (되돌릴 수 있는 일이라 1초 홀드 없음)
 *   • 좌석 — `tvSeatBlock` 한 줄 (좌석이 있으면 그 이름)
 *   • 게임 — `getPlayableGames` 한 줄씩: 디스크 칩 · 이름 · 단련 능력치 · 방식 · 게임기, 막힌 사유, 디버프 남은 시간(경험치 0 안내), `플레이`
 * 규칙은 하나도 여기 없다 — 전부 `parts/VideoGame` 이 돌려주는 한국어 사유를 옮긴다.
 *
 * 틀은 `HousingPanel` 그대로라 E · Tab · Esc 로 닫히고 블로커 `'housing'` + 커서 모드를 쓴다. 이 화면은 `parts/Presets.panels()` 밖이라
 * (`HousingPage` 에 `'tv'` 가 없어 형 변환으로 넘긴다) 페이즈 전환 · `hub:left` 등의 닫기는 `parts/VideoGame.bindVideoGame` 이 한다.
 * `ui:tvMenuToggled {open, uid}` 를 낸다. CSS 접두사 `.tvm-`.
 */
import type { GameContext, GameStat, ItemDef } from '@/shared';
import { GYM_FATIGUE_LABEL_KO, buildItemChip } from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import {
  GAME_MINIGAME_LABEL_KO, consoleDefOf, consoleKindName, gameDiscDefOf, getOwnedConsoles,
} from '../../parts/VideoGame';
import { HousingPanel } from '../Panel';
import type { HousingPage } from '../Panel';
import { clear, clockText, el, setText, toggleClass } from '../dom';
import './tv.css';

/** 키 가이드 owner `housing.tv` · `data-page` (2026-09-13 리드: `HousingPage` 에 `'tv'` 를 더했다). */
const TV_PAGE: HousingPage = 'tv';
/** 디버프 남은 시간을 고쳐 쓰는 간격 (ms, 구현 값). */
const CLOCK_MS = 1000;

interface FatigueClock { el: HTMLElement; until: number; label: string; text: string }

export class TvMenu extends HousingPanel {
  /** 열린 TV 의 uid (닫혀 있으면 null). */
  uid: string | null = null;
  private readonly body: HTMLElement;
  private clocks: FatigueClock[] = [];
  private clockTimer = 0;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, TV_PAGE, 'tv-menu');
    this.coalesceRefresh = true;
    this.body = el('div', { cls: 'tvm-page', parent: this.frame });
    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', {
      cls: 'hint',
      text: '게임 디스크 전시대에 꽂은 게임이 목록에 뜹니다 — 게임기가 맞아야 하고, TV 정면의 좌석에 앉아 플레이합니다.',
      parent: el('div', { cls: 'left', parent: foot }),
    });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
    const again = (): void => this.refreshIfOpen();
    this.unsubs.push(
      ctx.bus.on('housing:furnitureToggled', again),
      ctx.bus.on('housing:tvConsoleChanged', again),
      ctx.bus.on('progress:gymFatigue', again),
      ctx.bus.on('progress:trainedChanged', again),
    );
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  openTv(uid: string): void {
    const wasOpen = this.isOpen;
    this.uid = uid;
    this.openPanel();
    if (!this.clockTimer) this.clockTimer = window.setInterval(() => this.tickClocks(), CLOCK_MS);
    if (!wasOpen) this.ctx.bus.emit('ui:tvMenuToggled', { open: true, uid });
  }

  override close(relock = true): void {
    if (!this.isOpen) return;
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = 0; }
    this.clocks = [];
    super.close(relock);
    this.uid = null;
    this.ctx.bus.emit('ui:tvMenuToggled', { open: false, uid: null });
  }

  override dispose(): void {
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = 0; }
    super.dispose();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const uid = this.uid;
    clear(this.body);
    this.clocks = [];
    const h = this.housing;
    const item = uid ? h.getPlacedByUid(uid) : null;
    if (!uid || !item) { el('div', { cls: 'hs-empty', text: 'TV 가 없습니다', parent: this.body }); return; }
    this.buildHead(uid, h.getFurnitureDef(item.defId)?.name ?? 'TV');
    this.buildConsole(uid);
    this.buildSeat(uid);
    this.buildGames(uid);
    this.tickClocks();
  }

  private buildHead(uid: string, name: string): void {
    const h = this.housing;
    const head = el('div', { cls: 'tvm-head', parent: this.body });
    el('div', { cls: 'tvm-title', text: name, parent: head });
    const right = el('div', { cls: 'tvm-state', parent: head });
    const on = h.isFurnitureOn(uid);
    toggleClass(right, 'is-on', on);
    el('i', { cls: 'tvm-dot', parent: right });
    el('span', { cls: 'tvm-state-text', text: on ? '켜짐' : '꺼짐', parent: right });
    const btn = this.button(right, on ? '끄기' : '켜기', () => {
      const r = h.toggleFurniture(uid);
      if (r === null) this.deny('TV 를 켤 수 없습니다');
      this.requestRefresh();
    }, 'small tvm-toggle');
    btn.dataset.on = on ? '1' : '0';
  }

  private buildConsole(uid: string): void {
    const h = this.housing;
    const s = this.section(this.body, '게임기');
    const current = typeof h.getTvConsole === 'function' ? h.getTvConsole(uid) : null;
    const cdef = consoleDefOf(h, current);
    const box = el('div', { cls: `tvm-console${cdef ? '' : ' is-empty'}`, parent: s });
    box.appendChild(buildItemChip(cdef ?? undefined, { size: 40 }));
    const body = el('div', { parent: box });
    el('div', { cls: 'tvm-name', text: cdef ? cdef.name : '장착된 게임기가 없습니다', parent: body });
    el('div', { cls: 'tvm-sub', text: cdef ? '이 게임기용 게임만 플레이할 수 있습니다' : '가진 게임기를 아래에서 장착하세요', parent: body });
    const acts = el('div', { cls: 'tvm-acts', parent: box });
    if (cdef) {
      this.button(acts, '빼기', () => {
        const r = h.detachTvConsole(uid);
        if (r) this.deny(r); else this.showMsg(`${cdef.name}을(를) 뺐습니다`, 'success');
      }, 'small tvm-detach');
    }
    const owned = getOwnedConsoles(h);
    if (!owned.length) {
      if (!cdef) el('div', { cls: 'hs-empty', text: '가진 게임기가 없습니다 — 3D 프린터에서 만들 수 있습니다', parent: s });
      return;
    }
    const list = el('div', { cls: 'tvm-list tvm-owned', parent: s });
    for (const { defId, qty } of owned) {
      const def = h.defOf(defId);
      if (!def) continue;
      const row = el('div', { cls: 'tvm-row', attrs: { 'data-def': defId }, parent: list });
      row.appendChild(buildItemChip(def, { size: 34, have: qty }));
      const b = el('div', { cls: 'tvm-body', parent: row });
      el('div', { cls: 'tvm-name', text: def.name, parent: b });
      el('div', { cls: 'tvm-sub', text: `게임기 · ${def.gameConsole?.console ?? ''}`, parent: b });
      const a = el('div', { cls: 'tvm-acts', parent: row });
      const same = current === defId;
      const btn = this.button(a, same ? '장착됨' : current ? '교체' : '장착', () => {
        const r = h.attachTvConsole(uid, defId);
        if (r) this.deny(r); else this.showMsg(`${def.name}을(를) 장착했습니다`, 'success');
      }, 'small primary tvm-attach');
      btn.disabled = same;
    }
  }

  private buildSeat(uid: string): void {
    const h = this.housing;
    const s = this.section(this.body, '좌석');
    const reason = typeof h.tvSeatBlock === 'function' ? h.tvSeatBlock(uid) : null;
    const seatUid = !reason && typeof h.getTvSeat === 'function' ? h.getTvSeat(uid) : null;
    const seat = seatUid ? h.getPlacedByUid(seatUid) : null;
    const name = seat ? h.getFurnitureDef(seat.defId)?.name ?? '좌석' : '';
    const line = el('div', { cls: `tvm-seat${reason ? ' is-bad' : ''}`, parent: s });
    setText(line, reason ?? `${name}에 앉아 플레이합니다`);
    if (seatUid) line.dataset.seat = seatUid;
  }

  private buildGames(uid: string): void {
    const h = this.housing;
    const s = this.section(this.body, '게임');
    const games = typeof h.getPlayableGames === 'function' ? h.getPlayableGames(uid) : [];
    if (!games.length) {
      el('div', { cls: 'hs-empty', text: '게임 디스크 전시대에 꽂힌 게임이 없습니다', parent: s });
      return;
    }
    const prog = this.ctx.progression;
    const now = h.nowMs();
    const list = el('div', { cls: 'tvm-list tvm-games', parent: s });
    for (const g of games) {
      const def = gameDiscDefOf(h, g.defId);
      const disc = def?.gameDisc;
      if (!def || !disc) continue;
      const row = el('div', { cls: `tvm-row tvm-game${g.block ? ' is-blocked' : ''}`, attrs: { 'data-def': g.defId }, parent: list });
      if (/^#[0-9a-fA-F]{6}$/.test(disc.color)) row.style.setProperty('--tvm-c', disc.color);
      row.appendChild(buildItemChip(def, { size: 34 }));
      const b = el('div', { cls: 'tvm-body', parent: row });
      el('div', { cls: 'tvm-name', text: def.name, parent: b });
      el('div', { cls: 'tvm-sub', text: `${this.statName(disc.stat)} 단련 · ${GAME_MINIGAME_LABEL_KO[disc.minigame]} · ${consoleKindName(h, disc.console)}`, parent: b });
      if (g.block) el('div', { cls: 'tvm-block', text: g.block, parent: b });
      const until = prog?.getGymFatigueUntil?.(disc.stat) ?? 0;
      if (until > now) {
        const f = el('div', { cls: 'tvm-fatigue', parent: b });
        this.clocks.push({ el: f, until, label: GYM_FATIGUE_LABEL_KO[disc.stat], text: '' });
      }
      const a = el('div', { cls: 'tvm-acts', parent: row });
      const why = typeof h.gameBlock === 'function' ? h.gameBlock(uid, g.defId) : g.block;
      const play = this.button(a, '플레이', () => this.play(uid, def), `small primary tvm-play${why ? ' tvm-dim' : ''}`);
      if (why) play.title = why;
    }
  }

  private play(uid: string, def: ItemDef): void {
    const r = this.housing.startGameSession(uid, def.id);
    if (r) this.deny(r);
  }

  private tickClocks(): void {
    if (!this.isOpen || !this.clocks.length) return;
    const now = this.housing.nowMs();
    let expired = false;
    for (const c of this.clocks) {
      const left = (c.until - now) / 1000;
      if (left <= 0) { expired = true; continue; }
      const text = `${c.label} · 남은 ${clockText(left)} — 지금 플레이하면 경험치 0`;
      if (text !== c.text) { c.text = text; setText(c.el, text); }
    }
    if (expired) this.requestRefresh();
  }

  private statName(stat: GameStat): string {
    try { return this.ctx.progression?.getStatDef(stat)?.name ?? stat; } catch { return stat; }
  }
}
