import * as THREE from 'three';
import type { GameContext, PeerId, PingKind } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { PING_COLOR, PING_LABEL } from './Pings';

const MAX_ARROWS = 12;
/** Viewport margin (fraction) inside which a target counts as on-screen (no arrow). */
const MARGIN = 0.06;
/** Arrow rest distance from the viewport edge (px). */
const EDGE_PAD = 44;
const PING_FADE = 1.5;

/** 2026-09-10: grenades · ship calls and now rogue drops all went to `hud/DangerIndicators`, so only pings are left. */
type Cat = 'ping';

interface Target {
  cat: Cat;
  pos: THREE.Vector3;
  icon: string;
  color: string;
  label: string;
  /** 0..1 */
  alpha: number;
  /** Extra class on the arrow — the ping kind alone (`.ping.attack`). */
  sub: string;
}

/** `owner` null = the local player's own ping (v3: own pings get arrows too); `until` = the ping's own expiry. */
interface PingEntry { id: number; pos: THREE.Vector3; kind: PingKind; until: number; owner: PeerId | null }

interface Arrow { root: HTMLElement; ico: HTMLElement; lbl: HTMLElement; lastKey: string; sub: string }

const PING_ICON: Record<PingKind, string> = {
  ground: '◆', enemy: '▲', crate: '■', extraction: '◇', item: '◈', attack: '➤', caution: '⚠',
  /* appended (2026-09-09): the downed left / right pings + structure · rail */
  help: '✚', abandon: '✖', structure: '⬢', rail: '═',
};

function cssColor(n: number): string { return `#${n.toString(16).padStart(6, '0')}`; }

/**
 * Off-screen indicators (`.offscr`, gameplay layer): pooled edge arrows (`.oarrow.ping`, `MAX_ARROWS`) for
 * things the player should know about but cannot see:
 *   (a) **2026-09-10 — not here any more.** Grenades · ship-call drops moved to the danger indicators
 *       (`hud/DangerIndicators`): an incoming threat is drawn in **one language** — a head indicator while it is on
 *       screen, a direction arc around the crosshair while it is off screen. Both branches were pulled out of this
 *       file whole so that two widgets never draw the same target,
 *   (b) pings — own **and** squadmates' (`ping:placedV2`, any `owner`; 2026-09-09 pings v3) — kept for the ping's
 *       **whole lifetime** (`until = expires` from the event; the shared `OFFSCREEN_PING_SECONDS` stays exported as a
 *       contract constant but is no longer read here), dropped on `ping:removed`; icon/colour by kind, a name-less
 *       kind label; fades over the last 1.5 s. The arrow only shows while the ping is off-screen — on screen the marker does,
 *   (c) **Rogue drops are not here either, since 2026-09-10.** The 2026-09-09 `.oarrow.drop` arrow moved to
 *       `hud/DangerIndicators` — for the same reason as (a), something falling out of the sky speaks one language,
 *       head marker on screen · direction arc off screen, which is what keeps a readout once it does come on screen.
 *       The toast is still `hud/RaidAlerts` and the alarm sound `audio/AudioSystem`.
 * Each `lateUpdate` projects the target through `ctx.camera`: on-screen (inside the viewport minus a 6 % margin, in
 * front of the camera) → arrow hidden; otherwise the projected direction from the screen centre is clamped to a rect
 * `EDGE_PAD` px inside the viewport and the arrow rotates to point at it. Behind the camera → the direction is mirrored
 * so the arrow pins to the bottom / sides. Nearest 12 targets win. Cleared on mission reset.
 *
 * **2026-09-09 — no fog gate here, deliberately.** Every arrow is a *live squad event* (a grenade of ours, a
 * squadmate's ping, a ship call somebody just made), not a world landmark, so `FogRef.isDiscovered` has nothing to
 * hide: whoever placed it saw the spot. The discovery gate lives in `WorldMarkers` / `Compass` / `ui/map`, which are
 * the three that draw extraction pads · nests · crates · gather nodes.
 */
export class OffscreenIndicators {
  readonly root: HTMLElement;
  private arrows: Arrow[] = [];
  private pings: PingEntry[] = [];
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
      b.on('ping:placedV2', ({ id, position, kind, expires, owner }) => {
        // v3: own pings too, and the arrow lives exactly as long as the ping itself
        this.pings = this.pings.filter((p) => p.id !== id);
        this.pings.push({ id, pos: position, kind, until: expires, owner });
      }),
      b.on('ping:removed', ({ id }) => { this.pings = this.pings.filter((p) => p.id !== id); }),
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
    );
  }

  private clear(): void {
    this.pings.length = 0;
    for (const a of this.arrows) this.hide(a);
  }

  private collect(ctx: GameContext): void {
    const t = ctx.time;
    const out = this.targets;
    out.length = 0;
    // (a) grenades · ship calls have been drawn by `hud/DangerIndicators` since 2026-09-10 (no duplicates).
    // (b) squad pings
    if (this.pings.length) {
      this.pings = this.pings.filter((p) => p.until > t);
      for (const p of this.pings) {
        const left = p.until - t;
        const alpha = left < PING_FADE ? Math.max(0.15, left / PING_FADE) : 1;
        out.push({ cat: 'ping', pos: p.pos, icon: PING_ICON[p.kind] ?? '◆', color: cssColor(PING_COLOR[p.kind] ?? 0x7fb7e6), label: PING_LABEL[p.kind] ?? '핑', alpha, sub: p.kind });
      }
    }
    // (c) rogue drops too have been drawn by `hud/DangerIndicators` since 2026-09-10 — something falling out of
    //     the sky goes in one language, head marker on screen · direction arc off screen (as grenades · ship calls do).
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
