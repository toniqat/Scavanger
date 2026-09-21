import type { GameContext, RaidSquadEntry, TrustRef } from '@/shared';
import { NET_SLOT_COLORS_CSS, PLAYER_TRUST_LIKE_GAIN, PLAYER_TRUST_TABLE } from '@/shared';
import { el, fmtInt, setText, toggleClass } from '../../dom';
import { CHECK_SVG, THUMB_SVG } from './icons';

const TRUST_DELAY = 0.35;   // seconds before the bars start moving (after the page's entry fade)
const TRUST_TWEEN_S = 1.0;  // one tween (the raid's gain, then each like) runs this long
/** Face snapshot size, CSS px — the tile is at most this wide (`results.css` `--rs-sq-tile`); drawn × devicePixelRatio (2 at most). */
const FACE_CSS_PX = 180;
/** Tiles on the page (the squad is four). */
const MAX_TILES = 4;

interface TileView {
  entry: RaidSquadEntry;
  root: HTMLElement;
  like: HTMLButtonElement;
  lvEl: HTMLElement;
  gainEl: HTMLElement;
  fill: HTMLElement;
  trustBox: HTMLElement;
  /** Points on screen, the tween's start and its end. */
  cur: number;
  from: number;
  to: number;
  t: number;
  liked: boolean;
  shownLevel: number;
  lastLv: string;
}

/**
 * Page ④ of the result screen — **분대원** (2026-09-21, the paged result screen, user's decisions). Squad raids only
 * (`rewards.squad` non-empty; solo skips the page). Up to four square face tiles in one row, the look of the terminal
 * match tab / launch slots (face from `PlayerRef.snapshotFace` with the member's accent, accent line on top, name and
 * `Lv.n` at the bottom) **without** the equipment list and ready button. Under each face: the pair's **player trust**
 * — `신뢰 Lv.n`, a bar that runs from `trustBefore` up by `trustRaidGain` (levels read through `ctx.net.trust.infoOf`,
 * so a crossing wraps the bar and flashes the tile) and the gained points.
 *
 * Top-right of each tile: a 좋아요 thumb. A click calls `ctx.net.trust.like(code)`; on true it becomes a check mark and
 * the bar runs further by `PLAYER_TRUST_LIKE_GAIN`. Without `ctx.net.trust` the button and the bar are hidden; with
 * `canLike` false (and not liked yet) the button is disabled.
 */
