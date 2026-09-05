import * as THREE from 'three';
import type { GameContext, PingKind } from '@/shared';
import { Keys, NET_SLOT_COLORS_CSS, PlayerFlags } from '@/shared';
import { el, setText } from '../dom';
import type { PingView } from '../hud/Pings';
import { PING_LABEL } from '../hud/Pings';

const BLOCKER = 'map';
const SAMPLES = 256;          // height samples per axis for the static layer
const STATIC_PX = 1024;       // resolution of the cached static canvas
const CONTOUR_STEP = 4;       // meters between contour lines
const GRID_STEP = 100;        // meters between grid lines
const MIN_ZOOM = 1, MAX_ZOOM = 4;
const NEST_RADIUS_M = 22;     // soft hazard radius drawn around nests
// Canvas fonts cannot reference CSS variables; mirror the stacks from base.css.
const FONT_LABEL = "600 9px 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', sans-serif";
const FONT_GRID = "9px 'Cascadia Mono', Consolas, monospace";

const COL = {
  bg: '#06080a',
  grid: 'rgba(232,230,225,0.10)',
  gridText: 'rgba(232,230,225,0.35)',
  text: '#e8e6e1',
  dim: 'rgba(232,230,225,0.55)',
  accent: '#ffb347',
  danger: '#ff4d4d',
  success: '#4fd17e',
  info: '#7fb7e6',
  crate: '#c9c9c9',
  crateOpened: 'rgba(201,201,201,0.28)',
  pad: '#e8e6e1',
  pickup: '#c77dff',
  attack: '#ff6a3d',
  caution: '#ffc23a',
  /* appended: tactical kit */
  gather: '#7fe6a1',
  deploy: '#8fe8ff',
};
const PING_CSS: Record<PingKind, string> = {
  ground: COL.info, enemy: COL.danger, crate: COL.success, extraction: COL.accent, item: COL.pickup, attack: COL.attack, caution: COL.caution,
};

interface MapPing { id: number; kind: PingKind; position: THREE.Vector3; expires: number; owner?: { name: string; color: string } | null; label?: string; lost?: boolean }

/**
 * Tactical map (M). Static terrain layer (height shading + hillshade + contours) cached per
 * `world:ready`; dynamic layer (pads, nests, crates, pings, player, ship) redrawn every frame while open.
 * Wheel zooms around the cursor, left-drag pans. Adds `ctx.uiBlockers` token 'map'.
 */
export class MapScreen {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private canvas: HTMLCanvasElement;
  private c2d: CanvasRenderingContext2D;
  private seedEl: HTMLElement;
  private zoomEl: HTMLElement;
  private staticCanvas: HTMLCanvasElement | null = null;
  private staticSeed = NaN;

  private _open = false;
  private side = 512;          // canvas CSS size (square)
  private dpr = 1;
  private size = 640;          // world size (meters)
  private zoom = 1;
  private ox = 0;              // view offset (CSS px)
  private oy = 0;
  private dragging = false;
  private lastMx = 0;
  private lastMy = 0;

