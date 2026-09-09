import type { EmbeddedView, GameContext, PeerId } from '@/shared';
import { NET_SLOT_COLORS_CSS } from '@/shared';
import { el, setText } from './dom';

/** How long we wait for a peer's `crew loadout` answer before giving up (seconds of wall clock). */
const REQUEST_TIMEOUT_MS = 5000;

export interface CrewLoadoutTarget {
  /** null for a solo / lobby-less local player. */
  peerId: PeerId | null;
  name: string;
  slot: number;
  local: boolean;
}

/**
 * 분대원 장비 (Phase 10) — the **modeless popup** behind a right-click on a READY-panel cell: that member's
 * 장비 / 가방 / 빠른 사용, nothing else (no 함선 창고 column, no credits).
 *
 * The body is `ctx.inventory.createCrewLoadoutView(...)`, an `EmbeddedView` the inventory folder owns, so this class
 * is only a frame: header (slot bar + name + 닫기), a status line while a request is in flight, and the dismiss rules.
 * `inventory/ui/Modeless.ts` could not be reused — it is a child of the inventory window and dies with it — so the
 * frame lives in `hub.css` instead.
 *
 * It takes **no** blocker token and never touches the pointer lock: the READY panel already owns the cursor while it
 * is interactive, and losing that cursor closes this popup (`setInteractive(false)`).
 */
export class CrewLoadoutPanel {
  readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly body: HTMLElement;

  private _open = false;
  private target: CrewLoadoutTarget | null = null;
  private view: EmbeddedView | null = null;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Ignore the pointerdown that opened us (the same press bubbles to the window listener). */
  private openedAt = 0;

  private readonly onOutside = (e: Event): void => {
    if (!this._open || performance.now() - this.openedAt < 60) return;
    const t = e.target as Node | null;
    if (t && (this.root.contains(t) || this.anchor?.contains(t))) return;
    this.close();
  };

  /** Element (the cell) that opened the popup — a press on it toggles rather than double-firing. */
  private anchor: HTMLElement | null = null;

  constructor(private readonly ctx: GameContext) {
    this.root = el('div', { cls: 'hub-crew-loadout interactive', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    const head = el('header', { cls: 'hcl-head', parent: this.root });
    this.bar = el('span', { cls: 'hcl-bar', parent: head });
    const titles = el('div', { cls: 'hcl-titles', parent: head });
    el('div', { cls: 'hcl-eyebrow', text: '분대원 장비', parent: titles });
    this.nameEl = el('div', { cls: 'hcl-name', text: '', parent: titles });
    const close = el('button', { cls: 'ui-btn hcl-close', text: '닫기', parent: head });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.statusEl = el('div', { cls: 'hcl-status', text: '', parent: this.root });
    this.body = el('div', { cls: 'hcl-body', parent: this.root });
    window.addEventListener('pointerdown', this.onOutside);
  }

  get isOpen(): boolean { return this._open; }
  /** PeerId the popup is showing (null = the local player, undefined-safe for the debug getters). */
  get peerId(): PeerId | null { return this.target?.peerId ?? null; }

  /** Toggle: a second right-click on the same cell closes it. */
  toggle(target: CrewLoadoutTarget, anchor: HTMLElement | null): void {
    if (this._open && this.target && this.target.peerId === target.peerId && this.target.local === target.local) { this.close(); return; }
    this.open(target, anchor);
  }

  open(target: CrewLoadoutTarget, anchor: HTMLElement | null = null): void {
    this.reset();
    this.target = target;
    this.anchor = anchor;
    this._open = true;
    this.openedAt = performance.now();
    this.root.hidden = false;
    this.bar.style.background = NET_SLOT_COLORS_CSS[target.slot % NET_SLOT_COLORS_CSS.length];
    setText(this.nameEl, target.name);
    this.setStatus('');
    // 2026-09-09 키 가이드: read-only popup, so its line is the guide's own `Tab 닫기` (`ReadyPanel.update` closes it on Tab)
    this.ctx.bus.emit('ui:keyGuide', { owner: 'pod.loadout', keys: [] });
    this.ctx.bus.emit('hub:crewLoadoutToggled', { open: true, peerId: target.peerId });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });

    if (target.local) { this.render(this.captureLocal()); return; }
    const net = this.ctx.net;
    if (!target.peerId || !net || typeof net.requestCrewLoadout !== 'function') {
      this.setStatus('장비 정보를 받을 수 없습니다');
      return;
    }
    this.setStatus('장비 정보를 요청했습니다…');
    const want = target.peerId;
    this.unsub = this.ctx.bus.on('net:crewLoadout', ({ id, loadout }) => {
      if (!this._open || id !== want) return;
      this.render(loadout);
    });
    this.timer = setTimeout(() => { if (this._open && !this.view) this.setStatus('장비 정보를 받지 못했습니다'); }, REQUEST_TIMEOUT_MS);
    try { net.requestCrewLoadout(want); } catch { this.setStatus('장비 정보를 받을 수 없습니다'); }
  }

  /** MY own loadout comes straight off `ctx.inventory` — no round trip through the relay. */
  private captureLocal(): unknown {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.captureCrewLoadout !== 'function') return null;
    try { return inv.captureCrewLoadout(); } catch { return null; }
  }

  private render(loadout: unknown): void {
    const inv = this.ctx.inventory;
    this.disposeView();
    if (loadout === null || loadout === undefined || !inv || typeof inv.createCrewLoadoutView !== 'function') {
      this.setStatus('장비 정보를 표시할 수 없습니다');
      return;
    }
    let view: EmbeddedView | null = null;
    try {
      view = inv.createCrewLoadoutView(this.body, loadout, {
        name: this.target?.name,
        slot: this.target?.slot,
        blocks: ['equip', 'bag', 'quick'],
        className: 'hub-crew-view',
      });
    } catch (e) { console.warn('[hub] createCrewLoadoutView failed', e); }
    if (!view) { this.setStatus('장비 정보를 표시할 수 없습니다'); return; }
    this.view = view;
    this.setStatus('');
  }

  private setStatus(text: string): void {
    setText(this.statusEl, text);
    this.statusEl.hidden = text === '';
  }

  private disposeView(): void {
    if (this.view) { try { this.view.dispose(); } catch { /* ignore */ } this.view = null; }
    this.body.replaceChildren();
  }

  private reset(): void {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.disposeView();
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.reset();
    this.root.hidden = true;
    this.anchor = null;
    const peerId = this.target?.peerId ?? null;
    this.target = null;
    this.ctx.bus.emit('ui:keyGuide', { owner: 'pod.loadout', keys: null });
    this.ctx.bus.emit('hub:crewLoadoutToggled', { open: false, peerId });
  }

  dispose(): void {
    this.close();
    window.removeEventListener('pointerdown', this.onOutside);
    this.root.remove();
  }
}
