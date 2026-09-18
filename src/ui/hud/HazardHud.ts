import * as THREE from 'three';
import type { GameContext, HazardKind, HazardZone } from '@/shared';
import { HAZARD_LABEL_KO } from '@/shared';
import '../styles/hazard.css';
import { el, setText, toggleClass } from '../dom';

/** The warning banner only changes per second, so the DOM is touched only when the second changes. */
const NONE = -1;

/** '이' when the word ends in a Hangul syllable with a final consonant, else '가' (non-Hangul → '이'). */
function subjectParticle(word: string): string {
  const ch = word.charCodeAt(word.length - 1);
  if (ch < 0xac00 || ch > 0xd7a3) return '이';
  return (ch - 0xac00) % 28 === 0 ? '가' : '이';
}

/**
 * 2026-09-13 (user's decision) — the warning text. Sandstorm · blizzard · eye of the storm are all 「폭풍」, hence
 * `폭풍이 다가온다 — n초`; toxic spores read `독성 포자가 다가온다 — n초` (the names come from `HAZARD_LABEL_KO` alone).
 */
function approachText(kind: HazardKind, seconds: number): string {
  const name = HAZARD_LABEL_KO[kind];
  return `${name}${subjectParticle(name)} 다가온다 — ${seconds}초`;
}

/**
 * **Environmental hazard HUD (2026-09-09).** It looks only at `ctx.world.hazard` (`HazardRef`) and `hazard:*` events —
 * while world/ makes no hazard, `hazard` is null and no event arrives, so this widget sleeps whole.
 *
 * Three parts:
 *   - **Warning banner** (`.hz-banner`, gameplay layer, top centre of the screen below the compass · extraction
 *     countdown). On `hazard:announced {kind, secondsLeft}` it appears as `<hazard name> 접근 — n초` and counts the
 *     seconds locally (`update` — the warning is one event, not one per second). On `hazard:started` it reads
 *     `<hazard name> 시작`, stays 3 s and disappears, after which the safe-zone gauge takes that spot over. A
 *     `ui:notify` toast + `wave_alarm` also go out once each on the warning · the start.
 *   - **Safe-zone gauge** (`.hz-prog`): `hazard:progress {progress}` 0..1 is drawn inverted, as the **safe zone left**
 *     (`1 − progress`) — at 1 the map is fully covered and it becomes `안전지대 없음`. The objective panel
 *     (`ui:objective`) is never touched: that is one line the mission flow uses, and a hazard cutting in would
 *     overwrite the extraction countdown.
 *   - **Danger zone warning** (`.hz-edge`, a red pulse at the screen edge + `.hz-inside`, one standing line):
 *     `hazard:insideChanged`. `wave_alarm` on entering; leaving turns it off silently.
 *
 * **Safe-direction arrow** (`.hz-arrow`): while a hazard runs and `HazardRef.getZones()` exists, the directions out of
 * each zone are summed (a circle gives inwards / outwards, a `front` its normal) and rotated to a camera-relative angle.
 * The compass is never touched and it all ends inside this block — the compass is for landmarks behind the discovery
 * gate while a hazard is a phenomenon the ship observes, so the rules differ.
 */
export class HazardHud {
  readonly root: HTMLElement;
  readonly edge: HTMLElement;
  private bannerEl: HTMLElement;
  private bannerText: HTMLElement;
  private progEl: HTMLElement;
  private progFill: HTMLElement;
  private progText: HTMLElement;
  private insideEl: HTMLElement;
  private arrowEl: HTMLElement;

  private kind: HazardKind | null = null;
  /** `ctx.time` at which the announced hazard starts, or NONE while nothing is announced. */
  private startsAt = NONE;
  /** `ctx.time` until which the `시작` banner stays up, or NONE. */
  private startedUntil = NONE;
  private lastSecond = NONE;
  private inside = false;
  private progress = 0;
  private lastFill = -1;
  private lastArrow = 999;
  private v = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  /**
   * `parent` = the gameplay layer (banner / gauge / arrow), `overlay` = the full-screen overlay layer, which is where
   * the edge pulse belongs — it must survive next to the vignette and the damage flash rather than inside the HUD.
   */
  constructor(parent: HTMLElement, overlay: HTMLElement) {
    this.root = el('div', { cls: 'hz-hud', parent });

    this.bannerEl = el('div', { cls: 'hz-banner', parent: this.root });
    el('i', { cls: 'warn', parent: this.bannerEl });
    this.bannerText = el('span', { cls: 'txt', text: '', parent: this.bannerEl });

    this.progEl = el('div', { cls: 'hz-prog', parent: this.root });
    const head = el('div', { cls: 'row', parent: this.progEl });
    el('span', { cls: 'ui-label', text: '안전지대', parent: head });
    this.progText = el('span', { cls: 'num ui-mono', text: '100%', parent: head });
    const bar = el('div', { cls: 'bar', parent: this.progEl });
    this.progFill = el('div', { cls: 'fill', parent: bar });
    this.arrowEl = el('div', { cls: 'hz-arrow', parent: this.progEl });
    el('i', { parent: this.arrowEl });
    el('span', { text: '안전 방향', parent: this.arrowEl });

    this.insideEl = el('div', { cls: 'hz-inside', text: '위험 구역 — 즉시 벗어나라', parent: this.root });

    this.edge = el('div', { cls: 'hz-edge', parent: overlay });
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('hazard:announced', ({ kind, secondsLeft }) => {
        this.kind = kind;
        this.startsAt = ctx.time + Math.max(0, secondsLeft);
        this.startedUntil = NONE;
        this.lastSecond = NONE;
        ctx.bus.emit('ui:notify', { text: approachText(kind, Math.ceil(secondsLeft)), kind: 'warning', duration: 3.5 });
        ctx.bus.emit('audio:play', { id: 'wave_alarm', volume: 0.7 });
      }),
      b.on('hazard:started', ({ kind }) => {
        this.kind = kind;
        this.startsAt = NONE;
        this.startedUntil = ctx.time + 3;
        this.lastSecond = NONE;
        setText(this.bannerText, `${HAZARD_LABEL_KO[kind]} 시작`);
        ctx.bus.emit('ui:notify', { text: `${HAZARD_LABEL_KO[kind]} 시작`, kind: 'danger', duration: 3 });
        ctx.bus.emit('audio:play', { id: 'wave_alarm', volume: 0.85 });
      }),
      b.on('hazard:progress', ({ progress }) => { this.progress = Math.max(0, Math.min(1, progress)); }),
      b.on('hazard:insideChanged', ({ inside, kind }) => {
        if (kind) this.kind = kind;
        if (inside === this.inside) return;
        this.inside = inside;
        toggleClass(this.edge, 'show', inside);
        toggleClass(this.insideEl, 'show', inside);
        if (inside) ctx.bus.emit('audio:play', { id: 'wave_alarm', volume: 0.6 });
      }),
      b.on('player:died', () => this.clearInside()),
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
  }

