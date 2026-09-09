import type { GameContext, RescueCandidate } from '@/shared';
import { Keys, MouseButtons, NET_MAX_PLAYERS, NET_SLOT_COLORS_CSS, RESCUE_DROPS_PER_RAID, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import './rescuePicker.css';

/** Blocker / cursor-owner token of this screen (local to the widget — it is nobody else's business). */
const RESCUE_BLOCKER = 'rescuePick';
/** Digit codes 1..4 pick a cell (raw `KeyboardEvent.code`s: the squad slots have no rebindable key). */
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

/**
 * 구조선 대상 선택 화면 (`.rescue-pick`, 2026-09-09).
 *
 * 구조선 투하만 흐름이 다르다 — 지면을 찍기 **전에** 누구를 되살릴지 먼저 고른다. 그래서 이 화면은
 * `ctx.stratagems` 를 폴링해서 스스로 뜬다: `armed === 'rescue_drop' && rescueTarget === null` 이면 열고,
 * 대상이 정해지거나 호출을 내려놓으면 닫는다. stratagems 는 `rescue:selectTarget` 하나로만 이 화면을 안다.
 *
 * 4칸은 분대 슬롯 그대로다 (`getRescueCandidates()` + 빈 슬롯). **죽은 대원만** 고를 수 있고, 살아 있거나
 * 전투불능인 칸은 회색으로 남는다. 마우스 클릭 또는 `1`~`4`, 우클릭 · Escape · Tab 으로 취소.
 *
 * 규약: 열려 있는 동안 `RESCUE_BLOCKER` 를 들고 커서를 가져가며(포인터 락은 유지), 우측 하단 키 가이드에
 * `ui:keyGuide {owner:'rescue'}` 를 올린다 (`Tab 닫기` 는 가이드가 스스로 붙이므로 넣지 않는다).
 * Escape 는 이 화면이 **먼저 먹는다** — 가장 안쪽 화면만 Escape 를 가로챈다는 2026-09-08 규약의 예외 항목이다.
 */
export class RescuePicker {
  readonly root: HTMLElement;
  private cellWrap: HTMLElement;
  private subEl: HTMLElement;
  private leftEl: HTMLElement;
  private ctx!: GameContext;
  private _open = false;
  /** One entry per squad slot; `peerId` is null for an empty / unselectable cell (the 1..4 mapping stays aligned). */
  private cells: Array<string | null> = [];
  private lastKey = '';

  /** Escape belongs to this screen while it is up (capture phase, like `menus/social/SocialMenu`). */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this._open || e.code !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.cancel();
  };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'rescue-pick interactive', parent });
    this.root.hidden = true;
    const head = el('div', { cls: 'rp-head', parent: this.root });
    el('div', { cls: 'rp-title', text: '구조선 투하', parent: head });
    this.subEl = el('div', { cls: 'rp-sub', text: '되살릴 분대원을 고르세요', parent: head });
    this.leftEl = el('div', { cls: 'rp-left ui-mono', text: '', parent: head });
    this.cellWrap = el('div', { cls: 'rp-cells', parent: this.root });
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cancel(); });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Whether the picker is up (debug / smoke). */
  get isOpen(): boolean { return this._open; }
  /** How many cells are selectable right now (debug / smoke). */
  get selectableCount(): number { return this.cells.reduce<number>((n, id) => n + (id ? 1 : 0), 0); }

  update(_dt: number, ctx: GameContext): void {
    const s = ctx.stratagems;
    const want = !!s && s.armed === 'rescue_drop' && s.rescueTarget === null && ctx.isGameplayPhase();
    if (want !== this._open) { if (want) this.open(); else this.close(); }
    if (!this._open) return;

    this.render();
    // 1..4 pick the cell in slot order; the digits are raw codes (no rebindable key owns a squad slot).
    for (let i = 0; i < DIGITS.length; i++) {
      if (!ctx.input.wasPressed(DIGITS[i])) continue;
      ctx.input.consume(DIGITS[i]);
      const id = this.cells[i];
      if (id) this.pick(id);
      return;
    }
    // Tab is the universal close (2026-09-09) — consumed so the inventory does not open behind us.
    if (ctx.input.wasPressed(Keys.INVENTORY)) { ctx.input.consume(Keys.INVENTORY); this.cancel(); return; }
    if (ctx.input.wasMousePressed(MouseButtons.AIM)) { ctx.input.consumeMouse(MouseButtons.AIM); this.cancel(); }
  }

  private open(): void {
    const ctx = this.ctx;
    this._open = true;
    this.lastKey = '';
    this.root.hidden = false;
    ctx.uiBlockers.add(RESCUE_BLOCKER);
    ctx.input.setCursorMode(true, RESCUE_BLOCKER);
    this.render();
    ctx.bus.emit('ui:keyGuide', {
      owner: 'rescue',
      keys: [
        { key: '1~4', label: '대원 선택' },
        { key: '우클릭', label: '취소' },
        { key: keyLabel(Keys.SHIP_CALL), label: '내려놓기' },
      ],
    });
    ctx.bus.emit('audio:play', { id: 'ui_open', volume: 0.5 });
  }

  private close(): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.root.hidden = true;
    ctx.uiBlockers.delete(RESCUE_BLOCKER);
    ctx.input.setCursorMode(false, RESCUE_BLOCKER);
    ctx.bus.emit('ui:keyGuide', { owner: 'rescue', keys: null });
  }

  /** 취소 — stratagems 가 `rescue:selectTarget {peerId:null}` 로 호출 자체를 내려놓는다. */
  private cancel(): void {
    if (!this._open) return;
    this.ctx.bus.emit('rescue:selectTarget', { peerId: null });
    this.close();
  }

  private pick(peerId: string): void {
    this.ctx.bus.emit('rescue:selectTarget', { peerId });
    // stratagems refuses a cell that is no longer selectable; the next frame's `want` decides whether we stay up.
  }

  private render(): void {
    const s = this.ctx.stratagems;
    if (!s) return;
    const cands: readonly RescueCandidate[] = s.getRescueCandidates();
    const left = s.rescueLeft;
    const key = `${left}|${cands.map((c) => `${c.peerId}:${c.slot}:${c.name}:${c.selectable ? 1 : 0}`).join(',')}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    setText(this.leftEl, `남은 구조선 ${left} / ${RESCUE_DROPS_PER_RAID}`);
    const any = cands.some((c) => c.selectable);
    setText(this.subEl, any ? '되살릴 분대원을 고르세요' : '구조할 대상이 없습니다');

    // One cell per squad slot; a slot nobody holds is drawn as 빈 자리 so the row keeps its width.
    const bySlot: Array<RescueCandidate | null> = new Array(NET_MAX_PLAYERS).fill(null);
    const spill: RescueCandidate[] = [];
    for (const c of cands) {
      if (c.slot >= 0 && c.slot < NET_MAX_PLAYERS && !bySlot[c.slot]) bySlot[c.slot] = c;
      else spill.push(c);
    }
    for (let i = 0; i < NET_MAX_PLAYERS && spill.length > 0; i++) if (!bySlot[i]) bySlot[i] = spill.shift()!;

    this.cells = [];
    const nodes: HTMLElement[] = [];
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const c = bySlot[i];
      const cell = el('button', { cls: `rp-cell${c?.selectable ? ' is-on' : ''}${c ? '' : ' empty'}` });
      cell.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i] ?? '#94a3b8');
      el('span', { cls: 'rp-key ui-mono', text: String(i + 1), parent: cell });
      el('span', { cls: 'rp-slot ui-mono', text: `슬롯 ${i + 1}`, parent: cell });
      el('span', { cls: 'rp-name', text: c ? (c.name || '분대원') : '빈 자리', parent: cell });
      const state = el('span', { cls: 'rp-state', parent: cell });
      if (!c) setText(state, '—');
      else if (c.selectable) setText(state, '전사 — 구조 가능');
      else setText(state, '작전 중');
      if (c?.corpse) {
        el('span', { cls: 'rp-where ui-mono', text: `시체 ${Math.round(c.corpse.x)}, ${Math.round(c.corpse.z)}`, parent: cell });
      }
      (cell as HTMLButtonElement).disabled = !c?.selectable;
      if (c?.selectable) {
        const id = c.peerId;
        cell.addEventListener('click', (e) => { e.stopPropagation(); this.pick(id); });
        this.cells.push(id);
      } else {
        // Keep the 1..4 mapping aligned with what the keycaps say, even when a cell cannot be picked.
        this.cells.push(null);
      }
      toggleClass(cell, 'is-on', !!c?.selectable);
      nodes.push(cell);
    }
    this.cellWrap.replaceChildren(...nodes);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    if (this._open) {
      this._open = false;
      this.ctx?.uiBlockers.delete(RESCUE_BLOCKER);
      this.ctx?.input.setCursorMode(false, RESCUE_BLOCKER);
    }
    this.root.remove();
  }
}
