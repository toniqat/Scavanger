import type { CommsDef, CommsId, CommsMessage, GameContext, PeerId } from '@/shared';
import {
  COMMS_COOLDOWN_S, COMMS_DEF_MAP, COMMS_WHEEL_DEAD_PX, COMMS_WHEEL_HOLD_S,
  Keys, commsLayout, fillCommsLine, keyLabel,
} from '@/shared';
import '../styles/wheels.css';
import { el, setText, toggleClass } from '../dom';

/** SVG geometry (viewBox units = px) — the `StratagemWheel` ring, one size down. */
const SIZE = 280;
const R_IN = 62;
const R_OUT = 126;
const SECTOR_GAP_DEG = 3;
const LABEL_RADIUS = (R_IN + R_OUT) / 2;

/** Direction → angle (degrees, 0 = up, clockwise). Covers all six values of `CommsDir`. */
const DIR_DEG: Readonly<Record<string, number>> = { N: 0, E: 90, S: 180, W: 270, L: 270, R: 90 };

/** The angle one slot takes (degrees): 90° with 4 slots, 180° with 2. */
function spreadOf(count: number): number { return count >= 4 ? 90 : 180; }

interface Sector { arc: SVGPathElement; root: HTMLElement; label: HTMLElement; dir: HTMLElement }

/** `toggleClass` for SVG elements (not HTMLElement). */
function tc(e: Element, cls: string, on: boolean): void { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); }