export class SquadPage {
  readonly root: HTMLElement;
  private row: HTMLElement;
  private ctx: GameContext | null = null;
  private tiles: TileView[] = [];
  private running = false;
  private delay = 0;
  private job = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'rs-squad', parent });
    el('div', { cls: 'ui-label rs-sq-cap', text: '함께한 분대원', parent: this.root });
    this.row = el('div', { cls: 'rs-sq-row', parent: this.root });
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  private get trust(): TrustRef | null { return this.ctx?.net?.trust ?? null; }

  /** True when the page has something to show (the screen skips it otherwise). */
  get hasRows(): boolean { return this.tiles.length > 0; }

  fill(squad: readonly RaidSquadEntry[] | undefined): void {
    this.row.replaceChildren();
    this.tiles = [];
    this.running = false;
    const job = ++this.job;
    const list = (squad ?? []).slice(0, MAX_TILES);
    const trust = this.trust;
    list.forEach((entry, i) => {
      const accent = entry.accent ?? NET_SLOT_COLORS_CSS[(i + 1) % NET_SLOT_COLORS_CSS.length];
      const root = el('div', { cls: 'rs-sq', parent: this.row });
      root.style.setProperty('--sc', accent);
      const face = el('div', { cls: 'rs-sq-face', parent: root });
      el('div', { cls: 'rs-sq-initial', text: entry.name.slice(0, 1), parent: face });
      root.classList.add('no-face');
      this.faceLater(job, root, face, accent);

      const like = el('button', { cls: 'rs-sq-like', html: THUMB_SVG, parent: root });
      like.type = 'button';
      like.title = '좋아요';
      like.setAttribute('aria-label', '좋아요');
      const info = el('div', { cls: 'rs-sq-info', parent: root });
      el('div', { cls: 'rs-sq-name', text: entry.name, parent: info });
      if (typeof entry.level === 'number') el('div', { cls: 'rs-sq-lv', text: `Lv.${entry.level}`, parent: info });

      const trustBox = el('div', { cls: 'rs-sq-trust', parent: root });
      const head = el('div', { cls: 'rs-sq-thead', parent: trustBox });
      const lvEl = el('span', { cls: 'rs-sq-tlv', text: '', parent: head });
      const gainEl = el('span', { cls: 'rs-sq-tgain', text: '', parent: head });
      const bar = el('div', { cls: 'rs-sq-tbar', parent: trustBox });
      const fill = el('div', { cls: 'rs-sq-tfill', parent: bar });

      const before = Math.max(0, entry.trustBefore);
      const liked = !!trust?.hasLiked(entry.code);
      const to = before + Math.max(0, entry.trustRaidGain) + (liked ? PLAYER_TRUST_LIKE_GAIN : 0);
      const v: TileView = {
        entry, root, like, lvEl, gainEl, fill, trustBox,
        cur: before, from: before, to, t: 0, liked, shownLevel: trust ? trust.infoOf(before).level : 0, lastLv: '',
      };
      like.addEventListener('click', (e) => { e.stopPropagation(); this.onLike(v); });
      this.tiles.push(v);
      this.paintLike(v);
      this.paintTrust(v);
    });
  }

  enter(): void {
    this.delay = TRUST_DELAY;
    this.running = true;
    for (const v of this.tiles) v.t = 0;
  }

  finish(): void {
    if (!this.running) return;
    for (const v of this.tiles) { v.cur = v.to; v.from = v.to; v.t = TRUST_TWEEN_S; this.paintTrust(v); }
    this.delay = 0;
  }

  update(dt: number): void {
    if (!this.running) return;
    if (this.delay > 0) { this.delay -= dt; return; }
    for (const v of this.tiles) {
      if (v.cur === v.to) continue;
      v.t = Math.min(TRUST_TWEEN_S, v.t + dt);
      const k = v.t / TRUST_TWEEN_S;
      v.cur = v.t >= TRUST_TWEEN_S ? v.to : v.from + (v.to - v.from) * (1 - Math.pow(1 - k, 3));
      this.paintTrust(v);
    }
  }

  stop(): void { this.running = false; }

  private onLike(v: TileView): void {
    const trust = this.trust;
    if (!trust || v.liked || !trust.canLike(v.entry.code)) return;
    this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    if (!trust.like(v.entry.code)) { this.paintLike(v); return; }
    v.liked = true;
    // The bar runs on from wherever it is now.
    v.from = v.cur;
    v.to += PLAYER_TRUST_LIKE_GAIN;
    v.t = 0;
    this.running = true;
    this.paintLike(v);
    this.paintTrust(v);
  }

  private paintLike(v: TileView): void {
    const trust = this.trust;
    v.like.hidden = !trust;
    if (!trust) return;
    const liked = v.liked || trust.hasLiked(v.entry.code);
    toggleClass(v.like, 'is-liked', liked);
    v.like.disabled = liked || !trust.canLike(v.entry.code);
    v.like.innerHTML = liked ? CHECK_SVG : THUMB_SVG;
    v.like.title = liked ? '좋아요 보냄' : '좋아요';
  }

  private paintTrust(v: TileView): void {
    const trust = this.trust;
    v.trustBox.hidden = !trust;
    if (!trust) return;
    const info = trust.infoOf(v.cur);
    // `infoOf` floors the points; the bar reads the unfloored tween value inside the level's band so it moves smoothly.
    const prev = PLAYER_TRUST_TABLE[info.level] ?? 0;
    const frac = info.next === null ? 1 : Math.min(1, Math.max(0, (v.cur - prev) / Math.max(1, info.next - prev)));
    v.fill.style.transform = `scaleX(${frac.toFixed(4)})`;
    if (info.level > v.shownLevel) {
      v.shownLevel = info.level;
      v.root.classList.add('is-up');
      this.ctx?.bus.emit('audio:play', { id: 'ui_equip' });
    }
    const lv = `신뢰 Lv.${info.level}`;
    if (lv !== v.lastLv) { v.lastLv = lv; setText(v.lvEl, lv); }
    setText(v.gainEl, `+${fmtInt(Math.round(v.cur - Math.max(0, v.entry.trustBefore)))}`);
  }

  /** The face snapshot (cached PNG), drawn on the next frame so the page comes up first; the initial stays without GL. */
  private faceLater(job: number, tile: HTMLElement, host: HTMLElement, accent: string): void {
    const draw = (): void => {
      if (job !== this.job) return;
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      const size = Math.round(FACE_CSS_PX * Math.min(2, Math.max(1, dpr)));
      let url: string | null = null;
      try { url = this.ctx?.player?.snapshotFace?.({ accent, size }) ?? null; } catch { url = null; }
      if (!url || job !== this.job) return;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = url;
      host.replaceChildren(img);
      tile.classList.remove('no-face');
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(draw); else draw();
  }

  /** Per-tile state (debug). */
  get tileViews(): Array<{ code: string; points: number; level: number | null; liked: boolean; likeHidden: boolean; likeDisabled: boolean }> {
    const trust = this.trust;
    return this.tiles.map((v) => ({
      code: v.entry.code, points: v.cur, level: trust ? trust.infoOf(v.cur).level : null,
      liked: v.liked, likeHidden: v.like.hidden === true, likeDisabled: v.like.disabled,
    }));
  }
  /** Whether any trust bar is still moving (debug). */
  get isAnimating(): boolean { return this.running && this.tiles.some((v) => v.cur !== v.to); }
}
