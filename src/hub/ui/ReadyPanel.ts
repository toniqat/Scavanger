import type { GameContext, ImplantDef, ImplantId, PeerId, PortraitRef } from '@/shared';
import { HUB_READY_BLOCKER, HUB_READY_CELLS, HUB_READY_PORTRAIT_YAW, NET_SLOT_COLORS_CSS } from '@/shared';
import { el, setText, toggleClass } from './dom';
import { CrewLoadoutPanel } from './CrewLoadoutPanel';

/** One READY cell's worth of state, assembled by `HubSystem.syncPods()`. */
export interface ReadyCellInfo {
  slot: number;
  /** null while the slot is empty. */
  peerId: PeerId | null;
  name: string;
  /** true = boarded / ready → the cell draws a character. */
  ready: boolean;
  local: boolean;
  connected: boolean;
  /** Short Korean state line (`탑승 완료` / `대기 중` / `연결 끊김` …). */
  state: string;
  /** `ProgressionRef.level` locally, `CrewCardWire.level` for a peer; null when unknown. */
  level: number | null;
  /** Implant equipped **on the ship** (never the wielded one — that is always null in the hub). */
  implant: ImplantId | null;
  /** Equipped armor def id, handed to the portrait so the body wears the right plates. */
  armorId: string | null;
}

/**
 * 발사 준비 패널 (Phase 10, Helldivers-2 style) — four horizontal cells at the bottom of the shared / personal ship
 * screen, shown as soon as **any** launch slot is filled.
 *
 * Each cell shows that member's character standing, turned diagonally toward the camera's right
 * (`HUB_READY_PORTRAIT_YAW`). The bodies come from `ctx.player.createPortraits(host, HUB_READY_CELLS)` — **one**
 * canvas with `HUB_READY_CELLS` scissored viewports, owned by `player/` because it needs `SoldierModel`. When that
 * returns null (no second WebGL context) the panel degrades to name-only cells. A member who has not readied up draws
 * **no character** (`setMember(i, null)`).
 *
 * Top-left of a cell: name + `Lv. n`. Right-hand side: the member's equipped 전술 임플란트 (glyph + name; the def is
 * read through `ctx.implants.getDef`, the only cross-folder-safe route to the table). **Right-click** a cell to open
 * the modeless `CrewLoadoutPanel` with that player's 장비 / 가방 / 빠른 사용.
 *
 * Interactivity is deliberately narrower than visibility: the panel only takes `HUB_READY_BLOCKER` + the software
 * cursor (`setCursorMode`, **never** `exitPointerLock`) while the **local** player is boarded, i.e. while they are
 * strapped into the pod and have no controls anyway. A remote readying up while we walk the ship shows the panel but
 * must not steal our mouse look. `HubSystem` ignores that one token in its un-board / pointer-lock gates.
 */
export class ReadyPanel {
  readonly root: HTMLElement;
  private readonly portraitHost: HTMLElement;
  private readonly cells: Array<{
    root: HTMLElement; name: HTMLElement; lv: HTMLElement; state: HTMLElement;
    imp: HTMLElement; impGlyph: HTMLElement; impName: HTMLElement;
  }> = [];

  private portraits: PortraitRef | null = null;
  /** true once `createPortraits` was tried (null result = unavailable, never retried). */
  private portraitsTried = false;
  private readonly loadout: CrewLoadoutPanel;
  private info: (ReadyCellInfo | null)[] = [];
  private _visible = false;
  private _interactive = false;
  /** Per-cell portrait key so `setMember` only runs on a real change. */
  private memberKey: string[] = [];