/** Annular sector path; angles in degrees, 0 = up, clockwise. */
function sectorPath(a0: number, a1: number): string {
  const c = SIZE / 2;
  const pt = (r: number, a: number): string => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(c + r * Math.cos(t)).toFixed(2)} ${(c + r * Math.sin(t)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${pt(R_OUT, a0)} A${R_OUT} ${R_OUT} 0 ${large} 1 ${pt(R_OUT, a1)} L${pt(R_IN, a1)} A${R_IN} ${R_IN} 0 ${large} 0 ${pt(R_IN, a0)} Z`;
}

/**
 * **The communication wheel (`H` hold, 2026-09-09).** `.cwheel`, the gameplay layer, `pointer-events:none`.
 *
 * It shares its nature with the other two wheels (`QuickWheel` · `StratagemWheel`) but **reads its input here as well** —
 * communication has no owning system folder of its own and is complete with its contract (`shared/comms.ts`) plus chat and
 * the network. So this one file carries (1) the `Keys.COMMS` hold gesture, (2) drawing the wheel, (3) sending · receiving
 * one line, (4) the chat line · the toast.
 *
 * **The gesture.** Pressing `Keys.COMMS` (H by default) starts the hold timer, and past `COMMS_WHEEL_HOLD_S` the wheel opens.
 * While it is open the pointer-lock deltas (`input.mouseDX/DY`) accumulate, and past `COMMS_WHEEL_DEAD_PX` from the centre
 * the slot in that direction becomes hovered; releasing the key sends that one line. **A short tap does nothing** (this key
 * is the wheel and nothing else). While open it ties the camera down with `ctx.player.setLookLocked(true)` — the same way as
 * the other two wheels, and only the lock we raised is released by us (the `lookLocked` flag). It duck-types `ctx.player` instead of importing `PlayerWeaponHost`.
 *
 * **The state decides the layout** (`commsLayout` in `shared/comms.ts`): 4 slots (N/E/S/W) standing, 2 slots (left/right)
 * while downed. Being downed is re-read every frame, so going down with the wheel open changes the layout on the spot.
 * **This file does not write the wording** — `CommsDef.label` / `.line` verbatim, and only a `contract` holding `{n}` ·
 * `{name}` reads the name and the count left from `ctx.meta` (`activeContract`; `CONTRACT_MAX_ACTIVE` is 1, so "the nearest
 * one" = that one) and fills it in with `fillCommsLine`. With no contract, `CommsDef.fallback` goes out.
 *
 * **Sending · receiving.** Locally it emits `comms:sent {id, text, by:null, byName, slot, position}`, and with a lobby it
 * sends `CommsMessage {t:'comm', id, text}` to `'others'`. A remote `comm` validates `id` against `COMMS_DEF_MAP`, clips
 * `text` and emits the same `comms:sent` (with `by`/`byName`/`slot`/`position` filled in).
 *
 * **Chat · toast.** It listens to `comms:sent` alone. **Local** (`by === null`) emits `chat:post {kind:'request'}` —
 * `ChatLog` prefixes my name, writes the line and relays it to the squad, so the remote side sees `<이름>: 문장` just the
 * same (the **same path** as ping v3's callouts). **Remote** never fires chat again (the relayed copy is already coming) and
 * only raises a `ui:notify` toast. The sound comes from `audio/`, which listens to `chat:message {kind:'request'}`.
 *
 * **Cooldown.** `COMMS_COOLDOWN_S`. The wheel still opens while recharging, but the centre reads `재충전 n초`, the slots dim
 * (`.cooling`) and releasing only gives `ui_deny`.
 *
 * **It holds no blocker.** It does not release the pointer lock either and never goes on the ESC stack — the same as its two
 * siblings. So it is not put on the bottom-right key guide either (the guide appends `Tab · Esc 닫기` itself, while this
 * wheel closes by **releasing** a key, not with Tab). Its notice is one line in the wheel's centre, like its siblings' (`마우스로 선택 · H 놓기`).
 */
export class CommsWheel {
  readonly root: HTMLElement;
  private svg: SVGSVGElement;
  private items: HTMLElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private cdEl: HTMLElement;
  private sectors: Sector[] = [];
  private layout: readonly CommsDef[] = [];

  private ctx: GameContext | null = null;
  private held = false;
  private holdT = 0;
  private open = false;
  private downed = false;
  private hover: number | null = null;
  private dx = 0;
  private dy = 0;
  private lookLocked = false;
  private lastSent = -Infinity;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'cwheel', parent });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    this.svg.setAttribute('class', 'ring');
    this.root.appendChild(this.svg);
    this.items = el('div', { cls: 'items', parent: this.root });

    const centre = el('div', { cls: 'centre', parent: this.root });
    el('div', { cls: 'ui-label', text: '의사소통', parent: centre });
    this.nameEl = el('div', { cls: 'cname', text: '—', parent: centre });
    this.cdEl = el('div', { cls: 'ccd', text: '', parent: centre });
    this.subEl = el('div', { cls: 'csub', text: '', parent: centre });

    this.build(false);
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('comms:sent', (e) => this.announce(ctx, e)),
      b.on('input:bindingsChanged', () => this.applyHover()),
      b.on('player:died', () => this.cancel()),
      b.on('game:newMission', () => { this.cancel(); this.lastSent = -Infinity; }),
      b.on('game:abort', () => { this.cancel(); this.lastSent = -Infinity; }),
    );
    if (ctx.net) this.unsubs.push(ctx.net.onMessage('comm', (msg, from) => this.onRemote(msg, from)));
  }

  /** Whether the wheel is showing (debug / smoke). */
  get isOpen(): boolean { return this.open; }
  /** Hovered sector index, null when the drag has not left the dead zone (debug / smoke). */
  get hoverIndex(): number | null { return this.hover; }
  /** Which layout is drawn right now: 4 (standing) or 2 (downed) (debug / smoke). */
  get slotCount(): number { return this.layout.length; }

  /* ── The gesture ────────────────────────────────────────────────────────── */

  update(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    // Being downed must not take speech away — so `isDowned` only changes the layout and is not a gate.
    // 2026-09-11: it does not open while a drone is being controlled (an open one is folded by `!usable` below, sending
    // nothing) — the mouse belongs to the drone view. Pings (`hud/Pings`) are not blocked.
    const usable = ctx.isGameplayActive() && input.isPointerLocked && !(ctx.player?.isDead ?? false)
      && !(ctx.player?.droneControl ?? false)
      && !(ctx.player?.roverRide ?? false);   // 2026-09-13: it does not open inside the rover either

    if (!this.held) {
      if (usable && input.wasPressed(Keys.COMMS)) { this.held = true; this.holdT = 0; }
      return;
    }
    if (!usable) { this.cancel(); return; }

    if (!input.isDown(Keys.COMMS)) {
      this.held = false;
      if (!this.open) return;                       // a tap = nothing happens
      const pick = this.hover;
      this.setOpen(false);
      if (pick !== null) this.send(ctx, this.layout[pick]);
      return;
    }

    this.holdT += dt;
    if (!this.open) {
      if (this.holdT < COMMS_WHEEL_HOLD_S) return;
      this.setOpen(true);
      ctx.bus.emit('audio:play', { id: 'ui_open', volume: 0.35 });
      return;
    }

    // went down / got up with the wheel open → the layout is swapped on the spot
    const downed = ctx.player?.isDowned ?? false;
    if (downed !== this.downed) { this.build(downed); this.dx = 0; this.dy = 0; this.setHover(null, ctx); }

    this.dx += input.mouseDX; this.dy += input.mouseDY;
    this.setHover(this.pick(), ctx);
    this.applyCooldown(ctx);
  }

  /** Accumulated delta → slot index (null inside the dead zone). 4 slots take the nearest quadrant, 2 slots the dominant left/right direction. */
  private pick(): number | null {
    if (this.dx * this.dx + this.dy * this.dy < COMMS_WHEEL_DEAD_PX * COMMS_WHEEL_DEAD_PX) return null;
    if (this.layout.length >= 4) {
      // 0 = N (up), clockwise — the array order of `COMMS_ALIVE` is exactly N/E/S/W
      const ang = Math.atan2(this.dx, -this.dy);
      const n = this.layout.length;
      return ((Math.round(ang / (Math.PI / 2)) % n) + n) % n;
    }
    // 2 slots: only a horizontal left/right drag picks one (a dominant vertical picks nothing — better than sending by mistake)
    if (Math.abs(this.dx) < Math.abs(this.dy)) return null;
    const want = this.dx > 0 ? 'R' : 'L';
    const i = this.layout.findIndex((d) => d.dir === want);
    return i >= 0 ? i : null;
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    const ctx = this.ctx;
    this.open = open;
    if (open) {
      this.build(ctx?.player?.isDowned ?? false);
      this.dx = 0; this.dy = 0; this.hover = null;
      this.setLookLocked(true);
    } else {
      this.hover = null;
      this.setLookLocked(false);
    }
    toggleClass(this.root, 'show', open);
    this.applyHover();
    if (ctx) {
      this.applyCooldown(ctx);
      ctx.bus.emit('comms:wheelChanged', { open, downed: this.downed, hover: null });
    }
  }

  private setHover(hover: number | null, ctx: GameContext): void {
    if (hover === this.hover) return;
    this.hover = hover;
    this.applyHover();
    ctx.bus.emit('comms:wheelChanged', { open: true, downed: this.downed, hover });
    if (hover !== null) ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.3 });
  }

  /** It became unusable without the key being released (death · a screen opening · a mission reset): folds without sending anything. */
  private cancel(): void {
    this.held = false;
    this.setOpen(false);
  }

  /**
   * Ties the camera down. `setLookLocked` is a `PlayerWeaponHost` method, so it is duck-typed onto `ctx.player`
   * (importing that interface would mean looking inside player/). **Only the lock we raised is released by us.**
   */
  private setLookLocked(locked: boolean): void {
    if (locked === this.lookLocked) return;
    const p = this.ctx?.player as ({ setLookLocked?(v: boolean): void } | null | undefined);
    if (!p || typeof p.setLookLocked !== 'function') return;
    this.lookLocked = locked;
    p.setLookLocked(locked);
  }

  /* ── Sending · receiving ────────────────────────────────────────────────── */

  private send(ctx: GameContext, def: CommsDef | undefined): void {
    if (!def) return;
    if (ctx.time - this.lastSent < COMMS_COOLDOWN_S) { ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 }); return; }
    this.lastSent = ctx.time;

    const text = fillCommsLine(def, this.varsFor(ctx, def.id));
    const net = ctx.net;
    ctx.bus.emit('comms:sent', {
      id: def.id, text, by: null,
      byName: net?.playerName ?? '나',
      slot: net?.localSlot ?? 0,
      position: ctx.player ? ctx.player.position.clone() : null,
    });
    if (net && (ctx.isMultiplayer || net.lobby)) {
      const msg: CommsMessage = { t: 'comm', id: def.id, text };
      net.send(msg, 'others');
    }
  }

  /**
   * Filling `{n}` · `{name}`. Today `contract` is the only such entry — the contract's name and the count left are read
   * from `ctx.meta.activeContract` (`CONTRACT_MAX_ACTIVE` is 1, so at most one contract runs). With none it returns
   * undefined and `fillCommsLine` picks the `fallback`. It never looks inside the meta/ folder — only the `ctx.meta` contract.
   */
  private varsFor(ctx: GameContext, id: CommsId): { n?: number; name?: string } | undefined {
    if (id !== 'contract') return undefined;
    const info = ctx.meta?.activeContract ?? null;
    if (!info) return undefined;
    return { name: info.def.name, n: Math.max(0, info.def.target - info.progress) };
  }

  private onRemote(msg: CommsMessage, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx?.net;
    if (!ctx || !net) return;
    const def = typeof msg.id === 'string' ? COMMS_DEF_MAP.get(msg.id) : undefined;
    if (!def) return;
    const text = typeof msg.text === 'string' && msg.text.length ? msg.text.slice(0, 120) : def.fallback ?? def.line;
    const lp = net.getLobbyPlayer(from);
    const ref = net.getRemotePlayer(from);
    ctx.bus.emit('comms:sent', {
      id: def.id, text, by: from,
      byName: lp?.name ?? ref?.name ?? '분대원',
      slot: lp?.slot ?? ref?.slot ?? 0,
      position: ref ? ref.position.clone() : null,
    });
  }

  /**
   * Makes one chat line and a toast out of one `comms:sent`. Only the local side fires `chat:post` — `ChatLog` prefixes my
   * name and relays that line to the squad, so firing it again on the remote side would make the same sentence two lines (the same contract as ping v3).
   */
  private announce(ctx: GameContext, e: { text: string; by: PeerId | null; byName: string }): void {
    if (e.by === null) { ctx.bus.emit('chat:post', { text: e.text, kind: 'request' }); return; }
    ctx.bus.emit('ui:notify', { text: `${e.byName}: ${e.text}`, kind: 'warning', duration: 2.4 });
  }

  /* ── Drawing ────────────────────────────────────────────────────────────── */

  /** Called only when the layout changes (on open · on the downed transition). The slot count splits 2 ↔ 4, so the DOM is rebuilt. */
  private build(downed: boolean): void {
    const next = commsLayout(downed);
    if (this.layout === next && this.sectors.length) { this.downed = downed; return; }
    this.downed = downed;
    this.layout = next;
    toggleClass(this.root, 'downed', downed);

    const svgNS = 'http://www.w3.org/2000/svg';
    this.svg.replaceChildren();
    this.items.replaceChildren();
    this.sectors = [];
    const half = spreadOf(next.length) / 2;

    for (const def of next) {
      const a = DIR_DEG[def.dir] ?? 0;
      const arc = document.createElementNS(svgNS, 'path');
      arc.setAttribute('class', 'carc');
      arc.setAttribute('d', sectorPath(a - half + SECTOR_GAP_DEG / 2, a + half - SECTOR_GAP_DEG / 2));
      this.svg.appendChild(arc);

      const t = ((a - 90) * Math.PI) / 180;
      const root = el('div', { cls: `csector ${def.id}`, parent: this.items });
      root.style.left = `${(50 + (LABEL_RADIUS * Math.cos(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.top = `${(50 + (LABEL_RADIUS * Math.sin(t) * 100) / SIZE).toFixed(2)}%`;
      root.style.setProperty('--cc', def.color);
      const label = el('span', { cls: 'nm', text: def.label, parent: root });
      const dir = el('span', { cls: 'dir', text: def.dir === 'L' ? '◄' : def.dir === 'R' ? '►' : def.dir, parent: root });
      this.sectors.push({ arc, root, label, dir });
    }
    this.applyHover();
  }

  private applyHover(): void {
    for (let i = 0; i < this.sectors.length; i++) {
      const on = this.hover === i;
      toggleClass(this.sectors[i].root, 'hover', on);
      tc(this.sectors[i].arc, 'hover', on);
    }
    const def = this.hover !== null ? this.layout[this.hover] : null;
    setText(this.nameEl, def ? def.label : '—');
    toggleClass(this.nameEl, 'dim', !def);
    setText(this.subEl, `마우스로 선택 · ${keyLabel(Keys.COMMS)} 놓기`);
  }

  private applyCooldown(ctx: GameContext): void {
    const left = COMMS_COOLDOWN_S - (ctx.time - this.lastSent);
    const cooling = this.open && left > 0;
    toggleClass(this.root, 'cooling', cooling);
    setText(this.cdEl, cooling ? `재충전 ${Math.ceil(left)}초` : '');
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.setLookLocked(false);
    this.root.remove();
  }
}