  private activePadId: string | null = null;
  private shipPos: THREE.Vector3 | null = null;
  private pings = new Map<number, MapPing>();
  /** When set (HudSystem → Pings.getPings) pings are drawn from here (carries owner name/colour); else from events. */
  private pingSource: (() => readonly PingView[]) | null = null;
  private unsubs: Array<() => void> = [];

  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };
  private onWheel = (e: WheelEvent): void => {
    if (!this._open) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    this.zoomAround(this.zoom * factor, mx, my);
  };
  private onMouseDown = (e: MouseEvent): void => {
    if (!this._open || e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.lastMx = e.clientX; this.lastMy = e.clientY;
    this.canvas.classList.add('grabbing');
  };
  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastMx, dy = e.clientY - this.lastMy;
    this.lastMx = e.clientX; this.lastMy = e.clientY;
    this.ox += dx; this.oy += dy;
    this.clampView();
  };
  private onMouseUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.classList.remove('grabbing');
  };
  private onResize = (): void => { if (this._open) this.fit(); };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'map-screen interactive', parent });
    this.root.hidden = true;
    const frame = el('div', { cls: 'map-frame', parent: this.root });

    const side = el('div', { cls: 'map-side', parent: frame });
    const head = el('div', { cls: 'map-head', parent: side });
    el('div', { cls: 'map-title', text: '전술 지도', parent: head });
    this.seedEl = el('div', { cls: 'map-seed ui-mono', text: 'SEED —', parent: head });

    const legend = el('div', { cls: 'map-legend', parent: side });
    el('div', { cls: 'ui-label', text: '범례', parent: legend });
    const entries: Array<[string, string, string]> = [
      ['player', COL.accent, '플레이어'],
      ['pad', COL.pad, '탈출 지점'],
      ['pad active', COL.accent, '활성 탈출 지점'],
      ['ship', COL.success, '탈출 함선'],
      ['nest', COL.danger, '벌레 둥지'],
      ['crate', COL.crate, '보급 상자'],
      ['crate opened', COL.crateOpened, '개봉된 상자'],
      ['ping', COL.info, '핑'],
      ['ping attack', COL.attack, '돌격 핑'],
      ['ping caution', COL.caution, '주의 핑'],
      ['pickup', COL.pickup, '떨어진 아이템'],
      ['squad', NET_SLOT_COLORS_CSS[1], '분대원'],
      ['gather', COL.gather, '채집물'],
      ['deploy', COL.deploy, '설치물'],
      ['mine', COL.danger, '지뢰 (피아 구분 없음)'],
    ];
    for (const [cls, color, label] of entries) {
      const row = el('div', { cls: 'map-legend-row', parent: legend });
      const sw = el('i', { cls: `sw ${cls}`, parent: row });
      sw.style.setProperty('--sw', color);
      el('span', { text: label, parent: row });
    }

    const foot = el('div', { cls: 'map-foot', parent: side });
    const zoomRow = el('div', { cls: 'map-zoom-row', parent: foot });
    el('span', { cls: 'ui-label', text: '확대', parent: zoomRow });
    this.zoomEl = el('span', { cls: 'ui-mono', text: '1.0×', parent: zoomRow });
    const reset = el('button', { cls: 'ui-btn small', text: '초기화', parent: foot });
    reset.addEventListener('click', (e) => { e.stopPropagation(); this.resetView(); this.ctx?.bus.emit('audio:play', { id: 'ui_click' }); });
    el('div', { cls: 'map-hint', html: '<span class="keycap">M</span> / <span class="keycap">Esc</span> 닫기 · 휠 확대 · 드래그 이동', parent: foot });

    const wrap = el('div', { cls: 'map-canvas-wrap', parent: frame });
    this.canvas = el('canvas', { cls: 'map-canvas', parent: wrap });
    const north = el('div', { cls: 'map-north', parent: wrap });
    el('i', { parent: north });
    el('span', { text: 'N', parent: north });
    const c2d = this.canvas.getContext('2d');
    if (!c2d) throw new Error('MapScreen: 2D canvas unavailable');
    this.c2d = c2d;

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return this._open; }

  /** Draw pings from a live list (local + squad pings with owner colours) instead of the `ping:*` events. */
  setPingSource(source: (() => readonly PingView[]) | null): void { this.pingSource = source; }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', ({ seed }) => {
        this.activePadId = null; this.shipPos = null; this.pings.clear();
        this.staticCanvas = null; this.staticSeed = seed;
        setText(this.seedEl, `SEED ${seed}`);
        this.resetView();
      }),
      b.on('extraction:activated', ({ pointId }) => { this.activePadId = pointId; }),
      b.on('extraction:shipLanded', ({ position }) => { this.shipPos = position.clone(); }),
      b.on('extraction:liftoff', () => { this.shipPos = null; }),
      b.on('ping:placed', ({ id, position, kind, expires }) => { this.pings.set(id, { id, kind, position, expires }); }),
      b.on('ping:removed', ({ id }) => { this.pings.delete(id); }),
      b.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase()) this.close(false); }),
      b.on('player:died', () => this.close(false)),
      b.on('game:abort', () => { this.close(false); this.staticCanvas = null; this.pings.clear(); this.shipPos = null; this.activePadId = null; }),
    );
    window.addEventListener('keydown', this.escHandler, true);
    window.addEventListener('resize', this.onResize);
  }

  /** Poll the M key; call every frame. */
  update(ctx: GameContext): void {
    if (ctx.input.wasPressed(Keys.MAP) && ctx.isGameplayPhase() && !(ctx.player?.isDead ?? false)
      && (this._open || ctx.uiBlockers.size === 0)) {
      if (this._open) this.close(); else this.open();
    }
    if (this._open) this.draw(ctx);
  }

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    if (!ctx.world?.ready) return;
    this._open = true;
    // Blocker first, then exit lock, so GameFlow's pointerlockchange handler sees an intended exit.
    ctx.uiBlockers.add(BLOCKER);
    ctx.input.exitPointerLock();
    this.root.hidden = false;
    this.fit();
    if (!this.staticCanvas || this.staticSeed !== ctx.world.seed) this.buildStatic(ctx);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    ctx.bus.emit('ui:mapToggled', { open: true });
  }

  close(relock = true): void {
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.dragging = false;
    this.canvas.classList.remove('grabbing');
    this.root.hidden = true;
    ctx.uiBlockers.delete(BLOCKER);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    ctx.bus.emit('ui:mapToggled', { open: false });
    // The key press that closed the map is a user activation → Chrome allows re-locking here.
    // Deferred a microtask so a synchronous phase change right after the close is respected.
    if (relock) {
      queueMicrotask(() => {
        if (this._open || !ctx.isGameplayPhase() || ctx.uiBlockers.size > 0) return;
        if (ctx.player?.isDead ?? false) return;
        ctx.input.requestPointerLock();
      });
    }
  }

  /* ── view ──────────────────────────────────────────────────────────────── */

  private fit(): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    const side = Math.max(240, Math.floor(Math.min(vh * 0.85, vw - 340)));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (side !== this.side || this.canvas.width !== Math.round(side * this.dpr)) {
      // keep the same map point centered when the canvas resizes
      const cx = (this.side / 2 - this.ox) / this.scale();
      const cy = (this.side / 2 - this.oy) / this.scale();
      this.side = side;
      this.canvas.style.width = `${side}px`;
      this.canvas.style.height = `${side}px`;
      this.canvas.width = Math.round(side * this.dpr);
      this.canvas.height = Math.round(side * this.dpr);
      const s = this.scale();
      this.ox = side / 2 - cx * s;
      this.oy = side / 2 - cy * s;
      this.clampView();
    }
  }

  /** CSS px per meter. */
  private scale(): number { return (this.side / this.size) * this.zoom; }

  private resetView(): void {
    this.zoom = 1; this.ox = 0; this.oy = 0;
    setText(this.zoomEl, '1.0×');
  }

  private zoomAround(newZoom: number, mx: number, my: number): void {
    newZoom = THREE.MathUtils.clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    if (newZoom === this.zoom) return;
    const s0 = this.scale();
    const wx = (mx - this.ox) / s0, wy = (my - this.oy) / s0; // map-space (meters from the corner)
    this.zoom = newZoom;
    const s1 = this.scale();
    this.ox = mx - wx * s1;
    this.oy = my - wy * s1;
    this.clampView();
    setText(this.zoomEl, `${this.zoom.toFixed(1)}×`);
  }

  private clampView(): void {
    const extent = this.size * this.scale();
    const min = this.side - extent;
    this.ox = THREE.MathUtils.clamp(this.ox, Math.min(min, 0), 0);
    this.oy = THREE.MathUtils.clamp(this.oy, Math.min(min, 0), 0);
  }

  private toX(x: number): number { return (x + this.size / 2) * this.scale() + this.ox; }
  private toY(z: number): number { return (z + this.size / 2) * this.scale() + this.oy; }

  /* ── static layer ──────────────────────────────────────────────────────── */

  private buildStatic(ctx: GameContext): void {
    const world = ctx.world;
    if (!world?.ready) return;
    this.size = world.size;
    this.staticSeed = world.seed;
    const n = SAMPLES;
    const heights = new Float32Array(n * n);
    const cell = this.size / n;
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < n; j++) {
      const z = -this.size / 2 + (j + 0.5) * cell;
      for (let i = 0; i < n; i++) {
        const x = -this.size / 2 + (i + 0.5) * cell;
        const h = world.getHeightAt(x, z);
        heights[j * n + i] = h;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    const range = Math.max(1e-3, max - min);

    const img = new ImageData(n, n);
    const d = img.data;
    // light from the north-west, above
    const lx = -0.55, ly = 0.72, lz = -0.42;
    const lo = [18, 26, 28], hi = [150, 160, 146]; // dark low → light high
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const h = heights[k];
        const hl = heights[j * n + Math.max(0, i - 1)];
        const hr = heights[j * n + Math.min(n - 1, i + 1)];
        const hu = heights[Math.max(0, j - 1) * n + i];
        const hd = heights[Math.min(n - 1, j + 1) * n + i];
        // normal of the heightfield
        let nx = (hl - hr) / (2 * cell), ny = 1, nz = (hu - hd) / (2 * cell);
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const dot = Math.max(0, nx * lx + ny * ly + nz * lz);
        const shade = 0.55 + 0.55 * dot;
        const t = (h - min) / range;
        let r = (lo[0] + (hi[0] - lo[0]) * t) * shade;
        let g = (lo[1] + (hi[1] - lo[1]) * t) * shade;
        let b = (lo[2] + (hi[2] - lo[2]) * t) * shade;
        // contour: level changes toward the right or downward neighbour
        const lv = Math.floor(h / CONTOUR_STEP);
        if (lv !== Math.floor(hr / CONTOUR_STEP) || lv !== Math.floor(hd / CONTOUR_STEP)) {
          r *= 0.72; g *= 0.72; b *= 0.72;
          r += 12; g += 12; b += 10;
        }
        d[k * 4] = r; d[k * 4 + 1] = g; d[k * 4 + 2] = b; d[k * 4 + 3] = 255;
      }
    }
    const small = document.createElement('canvas');
    small.width = n; small.height = n;
    small.getContext('2d')!.putImageData(img, 0, 0);

    const big = document.createElement('canvas');
    big.width = STATIC_PX; big.height = STATIC_PX;
    const c = big.getContext('2d')!;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(small, 0, 0, STATIC_PX, STATIC_PX);
    // faint scanlines for texture
    c.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < STATIC_PX; y += 4) c.fillRect(0, y, STATIC_PX, 1);
    // map edge
    c.strokeStyle = 'rgba(232,230,225,0.35)';
    c.lineWidth = 2;
    c.strokeRect(1, 1, STATIC_PX - 2, STATIC_PX - 2);
    this.staticCanvas = big;
  }

  /* ── dynamic layer ─────────────────────────────────────────────────────── */

  private draw(ctx: GameContext): void {
    const c = this.c2d;
    const C = this.side;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = COL.bg;
    c.fillRect(0, 0, C, C);
    const s = this.scale();
    const extent = this.size * s;
    if (this.staticCanvas) c.drawImage(this.staticCanvas, this.ox, this.oy, extent, extent);

    this.drawGrid(c);

    const world = ctx.world;
    const t = ctx.time;
    if (world?.ready) {
      // nests
      for (const p of world.getNestPositions()) {
        const x = this.toX(p.x), y = this.toY(p.z);
        if (!this.inView(x, y, NEST_RADIUS_M * s)) continue;
        const rr = NEST_RADIUS_M * s;
        const grad = c.createRadialGradient(x, y, 0, x, y, rr);
        grad.addColorStop(0, 'rgba(255,77,77,0.28)');
        grad.addColorStop(1, 'rgba(255,77,77,0)');
        c.fillStyle = grad;
        c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
        this.triangle(c, x, y, 6, COL.danger, 'rgba(255,77,77,0.35)');
      }
      // crates
      for (const cr of world.getCrates()) {
        const x = this.toX(cr.position.x), y = this.toY(cr.position.z);
        if (!this.inView(x, y, 6)) continue;
        const sz = cr.opened ? 3 : 4;
        c.fillStyle = cr.opened ? COL.crateOpened : COL.crate;
        c.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        if (!cr.opened && cr.tier >= 3) {
          c.strokeStyle = 'rgba(255,179,71,0.8)'; c.lineWidth = 1;
          c.strokeRect(x - sz / 2 - 2, y - sz / 2 - 2, sz + 4, sz + 4);
        }
      }
      // gather nodes (채집물): small crosses, dimmed once harvested
      const nodes = world.getGatherNodes?.();
      if (nodes) {
        for (const g of nodes) {
          const x = this.toX(g.position.x), y = this.toY(g.position.z);
          if (!this.inView(x, y, 5)) continue;
          c.strokeStyle = g.harvested ? 'rgba(127,230,161,0.25)' : COL.gather;
          c.lineWidth = 1.2;
          c.beginPath();
          c.moveTo(x - 3, y); c.lineTo(x + 3, y);
          c.moveTo(x, y - 3); c.lineTo(x, y + 3);
          c.stroke();
        }
      }
      // extraction pads
      for (const e of world.getExtractionPoints()) {
        const x = this.toX(e.position.x), y = this.toY(e.position.z);
        if (!this.inView(x, y, 30)) continue;
        const active = e.id === this.activePadId;
        if (active) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 4);
          c.strokeStyle = `rgba(255,179,71,${(0.25 + 0.35 * (1 - pulse)).toFixed(3)})`;
          c.lineWidth = 1.5;
          c.beginPath(); c.arc(x, y, 10 + 10 * pulse, 0, Math.PI * 2); c.stroke();
        }
        this.diamond(c, x, y, active ? 8 : 6, active ? COL.accent : COL.pad, active ? 'rgba(255,179,71,0.45)' : 'rgba(0,0,0,0.5)');
        c.fillStyle = active ? COL.accent : COL.dim;
        c.font = FONT_LABEL;
        c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillText('탈출', x, y + 10);
      }
      // landed ship
      if (this.shipPos) {
        const x = this.toX(this.shipPos.x), y = this.toY(this.shipPos.z);
        if (this.inView(x, y, 20)) {
          c.fillStyle = COL.success;
          c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill();
          c.fillStyle = COL.bg;
          c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x + 3.5, y + 3); c.lineTo(x - 3.5, y + 3); c.closePath(); c.fill();
          c.fillStyle = COL.success;
          c.font = FONT_LABEL;
          c.textAlign = 'center'; c.textBaseline = 'top';
          c.fillText('함선', x, y + 10);
        }
      }
    }
    // dropped pickups: small diamonds
    const pickups = ctx.pickups?.getPickups();
    if (pickups) {
      for (const pk of pickups) {
        const x = this.toX(pk.position.x), y = this.toY(pk.position.z);
        if (!this.inView(x, y, 6)) continue;
        this.diamond(c, x, y, 3, COL.pickup, 'rgba(199,125,255,0.35)');
      }
    }
    // deployed gadgets: mines in red with their blast radius, everything else as a small cyan square
    const deployables = ctx.gadgets?.getDeployables?.();
    if (deployables) {
      for (const d of deployables) {
        const x = this.toX(d.position.x), y = this.toY(d.position.z);
        if (!this.inView(x, y, 24)) continue;
        if (d.kind === 'mine') {
          const rr = Math.max(3, (d.radius > 0 ? d.radius : 6.5) * s);
          c.strokeStyle = 'rgba(255,77,77,0.45)'; c.lineWidth = 1;
          c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.stroke();
          c.strokeStyle = d.armed ? COL.danger : COL.accent; c.lineWidth = 1.4;
          c.beginPath();
          c.moveTo(x - 3.5, y - 3.5); c.lineTo(x + 3.5, y + 3.5);
          c.moveTo(x + 3.5, y - 3.5); c.lineTo(x - 3.5, y + 3.5);
          c.stroke();
        } else {
          c.strokeStyle = COL.deploy; c.lineWidth = 1.2;
          c.strokeRect(x - 3, y - 3, 6, 6);
        }
      }
    }
    // pings (local: kind colour; squad: owner slot colour + name)
    const pingList: Iterable<MapPing> = this.pingSource ? this.pingSource() : this.pings.values();
    for (const p of pingList) {
      if (t >= p.expires) continue;
      const x = this.toX(p.position.x), y = this.toY(p.position.z);
      if (!this.inView(x, y, 24)) continue;
      const col = p.owner?.color ?? PING_CSS[p.kind];
      const pulse = 0.5 + 0.5 * Math.sin(t * 4.2 + p.id);
      const lostMul = p.lost ? 0.5 : 1;
      c.strokeStyle = col; c.globalAlpha = (0.25 + 0.5 * (1 - pulse)) * lostMul; c.lineWidth = 1.5;
      c.beginPath(); c.arc(x, y, 6 + 10 * pulse, 0, Math.PI * 2); c.stroke();
      c.globalAlpha = lostMul;
      switch (p.kind) {
        case 'enemy': this.triangle(c, x, y, 5, col); break;
        case 'crate': c.fillStyle = col; c.fillRect(x - 3, y - 3, 6, 6); break;
        case 'extraction': this.diamond(c, x, y, 5, col); break;
        case 'item': this.diamond(c, x, y, 4, col, 'rgba(199,125,255,0.4)'); break;
        case 'attack': this.arrow(c, x, y, 6, col); break;
        case 'caution':
          this.triangle(c, x, y, 6, col, 'rgba(255,194,58,0.35)');
          c.fillStyle = col; c.fillRect(x - 0.75, y - 2, 1.5, 3.5); c.fillRect(x - 0.75, y + 2.5, 1.5, 1.5);
          break;
        default: c.fillStyle = col; c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill(); break;
      }
      c.fillStyle = col;
      c.font = FONT_LABEL;
      c.textAlign = 'center'; c.textBaseline = 'bottom';
      const label = p.label ?? PING_LABEL[p.kind];
      c.fillText(p.owner ? `${p.owner.name} · ${label}` : label, x, y - 8);
      c.globalAlpha = 1;
    }
    // squad members (multiplayer): slot-coloured arrows + names; dead = hollow ring
    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      for (const r of net.getRemotePlayers()) {
        if (!r.connected || (r.flags & PlayerFlags.DROPPING)) continue;
        const x = this.toX(r.position.x), y = this.toY(r.position.z);
        if (!this.inView(x, y, 30)) continue;
        const col = NET_SLOT_COLORS_CSS[r.slot] ?? '#fff';
        c.globalAlpha = r.stale ? 0.45 : 1;
        if (r.isDead) {
          c.strokeStyle = col; c.lineWidth = 1.5;
          c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.stroke();
          c.beginPath(); c.moveTo(x - 3, y - 3); c.lineTo(x + 3, y + 3); c.moveTo(x + 3, y - 3); c.lineTo(x - 3, y + 3); c.stroke();
        } else {
          const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw);
          c.save();
          c.translate(x, y); c.rotate(Math.atan2(fz, fx));
          c.fillStyle = col; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(7, 0); c.lineTo(-5, 4.5); c.lineTo(-2.5, 0); c.lineTo(-5, -4.5); c.closePath();
          c.fill(); c.stroke();
          c.restore();
        }
        c.fillStyle = col;
        c.font = FONT_LABEL;
        c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillText(r.isDead ? `${r.name} · 전사` : r.name, x, y + 9);
        c.globalAlpha = 1;
      }
    }
    // player
    const player = ctx.player;
    if (player) {
      const x = this.toX(player.position.x), y = this.toY(player.position.z);
      // forward = (-sin yaw, -cos yaw) in world XZ; canvas y = +Z
      const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
      const ang = Math.atan2(fz, fx);
      c.save();
      c.translate(x, y);
      c.rotate(ang);
      // view cone
      const cone = c.createRadialGradient(0, 0, 0, 0, 0, 40);
      cone.addColorStop(0, 'rgba(255,179,71,0.30)');
      cone.addColorStop(1, 'rgba(255,179,71,0)');
      c.fillStyle = cone;
      c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 40, -0.55, 0.55); c.closePath(); c.fill();
      // arrow
      c.fillStyle = COL.accent;
      c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(9, 0); c.lineTo(-6, 5.5); c.lineTo(-3, 0); c.lineTo(-6, -5.5); c.closePath();
      c.fill(); c.stroke();
      c.restore();
    }
    c.globalAlpha = 1;
  }

  private drawGrid(c: CanvasRenderingContext2D): void {
    const C = this.side;
    c.strokeStyle = COL.grid; c.lineWidth = 1;
    c.fillStyle = COL.gridText;
    c.font = FONT_GRID;
    for (let m = -this.size / 2; m <= this.size / 2; m += GRID_STEP) {
      const x = Math.round(this.toX(m)) + 0.5;
      const y = Math.round(this.toY(m)) + 0.5;
      if (x >= 0 && x <= C) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, C); c.stroke();
        c.textAlign = 'left'; c.textBaseline = 'top';
        c.fillText(String(m), x + 3, 3);
      }
      if (y >= 0 && y <= C) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(C, y); c.stroke();
        c.textAlign = 'left'; c.textBaseline = 'bottom';
        c.fillText(String(m), 3, y - 2);
      }
    }
  }

  private inView(x: number, y: number, pad: number): boolean {
    return x >= -pad && x <= this.side + pad && y >= -pad && y <= this.side + pad;
  }

  private diamond(c: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, fill = 'rgba(0,0,0,0.5)'): void {
    c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath();
    c.fillStyle = fill; c.fill();
    c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
  }

  /** Upward chevron / arrow (attack ping). */
  private arrow(c: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, fill = 'rgba(255,106,61,0.35)'): void {
    c.beginPath();
    c.moveTo(x, y - r); c.lineTo(x + r * 0.85, y + r * 0.15); c.lineTo(x + r * 0.35, y + r * 0.15); c.lineTo(x + r * 0.35, y + r);
    c.lineTo(x - r * 0.35, y + r); c.lineTo(x - r * 0.35, y + r * 0.15); c.lineTo(x - r * 0.85, y + r * 0.15); c.closePath();
    c.fillStyle = fill; c.fill();
    c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
  }

  private triangle(c: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, fill = 'rgba(0,0,0,0.5)'): void {
    c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r * 0.9, y + r * 0.7); c.lineTo(x - r * 0.9, y + r * 0.7); c.closePath();
    c.fillStyle = fill; c.fill();
    c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    window.removeEventListener('keydown', this.escHandler, true);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (this._open) { this._open = false; this.ctx?.uiBlockers.delete(BLOCKER); }
    this.staticCanvas = null;
    this.root.remove();
  }
}
