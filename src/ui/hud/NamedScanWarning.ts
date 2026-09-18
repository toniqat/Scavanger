import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/named.css';

/** How many scope glints are tracked at once — at most one named per raid, so this is slack. */
const MAX_GLINTS = 3;
/** |NDC| beyond this counts as off screen (the same value as `DangerIndicators`). */
const EDGE_NDC = 0.94;
/** Below this share of the total aim time left it blinks fast. */
const GLINT_HOT_SHARE = 0.45;
/** Guard on the exposure pip count (so an out-of-contract value cannot explode the DOM). */
const MAX_PIPS = 12;

interface Glint { enemyId: number; pos: THREE.Vector3; mine: boolean; left: number; dur: number; active: boolean }
interface GlintView { head: HTMLElement; arc: HTMLElement; headKey: string; arcKey: string }

/**
 * **Roden scan · sniper warning** (`.named-scan`, gameplay layer, 2026-09-11).
 *
 * Three parts:
 *   - **Exposure banner** (`.ns-banner`, top centre — below the hazard banner block): on `named:scanExposure
 *     {count, total}` with count > 0 it reads `스캔에 노출되고 있음` + the pips `count / total`. Past half the pips it is
 *     `.warm`, at `total − 1` or more `.crit` (a deeper red · fast pulse + the subtitle `엄폐하라`). At count 0 it
 *     disappears. The numbers (how many pulses) ride on the event, so none live here.
 *   - **Pulse sweep** (`.ns-sweep`): only while `named:scanPulse` is `exposedLocal`, a red vignette at the screen edge +
 *     an outward ring pass once (briefly). A pulse that did not expose is silent — the warning means "you were just tagged".
 *   - **Scope glint** (`named:sniperGlint`): the same visual grammar as `DangerIndicators` — on screen a glint marker at
 *     the enemy's spot (`.ns-head`), off screen a red direction arc around the crosshair (`.ns-arc`, a screen-relative
 *     bearing, 0° = ahead · clockwise). The two never appear together. **When the target is oneself (`targetLocal`)**:
 *     the arc + a big marker + the text `저격 조준!`; **when it is not, only the small on-screen glint** is drawn (no arc,
 *     no text) — a squadmate being aimed at must show too, so "sniper over there" can be called, but a red arc at one's
 *     own screen edge reads as being aimed at oneself.
 *     The bearing is measured from the **camera position**, not the player — so the arc matches the screen even while a
 *     drone is being controlled.
 *
 * It does not hide while a drone is controlled (the PC is still exposed · sniped). It hides whole behind a menu / the
 * map / death / outside the phase, and `game:abort` · `game:newMission` · `hub:entered` · `player:died` empty it. The
 * DOM is pooled and written only when the key changes. No per-frame allocation (scratch vectors are reused).
 */
export class NamedScanWarning {
  readonly root: HTMLElement;
  private sweep: HTMLElement;
  private banner: HTMLElement;
  private countEl: HTMLElement;
  private pipsEl: HTMLElement;
  private pips: HTMLElement[] = [];
  private aimEl: HTMLElement;
  private arcsRoot: HTMLElement;
  private views: GlintView[] = [];
  private glints: Glint[] = [];

