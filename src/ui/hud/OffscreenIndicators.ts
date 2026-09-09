import * as THREE from 'three';
import type { GameContext, PeerId, PingKind, StratagemId } from '@/shared';
import { OFFSCREEN_PING_SECONDS } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { PING_COLOR, PING_LABEL } from './Pings';
import { STRATAGEM_COLOR, STRATAGEM_GLYPH, stratagemDef } from './stratagemGlyphs';

const MAX_ARROWS = 12;
/** Viewport margin (fraction) inside which a target counts as on-screen (no arrow). */
const MARGIN = 0.06;
/** Arrow rest distance from the viewport edge (px). */
const EDGE_PAD = 44;
const PING_FADE = 1.5;

type Cat = 'grenade' | 'ping' | 'call';

interface Target {
  cat: Cat;
  pos: THREE.Vector3;
  icon: string;
  color: string;
  label: string;
  /** 0..1 */
  alpha: number;
  /** Extra class on the arrow (`.ping.attack`, `.call.airstrike`). */
  sub: string;
}

interface PingEntry { id: number; pos: THREE.Vector3; kind: PingKind; until: number; owner: PeerId }
interface CallEntry { id: string; pos: THREE.Vector3; kind: StratagemId; landsAt: number; landed: boolean }

interface Arrow { root: HTMLElement; ico: HTMLElement; lbl: HTMLElement; lastKey: string; sub: string }

const PING_ICON: Record<PingKind, string> = {
  ground: '◆', enemy: '▲', crate: '■', extraction: '◇', item: '◈', attack: '➤', caution: '⚠',
};

function cssColor(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }

/**
 * Off-screen indicators (`.offscr`, gameplay layer): pooled edge arrows (`.oarrow.grenade/.ping/.call`, max 12) for
 * things the player should know about but cannot see:
 *   (a) live grenades from `ctx.weapons.getGrenades()` (● amber, label = fuse `n.ns`; brightens as the fuse runs out),
 *   (b) squadmate pings (`ping:placedV2` with `owner !== null`, kept `OFFSCREEN_PING_SECONDS`, dropped on
 *       `ping:removed`; icon/colour by kind, label `이름`-less kind label; fades over the last 1.5 s),
 *   (c) ship calls (`stratagem:called` → until `stratagem:landed` for airstrike / supply / structure, until
 *       `stratagem:ended` for the laser; glyph + colour by kind, label `n초` until landing, then the call name).
 * Each `lateUpdate` projects the target through `ctx.camera`: on-screen (inside the viewport minus a 6 % margin, in
 * front of the camera) → arrow hidden; otherwise the projected direction from the screen centre is clamped to a rect
 * `EDGE_PAD` px inside the viewport and the arrow rotates to point at it. Behind the camera → the direction is mirrored
 * so the arrow pins to the bottom / sides. Nearest 12 targets win. Cleared on mission reset.
 *
 * **2026-09-09 — no 안개 gate here, deliberately.** Every arrow is a *live squad event* (our own grenade, a
 * squadmate's ping, a ship call somebody just made), not a world landmark, so `FogRef.isDiscovered` has nothing to
 * hide: whoever placed it saw the spot. The discovery gate lives in `WorldMarkers` / `Compass` / `ui/map`, which are
 * the three that draw 탈출 신호소 · 둥지 · 상자 · 채집물.
 */