  /** Whether the warning banner / the inside warning are up, and the drawn safe-zone share (debug / smoke). */
  get isBannerOn(): boolean { return this.bannerEl.classList.contains('show'); }
  get isInside(): boolean { return this.inside; }
  get safeShare(): number { return 1 - this.progress; }

  private reset(): void {
    this.kind = null;
    this.startsAt = NONE; this.startedUntil = NONE; this.lastSecond = NONE;
    this.progress = 0; this.lastFill = -1;
    this.clearInside();
    toggleClass(this.bannerEl, 'show', false);
    toggleClass(this.progEl, 'show', false);
  }

  private clearInside(): void {
    if (!this.inside) return;
    this.inside = false;
    toggleClass(this.edge, 'show', false);
    toggleClass(this.insideEl, 'show', false);
  }

  update(ctx: GameContext): void {
    const hazard = ctx.world?.hazard ?? null;

    // Warning banner: the seconds left are counted locally (`hazard:announced` arrives only once)
    let banner = false;
    if (this.startsAt !== NONE && this.kind) {
      const left = this.startsAt - ctx.time;
      if (left <= 0) { this.startsAt = NONE; } else {
        banner = true;
        const s = Math.ceil(left);
        if (s !== this.lastSecond) { this.lastSecond = s; setText(this.bannerText, approachText(this.kind, s)); }
      }
    } else if (this.startedUntil !== NONE) {
      if (ctx.time < this.startedUntil) banner = true; else this.startedUntil = NONE;
    }
    if (banner !== this.bannerEl.classList.contains('show')) toggleClass(this.bannerEl, 'show', banner);

    // Safe-zone gauge: only while the hazard runs
    const active = hazard?.active === true;
    if (active !== this.progEl.classList.contains('show')) toggleClass(this.progEl, 'show', active);
    if (!active) return;
    if (hazard) this.progress = Math.max(0, Math.min(1, hazard.progress));
    const safe = 1 - this.progress;
    const pct = Math.round(safe * 100);
    if (pct !== this.lastFill) {
      this.lastFill = pct;
      this.progFill.style.transform = `scaleX(${safe.toFixed(3)})`;
      setText(this.progText, pct <= 0 ? '없음' : `${pct}%`);
      toggleClass(this.progEl, 'critical', pct <= 20);
    }
    this.updateArrow(ctx, hazard?.getZones() ?? null);
  }

  /**
   * Safe direction: the sum of the directions **out of** each zone. For a `front` the normal (`dirX,dirZ`) is the safe
   * side; for a `circle` it is inwards with `safeInside`, outwards otherwise. A sum near 0 (safe all round / undecidable)
   * hides the arrow.
   */
  private updateArrow(ctx: GameContext, zones: readonly HazardZone[] | null): void {
    const p = ctx.player;
    if (!p || !zones || !zones.length) { this.hideArrow(); return; }
    let sx = 0, sz = 0;
    for (const z of zones) {
      if (z.shape === 'front') { sx += z.dirX; sz += z.dirZ; continue; }
      const dx = p.position.x - z.center.x, dz = p.position.z - z.center.z;
      const d = Math.hypot(dx, dz) || 1;
      if (z.safeInside) { sx -= dx / d; sz -= dz / d; }   // safe inside the circle → towards the centre
      else { sx += dx / d; sz += dz / d; }                 // danger inside the circle → outwards
    }
    if (Math.hypot(sx, sz) < 1e-3) { this.hideArrow(); return; }
    // Screen-relative angle (0 = ahead, clockwise) — the same convention as the compass's heading maths
    const f = ctx.camera.getWorldDirection(this.v);
    const heading = Math.atan2(f.x, -f.z);
    const bearing = Math.atan2(sx, -sz);
    let rel = bearing - heading;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const deg = Math.round((rel * 180) / Math.PI);
    if (deg === this.lastArrow) { if (!this.arrowEl.classList.contains('show')) toggleClass(this.arrowEl, 'show', true); return; }
    this.lastArrow = deg;
    this.arrowEl.style.setProperty('--rot', `${deg}deg`);
    toggleClass(this.arrowEl, 'show', true);
  }

  private hideArrow(): void {
    if (this.arrowEl.classList.contains('show')) { toggleClass(this.arrowEl, 'show', false); this.lastArrow = 999; }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.root.remove();
    this.edge.remove();
  }
}