  private count = 0;
  private total = 0;
  private drawnCount = -1;
  private drawnTotal = -1;
  private off = false;
  private aimShown = false;
  private readonly v = new THREE.Vector3();
  private readonly camF = new THREE.Vector3();
  private readonly camP = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'named-scan', parent });

    this.sweep = el('div', { cls: 'ns-sweep', parent: this.root });
    el('i', { cls: 'ring', parent: this.sweep });

    this.banner = el('div', { cls: 'ns-banner', parent: this.root });
    const row = el('div', { cls: 'row', parent: this.banner });
    el('i', { cls: 'ico', parent: row });
    el('span', { cls: 'ttl', text: '스캔에 노출되고 있음', parent: row });
    this.countEl = el('span', { cls: 'cnt ui-mono', text: '', parent: row });
    this.pipsEl = el('div', { cls: 'ns-pips', parent: this.banner });
    el('div', { cls: 'ns-sub', text: '엄폐하라', parent: this.banner });

    this.aimEl = el('div', { cls: 'ns-aim', text: '저격 조준!', parent: this.root });

    const glintRoot = el('div', { cls: 'ns-glints', parent: this.root });
    this.arcsRoot = el('div', { cls: 'ns-arcs', parent: glintRoot });
    for (let i = 0; i < MAX_GLINTS; i++) {
      const head = el('div', { cls: 'ns-head', parent: glintRoot });
      head.hidden = true;
      el('i', { cls: 'ring', parent: head });
      el('i', { cls: 'flare', parent: head });
      el('span', { cls: 'lbl', text: '저격', parent: head });
      const arc = el('div', { cls: 'ns-arc', parent: this.arcsRoot });
      arc.hidden = true;
      el('i', { cls: 'wedge', parent: arc });
      const tag = el('div', { cls: 'tag', parent: arc });
      el('span', { cls: 'ico', text: '✦', parent: tag });
      el('span', { cls: 'lbl', text: '저격', parent: tag });
      this.views.push({ head, arc, headKey: '', arcKey: '' });
      this.glints.push({ enemyId: -1, pos: new THREE.Vector3(), mine: false, left: 0, dur: 1, active: false });
    }
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('named:scanExposure', ({ count, total }) => this.setExposure(count, total)),
      b.on('named:scanPulse', ({ exposedLocal }) => { if (exposedLocal && !this.off) this.sweepOnce(); }),
      b.on('named:sniperGlint', ({ enemyId, position, targetLocal, duration }) => this.addGlint(enemyId, position, targetLocal, duration)),
      b.on('player:died', () => this.reset()),
      b.on('game:abort', () => this.reset()),
      b.on('game:newMission', () => this.reset()),
      b.on('hub:entered', () => this.reset()),
    );
  }

  /* ── Exposure banner ────────────────────────────────────────────────────── */

  private setExposure(count: number, total: number): void {
    const t = Math.max(1, Math.min(MAX_PIPS, Math.round(total) || 1));
    const c = Math.max(0, Math.min(t, Math.round(count) || 0));
    const rose = c > this.count;
    this.count = c;
    this.total = t;
    this.drawBanner();
    if (rose && c > 0) {
      toggleClass(this.pipsEl, 'bump', false);
      void this.pipsEl.offsetWidth;   // restart the animation
      toggleClass(this.pipsEl, 'bump', true);
    }
  }

  private drawBanner(): void {
    const on = this.count > 0;
    toggleClass(this.banner, 'show', on);
    if (!on) return;
    if (this.total !== this.drawnTotal) {
      this.drawnTotal = this.total;
      this.drawnCount = -1;
      this.pipsEl.replaceChildren();
      this.pips = [];
      for (let i = 0; i < this.total; i++) this.pips.push(el('i', { parent: this.pipsEl }));
    }
    if (this.count === this.drawnCount) return;
    this.drawnCount = this.count;
    for (let i = 0; i < this.pips.length; i++) toggleClass(this.pips[i], 'on', i < this.count);
    setText(this.countEl, `${this.count} / ${this.total}`);
    const crit = this.count >= this.total || (this.total >= 2 && this.count >= this.total - 1);
    toggleClass(this.banner, 'warm', !crit && this.count * 2 >= this.total);
    toggleClass(this.banner, 'crit', crit);
  }

  private sweepOnce(): void {
    toggleClass(this.sweep, 'go', false);
    void this.sweep.offsetWidth;   // the same animation again from the start
    toggleClass(this.sweep, 'go', true);
  }

  /* ── Scope glint ────────────────────────────────────────────────────────── */

  private addGlint(enemyId: number, position: THREE.Vector3, mine: boolean, duration: number): void {
    let slot: Glint | null = null;
    for (const g of this.glints) if (g.active && g.enemyId === enemyId) { slot = g; break; }
    if (!slot) for (const g of this.glints) if (!g.active) { slot = g; break; }
    if (!slot) { slot = this.glints[0]; for (const g of this.glints) if (g.left < slot.left) slot = g; }
    slot.enemyId = enemyId;
    slot.pos.copy(position);
    slot.mine = mine;
    slot.dur = Math.max(0.1, duration);
    slot.left = slot.dur;
    slot.active = true;
  }

  private reset(): void {
    this.count = 0;
    this.drawBanner();
    toggleClass(this.sweep, 'go', false);
    toggleClass(this.pipsEl, 'bump', false);
    for (const g of this.glints) g.active = false;
    this.hideGlints();
  }

  private hideGlints(): void {
    for (const v of this.views) {
      if (!v.head.hidden) { v.head.hidden = true; v.headKey = ''; }
      if (!v.arc.hidden) { v.arc.hidden = true; v.arcKey = ''; }
    }
    if (this.aimShown) { this.aimShown = false; toggleClass(this.aimEl, 'show', false); }
  }

  /**
   * Called from `HudSystem.lateUpdate` (2026-09-11, C-53 · X-9 — the same spot as `DangerIndicators`) so the glint projection
   * uses the camera of the frame being drawn. It ran in `update` before, i.e. **before** `CameraRig` moved the camera,
   * so on-screen glints trailed a turning view by a frame. Timers tick here too — one entry point, like `DangerIndicators`.
   */
  lateUpdate(dt: number, ctx: GameContext): void {
    for (const g of this.glints) {
      if (!g.active) continue;
      g.left -= dt;
      if (g.left <= 0) g.active = false;
    }
    const p = ctx.player;
    const active = ctx.isGameplayPhase() && !!p && !p.isDead
      && !ctx.uiBlockers.has('menu') && !ctx.uiBlockers.has('map');
    if (active === this.off) { this.off = !active; toggleClass(this.root, 'off', this.off); }
    if (!active) { this.hideGlints(); return; }

    const w = ctx.uiRoot.clientWidth, h = ctx.uiRoot.clientHeight;
    if (w <= 0 || h <= 0) return;
    const cam = ctx.camera;
    cam.getWorldDirection(this.camF);
    cam.getWorldPosition(this.camP);
    const camYaw = Math.atan2(this.camF.x, -this.camF.z);
    let aim = false;

    for (let i = 0; i < this.glints.length; i++) {
      const g = this.glints[i];
      const view = this.views[i];
      let showHead = false, showArc = false;
      if (g.active) {
        const hot = g.left < g.dur * GLINT_HOT_SHARE;
        if (g.mine) aim = true;
        this.v.copy(g.pos).project(cam);
        const behind = this.v.z > 1 || this.v.z < -1;
        const offScreen = behind || Math.abs(this.v.x) > EDGE_NDC || Math.abs(this.v.y) > EDGE_NDC;
        if (!offScreen) {
          showHead = true;
          const px = Math.round((this.v.x * 0.5 + 0.5) * w);
          const py = Math.round((-this.v.y * 0.5 + 0.5) * h);
          const key = `${px}|${py}|${g.mine ? 1 : 0}|${hot ? 1 : 0}`;
          if (view.head.hidden) view.head.hidden = false;
          if (key !== view.headKey) {
            view.headKey = key;
            view.head.style.transform = `translate(${px}px, ${py}px)`;
            toggleClass(view.head, 'mine', g.mine);
            toggleClass(view.head, 'hot', hot);
          }
        } else if (g.mine) {
          showArc = true;
          const toYaw = Math.atan2(g.pos.x - this.camP.x, -(g.pos.z - this.camP.z));
          const d = toYaw - camYaw;
          const deg = Math.round((Math.atan2(Math.sin(d), Math.cos(d)) * 180) / Math.PI);
          const key = `${deg}|${hot ? 1 : 0}`;
          if (view.arc.hidden) view.arc.hidden = false;
          if (key !== view.arcKey) {
            view.arcKey = key;
            view.arc.style.setProperty('--rot', `${deg}deg`);
            toggleClass(view.arc, 'hot', hot);
          }
        }
      }
      if (!showHead && !view.head.hidden) { view.head.hidden = true; view.headKey = ''; }
      if (!showArc && !view.arc.hidden) { view.arc.hidden = true; view.arcKey = ''; }
    }
    if (aim !== this.aimShown) { this.aimShown = aim; toggleClass(this.aimEl, 'show', aim); }
  }

  /** Exposure pip count (0 = no banner) · whether the banner is up · live glint count · the `저격 조준!` text (debug / smoke). */
  get exposureCount(): number { return this.count; }
  get isBannerOn(): boolean { return this.banner.classList.contains('show'); }
  get glintCount(): number { let n = 0; for (const g of this.glints) if (g.active) n++; return n; }
  get isAimWarningOn(): boolean { return this.aimShown; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.root.remove();
  }
}