export class OffscreenIndicators {
  readonly root: HTMLElement;
  private arrows: Arrow[] = [];
  private pings: PingEntry[] = [];
  private calls: CallEntry[] = [];
  private targets: Target[] = [];
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'offscr', parent });
    for (let i = 0; i < MAX_ARROWS; i++) {
      const root = el('div', { cls: 'oarrow', parent: this.root });
      root.style.opacity = '0';
      el('i', { cls: 'tip', parent: root });
      const body = el('div', { cls: 'body', parent: root });
      const ico = el('span', { cls: 'ico', text: '', parent: body });
      const lbl = el('span', { cls: 'lbl ui-mono', text: '', parent: body });
      this.arrows.push({ root, ico, lbl, lastKey: 'hidden', sub: '' });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('ping:placedV2', ({ id, position, kind, owner }) => {
        if (owner === null) return;
        this.pings = this.pings.filter((p) => p.id !== id);
        this.pings.push({ id, pos: position, kind, until: ctx.time + OFFSCREEN_PING_SECONDS, owner });
      }),
      b.on('ping:removed', ({ id }) => { this.pings = this.pings.filter((p) => p.id !== id); }),
      b.on('stratagem:called', ({ callId, kind, position, landsAt }) => {
        this.calls = this.calls.filter((c) => c.id !== callId);
        this.calls.push({ id: callId, pos: position, kind, landsAt, landed: false });
      }),
      b.on('stratagem:landed', ({ callId, kind }) => {
        if (kind === 'orbital_laser') { const c = this.calls.find((x) => x.id === callId); if (c) c.landed = true; }
        else this.calls = this.calls.filter((c) => c.id !== callId);
      }),
      b.on('stratagem:ended', ({ callId }) => { this.calls = this.calls.filter((c) => c.id !== callId); }),
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
    );
  }

  private clear(): void {
    this.pings.length = 0; this.calls.length = 0;
    for (const a of this.arrows) this.hide(a);
  }

  private collect(ctx: GameContext): void {
    const t = ctx.time;
    const out = this.targets;
    out.length = 0;
    // (a) grenades
    const grenades = ctx.weapons?.getGrenades?.();
    if (grenades) {
      for (const g of grenades) {
        const hot = g.fuse < 1;
        out.push({ cat: 'grenade', pos: g.position, icon: '●', color: hot ? '#ff4d4d' : '#ffb347', label: `${Math.max(0, g.fuse).toFixed(1)}s`, alpha: 1, sub: hot ? 'hot' : '' });
      }
    }
    // (b) squad pings
    if (this.pings.length) {
      this.pings = this.pings.filter((p) => p.until > t);
      for (const p of this.pings) {
        const left = p.until - t;
        const alpha = left < PING_FADE ? Math.max(0.15, left / PING_FADE) : 1;
        out.push({ cat: 'ping', pos: p.pos, icon: PING_ICON[p.kind] ?? '◆', color: cssColor(PING_COLOR[p.kind] ?? 0x7fb7e6), label: PING_LABEL[p.kind] ?? '핑', alpha, sub: p.kind });
      }
    }
    // (c) ship calls
    for (const c of this.calls) {
      const def = stratagemDef(c.kind);
      const eta = c.landsAt - t;
      const label = !c.landed && eta > 0 ? `${Math.ceil(eta)}초` : (def?.name ?? '');
      out.push({ cat: 'call', pos: c.pos, icon: STRATAGEM_GLYPH[c.kind], color: STRATAGEM_COLOR[c.kind], label, alpha: 1, sub: c.kind });
    }
    if (out.length > MAX_ARROWS) {
      const p = ctx.player?.position;
      if (p) out.sort((a, b) => a.pos.distanceToSquared(p) - b.pos.distanceToSquared(p));
      out.length = MAX_ARROWS;
    }
  }

  lateUpdate(ctx: GameContext): void {
    this.collect(ctx);
    const cam = ctx.camera;
    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    if (w <= 0 || h <= 0) return;
    const cx = w / 2, cy = h / 2;
    const hx = cx - EDGE_PAD, hy = cy - EDGE_PAD;
    let ai = 0;
    for (const tg of this.targets) {
      if (ai >= MAX_ARROWS) break;
      this.v.copy(tg.pos); this.v.y += 0.6;
      this.v.project(cam);
      // NDC → in front when |z| ≤ 1 (perspective: behind the camera flips x/y and pushes z > 1).
      const behind = this.v.z > 1 || this.v.z < -1;
      let nx = this.v.x, ny = this.v.y;
      if (!behind && Math.abs(nx) <= 1 - MARGIN * 2 && Math.abs(ny) <= 1 - MARGIN * 2) continue; // visible → no arrow
      if (behind) {
        // Mirrored direction; make sure it points down/sideways rather than up.
        nx = -nx; ny = -ny;
        if (Math.abs(nx) < 0.15 && ny > -0.2) ny = -1;
        if (ny > 0) ny = -Math.abs(ny) * 0.4 - 0.6;
      }
      // Direction from the centre in pixel space (flip y), clamp to the padded rect.
      let dx = nx * cx, dy = -ny * cy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const sx = Math.abs(dx) > 1e-6 ? hx / Math.abs(dx) : Infinity;
      const sy = Math.abs(dy) > 1e-6 ? hy / Math.abs(dy) : Infinity;
      const s = Math.min(sx, sy);
      const px = cx + dx * s, py = cy + dy * s;
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      this.draw(this.arrows[ai++], tg, px, py, ang);
    }
    for (; ai < MAX_ARROWS; ai++) this.hide(this.arrows[ai]);
  }

  private draw(a: Arrow, tg: Target, x: number, y: number, ang: number): void {
    const key = `${tg.cat}|${tg.sub}|${Math.round(x)}|${Math.round(y)}|${Math.round(ang)}|${tg.label}|${tg.alpha.toFixed(2)}|${tg.color}`;
    if (key === a.lastKey) return;
    a.lastKey = key;
    const cls = `${tg.cat} ${tg.sub}`.trim();
    if (a.sub !== cls) {
      a.root.className = `oarrow ${cls}`;
      a.sub = cls;
    }
    a.root.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
    a.root.style.opacity = tg.alpha.toFixed(2);
    a.root.style.setProperty('--oc', tg.color);
    a.root.style.setProperty('--rot', `${ang.toFixed(0)}deg`);
    setText(a.ico, tg.icon);
    setText(a.lbl, tg.label);
    toggleClass(a.root, 'show', true);
  }

  private hide(a: Arrow): void {
    if (a.lastKey === 'hidden') return;
    a.lastKey = 'hidden';
    a.root.style.opacity = '0';
    toggleClass(a.root, 'show', false);
  }

  /** Number of arrows currently showing (debug / smoke). */
  get visibleCount(): number { let n = 0; for (const a of this.arrows) if (a.lastKey !== 'hidden') n++; return n; }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