  constructor(private readonly ctx: GameContext) {
    this.root = el('div', { cls: 'hub-ready', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.portraitHost = el('div', { cls: 'hr-portraits', parent: this.root });
    const row = el('div', { cls: 'hr-row', parent: this.root });
    for (let i = 0; i < HUB_READY_CELLS; i++) {
      const cell = el('div', { cls: 'hr-cell is-empty', parent: row, attrs: { 'data-slot': String(i) } });
      cell.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i % NET_SLOT_COLORS_CSS.length]);
      el('span', { cls: 'hr-edge', parent: cell });
      const top = el('div', { cls: 'hr-top', parent: cell });
      const name = el('span', { cls: 'hr-name', text: '빈 슬롯', parent: top });
      const lv = el('span', { cls: 'hr-lv', text: '', parent: top });
      const imp = el('div', { cls: 'hr-imp', parent: cell });
      const impGlyph = el('span', { cls: 'hr-imp-glyph', text: '◈', parent: imp });
      const impName = el('span', { cls: 'hr-imp-name', text: '', parent: imp });
      const state = el('div', { cls: 'hr-state', text: '—', parent: cell });
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.openLoadout(i, cell); });
      this.cells.push({ root: cell, name, lv, state, imp, impGlyph, impName });
      this.memberKey.push('');
    }
    this.loadout = new CrewLoadoutPanel(ctx);
  }

  get isVisible(): boolean { return this._visible; }
  get isInteractive(): boolean { return this._interactive; }
  /** Debug: the crew-loadout popup. */
  get crewLoadout(): CrewLoadoutPanel { return this.loadout; }

  /**
   * Push the whole row. `interactive` is `HubSystem`'s "the local player is boarded" — see the class doc for why that
   * is narrower than `visible`.
   */
  sync(cells: readonly (ReadyCellInfo | null)[], interactive: boolean): void {
    this.info = cells.slice(0, HUB_READY_CELLS);
    const visible = this.info.some((c) => !!c && c.ready);
    this.setVisible(visible);
    this.setInteractive(visible && interactive);
    for (let i = 0; i < this.cells.length; i++) this.paint(i, this.info[i] ?? null);
    if (visible) this.ensurePortraits();
    this.portraits?.setVisible(visible);
    if (this.loadout.isOpen && !this.cellFor(this.loadout.peerId)) this.loadout.close();
  }

  private cellFor(peerId: PeerId | null): ReadyCellInfo | null {
    for (const c of this.info) {
      if (!c || !c.ready) continue;
      if (c.peerId === peerId || (peerId === null && c.local)) return c;
    }
    return null;
  }

  private paint(i: number, info: ReadyCellInfo | null): void {
    const c = this.cells[i];
    const filled = !!info && info.ready;
    toggleClass(c.root, 'is-empty', !info);
    toggleClass(c.root, 'is-ready', filled);
    toggleClass(c.root, 'is-local', !!info?.local);
    toggleClass(c.root, 'is-off', !!info && !info.connected);
    setText(c.name, info ? info.name : '빈 슬롯');
    const lv = info?.level ?? null;
    setText(c.lv, lv === null ? '' : `Lv. ${lv}`);
    c.lv.hidden = lv === null;
    setText(c.state, info ? info.state : '—');

    const def = this.implantDef(info?.implant ?? null);
    if (def) {
      c.imp.hidden = false;
      c.imp.style.setProperty('--ic', def.color);
      setText(c.impGlyph, def.icon || '◈');
      setText(c.impName, def.name);
    } else {
      c.imp.hidden = true;
    }

    // Portrait: only a ready member gets a body; the key keeps `setMember` off the hot path.
    const key = filled && info ? `${info.slot}|${info.armorId ?? ''}` : '';
    if (key !== this.memberKey[i]) {
      this.memberKey[i] = key;
      if (this.portraits) {
        if (key === '') this.portraits.setMember(i, null);
        else if (info) {
          this.portraits.setMember(i, { slot: info.slot, armorId: info.armorId });
          this.portraits.setYaw(i, HUB_READY_PORTRAIT_YAW);
        }
      }
    }
  }

  /**
   * `ImplantDef` for an id. `IMPLANT_DEFS` lives in `implants/`, not in `shared/`, so the table is read through the
   * `ctx.implants` contract (defs are global — a peer's id resolves the same as our own). Missing ref → no chip.
   */
  private implantDef(id: ImplantId | null): ImplantDef | null {
    if (!id) return null;
    const imp = this.ctx.implants;
    if (!imp || typeof imp.getDef !== 'function') return null;
    try { return imp.getDef(id) ?? null; } catch { return null; }
  }

  /** Build the portrait strip once the panel is on screen (it needs a laid-out host to size its canvas). */
  private ensurePortraits(): void {
    if (this.portraits || this.portraitsTried) return;
    this.portraitsTried = true;
    const p = this.ctx.player;
    if (!p || typeof p.createPortraits !== 'function') { toggleClass(this.root, 'no-portraits', true); return; }
    let ref: PortraitRef | null = null;
    try { ref = p.createPortraits(this.portraitHost, HUB_READY_CELLS); } catch (e) { console.warn('[hub] createPortraits failed', e); }
    if (!ref) { toggleClass(this.root, 'no-portraits', true); return; }
    this.portraits = ref;
    toggleClass(this.root, 'no-portraits', false);
    // the cells were painted before the strip existed — replay what they hold
    for (let i = 0; i < this.cells.length; i++) {
      const info = this.info[i] ?? null;
      if (info && info.ready) { ref.setMember(i, { slot: info.slot, armorId: info.armorId }); ref.setYaw(i, HUB_READY_PORTRAIT_YAW); }
      else ref.setMember(i, null);
    }
  }

  private openLoadout(i: number, cell: HTMLElement): void {
    if (!this._interactive) return;
    const info = this.info[i] ?? null;
    if (!info || !info.ready) return;
    this.loadout.toggle({ peerId: info.local ? (this.ctx.net?.localId ?? null) : info.peerId, name: info.name, slot: info.slot, local: info.local }, cell);
  }

  private setVisible(on: boolean): void {
    if (on === this._visible) return;
    this._visible = on;
    this.root.hidden = !on;
    this.ctx.bus.emit('hub:readyPanelToggled', { open: on });
  }

  /** Take / release the blocker token **and** the software cursor together (never `exitPointerLock`). */
  private setInteractive(on: boolean): void {
    if (on === this._interactive) return;
    this._interactive = on;
    toggleClass(this.root, 'interactive', on);
    if (on) {
      this.ctx.uiBlockers.add(HUB_READY_BLOCKER);
      this.ctx.input.setCursorMode(true, HUB_READY_BLOCKER);
    } else {
      this.loadout.close();
      this.ctx.uiBlockers.delete(HUB_READY_BLOCKER);
      this.ctx.input.setCursorMode(false, HUB_READY_BLOCKER);
    }
  }

  /** Esc chain (`HubSystem`): true when the popup was open and is now closed. */
  closePopup(): boolean {
    if (!this.loadout.isOpen) return false;
    this.loadout.close();
    return true;
  }

  /** Hard hide (teardown / docking): drops the token, the cursor and the popup. */
  hide(): void {
    this.info = [];
    for (let i = 0; i < this.cells.length; i++) { this.memberKey[i] = ''; this.portraits?.setMember(i, null); this.paint(i, null); }
    this.setInteractive(false);
    this.setVisible(false);
    this.portraits?.setVisible(false);
  }

  update(dt: number, time: number): void {
    if (!this._visible) return;
    this.portraits?.render(dt, time);
  }

  dispose(): void {
    this.setInteractive(false);
    this.loadout.dispose();
    if (this.portraits) { try { this.portraits.dispose(); } catch { /* ignore */ } this.portraits = null; }
    this.root.remove();
  }
}
