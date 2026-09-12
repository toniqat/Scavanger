import * as THREE from 'three';
import type { FogRef, GameContext, HazardRef, PingKind } from '@/shared';
import { HAZARD_LABEL_KO, Keys, MENU_BLOCKER, NET_SLOT_COLORS_CSS, PlayerFlags, SUSPENDED_LABEL_KO, keyLabel } from '@/shared';
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
  /* appended (2026-09-09): 레이드 플레이 개선 — 구조물 · 선로 · 전차 · 환경 재해 */
  structure: '#d8c48a',
  rail: '#9fb4c7',
  tram: '#ffd27f',
  grove: '#b98cff',
  /* appended (2026-09-11, C-11): 폐허 전초 (POI) — 구조물(모래색)보다 낮은 채도의 콘크리트 색 */
  outpost: '#a9a59a',
};
/**
 * 재해 구역 채움 · 경계선. 안개 위에 얹는 붉은 층이라 지형이 비쳐야 하지만, 2026-09-09 의 값
 * (채움 0.16 · 선 2 px)은 컬러 지형 위에서 **모래 폭풍 · 눈보라가 있는지조차 안 보였다**.
 * 2026-09-10: 채움을 올리고 그 위에 **빗금**(`hazardHatch`)을 한 겹 더 깐다 — 지형은 여전히 비치는데
 * "이쪽은 위험" 은 한눈에 읽힌다. 경계선도 굵어지고 어두운 밑선을 깔아 밝은 지형 위에서도 버틴다.
 */
const HAZARD_FILL = 'rgba(255, 77, 77, 0.26)';
const HAZARD_LINE = 'rgba(255, 122, 70, 0.95)';
const HAZARD_LINE_UNDER = 'rgba(20, 6, 4, 0.75)';
/** 빗금 무늬의 타일 한 변(px)과 선 색. */
const HATCH_TILE = 9;
const HATCH_LINE = 'rgba(255, 90, 60, 0.34)';
/** 이 반경(m) 이하의 재해 원은 **닫힌 것**으로 그린다 (C-15) — `world/hazard/parts/Visuals` 가 벽을 숨기는 문턱과 같다. */
const CLOSED_RADIUS_M = 0.5;

/**
 * 안개 경계선 (2026-09-10) — 밝혀진 칸과 아직 아닌 칸이 맞닿는 변. 컬러 레이어의 가장자리는 업스케일
 * 스무딩으로 부드럽게 번져 "여기까지 봤다" 가 읽히지 않았다. 격자 변을 그대로 이어 **또렷한 선**을 긋는다:
 * 밝은 선 밑에 어두운 선을 깔아 어떤 지형색 위에서도 보인다.
 */
const FOG_EDGE_LINE = 'rgba(232, 230, 225, 0.72)';
const FOG_EDGE_UNDER = 'rgba(6, 8, 10, 0.85)';
/** Phase 7: icon / label colour of a suspended squad member (socket down, ghost body kept). */
const COL_SUSPENDED = '#8a8f99';
const PING_CSS: Record<PingKind, string> = {
  ground: COL.info, enemy: COL.danger, crate: COL.success, extraction: COL.accent, item: COL.pickup, attack: COL.attack, caution: COL.caution,
  /* appended (2026-09-09): 전투불능 좌/우 핑 + 구조물 · 선로 */
  help: COL.danger, abandon: '#8a929c', structure: '#d8c48a', rail: '#9fb4c7',
};

interface MapPing { id: number; kind: PingKind; position: THREE.Vector3; expires: number; owner?: { name: string; color: string } | null; label?: string; lost?: boolean }

/**
 * Tactical map (M). Static terrain layer (height shading + hillshade + contours) cached per
 * `world:ready`; dynamic layer (pads, nests, crates, pings, player, ship) redrawn every frame while open.
 * Wheel zooms around the cursor, left-drag pans, **middle-click drops a ping** (Phase 10, `setPingPlacer`).
 * Adds `ctx.uiBlockers` token 'map' and enters software-cursor mode with the same token — the pointer lock is kept
 * (Phase 10 §2), so there is no `exitPointerLock()` and no relock microtask.
 *
 * 2026-09-09: **Tab (`Keys.INVENTORY`) closes it too** (consumed, so the inventory does not open on the same press —
 * `InventorySystem` polls earlier in the frame but its own guard already refuses while the `'map'` blocker is up),
 * and while open it emits `ui:keyGuide {owner:'map'}` (핑 · 확대 · 이동; re-emitted on `input:bindingsChanged`, `null`
 * on close) for the bottom-right 키 가이드, which appends the `Tab 닫기` entry itself.
 */
export class MapScreen {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private canvas: HTMLCanvasElement;
  private c2d: CanvasRenderingContext2D;
  private seedEl: HTMLElement;
  private zoomEl: HTMLElement;
  private staticCanvas: HTMLCanvasElement | null = null;
  /**
   * 2026-09-09 — 전장의 안개. `staticCanvas` 는 **밝혀진 곳에만** 보이는 컬러 지형이고, `outlineCanvas` 는
   * 미탐색 구역에 깔리는 회색 윤곽(등고선 + 약한 음영, 색도 디테일도 없다)이다. `fogLayer` 는 컬러 레이어를
   * 안개 마스크로 자른 결과 캔버스로, **`fog:revealed` 가 왔을 때만** 다시 만든다 — 매 프레임 마스크를
   * 훑지 않는다. 안개가 없는 세계(훈련장)에서는 셋 다 예전처럼 컬러 한 장으로 동작한다.
   */
  private outlineCanvas: HTMLCanvasElement | null = null;
  private fogLayer: HTMLCanvasElement | null = null;
  private fogDirty = true;
  private fogRevision = -1;
  /**
   * 안개 경계선의 선분들 (2026-09-10). 월드 좌표 m 로 `[x0, z0, x1, z1, …]`. `fog.revision` 이 바뀔 때만
   * 다시 만들고 (마스크 격자 하나를 훑는다), 매 프레임에는 이 배열을 그대로 긋기만 한다.
   */
  private fogEdges: Float32Array | null = null;
  private fogEdgeRevision = -1;
  /** 재해 위험 구역에 까는 빗금 무늬. 캔버스 컨텍스트가 생긴 뒤 한 번만 만든다. */
  private hazardHatch: CanvasPattern | null = null;
  private exploredEl: HTMLElement;
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
  /**
   * 2026-09-11 (C-11): 발견한 **폐허 전초** (id → 위치). `WorldRef` 에 목록이 없으므로(구조물 목록과 섞지 않는다)
   * `fog:discovered {kind:'outpost'}` 를 쌓는다. 늦게 합류한 사람은 `fog sync` 뒤 다음 발견 판정에서 다시 받는다.
   * `world:ready` · `game:abort` 에서 비운다.
   */
  private outposts = new Map<string, THREE.Vector3>();
  /** When set (HudSystem → Pings.getPings) pings are drawn from here (carries owner name/colour); else from events. */
  private pingSource: (() => readonly PingView[]) | null = null;
  /** Phase 10: middle-click on the map → this placer (HudSystem → `Pings.placeAtWorld`). */
  private pingPlacer: ((position: THREE.Vector3, kind: PingKind) => void) | null = null;
  private pingVec = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  /*
   * 2026-09-08: Escape does not close the map any more — it is the 일시정지 메뉴 everywhere, and the map closes on
   * `Keys.MAP`, the key that opened it (polled in `update`). Nothing is captured here at all now.
   */
  private onWheel = (e: WheelEvent): void => {
    if (!this._open) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    this.zoomAround(this.zoom * factor, mx, my);
  };
  private onMouseDown = (e: MouseEvent): void => {
    if (!this._open) return;
    // Phase 10: middle-click drops a ping at that map point instead of starting a pan.
    if (e.button === 1) { e.preventDefault(); this.pingAt(e.clientX, e.clientY); return; }
    if (e.button !== 0) return;
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
      /* appended (2026-09-09): 레이드 플레이 개선 */
      ['structure', COL.structure, '버려진 구조물'],
      ['outpost', COL.outpost, '폐허 전초'],
      ['rail', COL.rail, '선로 · 플랫폼'],
      ['tram', COL.tram, '전차'],
      ['grove', COL.grove, '거대 버섯 군락'],
      ['hazard', COL.danger, '위험 구역'],
    ];
    for (const [cls, color, label] of entries) {
      const row = el('div', { cls: 'map-legend-row', parent: legend });
      const sw = el('i', { cls: `sw ${cls}`, parent: row });
      sw.style.setProperty('--sw', color);
      // 2026-09-11 (C-11): 폐허 전초 견본 — 스타일시트(`ui/styles/base.css`)는 이 파일의 소관이 아니라 인라인으로 준다
      // (지도의 ㄷ자와 같은 모양: 오른쪽 한 변이 뚫린 사각).
      if (cls === 'outpost') Object.assign(sw.style, { width: '9px', height: '9px', border: '1.6px solid var(--sw)', borderRightColor: 'transparent' });
      el('span', { text: label, parent: row });
    }

    const foot = el('div', { cls: 'map-foot', parent: side });
    const exploredRow = el('div', { cls: 'map-zoom-row', parent: foot });
    el('span', { cls: 'ui-label', text: '탐색률', parent: exploredRow });
    this.exploredEl = el('span', { cls: 'ui-mono', text: '—', parent: exploredRow });
    const zoomRow = el('div', { cls: 'map-zoom-row', parent: foot });
    el('span', { cls: 'ui-label', text: '확대', parent: zoomRow });
    this.zoomEl = el('span', { cls: 'ui-mono', text: '1.0×', parent: zoomRow });
    const reset = el('button', { cls: 'ui-btn small', text: '초기화', parent: foot });
    reset.addEventListener('click', (e) => { e.stopPropagation(); this.resetView(); this.ctx?.bus.emit('audio:play', { id: 'ui_click' }); });
    el('div', { cls: 'map-hint', html: '<span class="keycap">M</span> / <span class="keycap">Esc</span> 닫기 · 휠 확대 · 드래그 이동 · 휠클릭 핑', parent: foot });

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

  /**
   * Where a middle-click on the map goes (Phase 10). `HudSystem` wires this to `Pings.placeAtWorld`, which snaps the
   * point onto a crate / pad / dropped item and shares it with the squad exactly like an in-world ping.
   */
  setPingPlacer(placer: ((position: THREE.Vector3, kind: PingKind) => void) | null): void { this.pingPlacer = placer; }

  /** Client px → world point on the map, handed to the ping placer. Silently ignores clicks outside the canvas. */
  private pingAt(clientX: number, clientY: number): void {
    if (!this.pingPlacer) return;
    const world = this.ctx?.world;
    if (!world?.ready) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    if (mx < 0 || my < 0 || mx > this.side || my > this.side) return;
    const x = this.fromX(mx), z = this.fromZ(my);
    this.pingPlacer(this.pingVec.set(x, world.getHeightAt(x, z), z), 'ground');
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('world:ready', ({ seed }) => {
        this.activePadId = null; this.shipPos = null; this.pings.clear(); this.outposts.clear();
        this.staticCanvas = null; this.outlineCanvas = null; this.staticSeed = seed;
        this.fogLayer = null; this.fogDirty = true; this.fogRevision = -1; this.fogEdges = null; this.fogEdgeRevision = -1;
        setText(this.seedEl, `SEED ${seed}`);
        setText(this.exploredEl, '—');
        this.resetView();
      }),
      // 2026-09-09: the fog layer is rebuilt ONLY here — never per frame from `FogRef.mask`.
      b.on('fog:revealed', ({ explored }) => {
        this.fogDirty = true;
        setText(this.exploredEl, `${Math.round(explored * 100)}%`);
      }),
      b.on('fog:discovered', ({ kind, id, position }) => {
        if (kind === 'outpost') this.outposts.set(id, position.clone());
      }),
      b.on('extraction:activated', ({ pointId }) => { this.activePadId = pointId; }),
      b.on('extraction:shipLanded', ({ position }) => { this.shipPos = position.clone(); }),
      b.on('extraction:liftoff', () => { this.shipPos = null; }),
      b.on('ping:placed', ({ id, position, kind, expires }) => { this.pings.set(id, { id, kind, position, expires }); }),
      b.on('ping:removed', ({ id }) => { this.pings.delete(id); }),
      b.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase()) this.close(false); }),
      b.on('player:died', () => this.close(false)),
      b.on('game:abort', () => {
        this.close(false);
        this.staticCanvas = null; this.outlineCanvas = null; this.fogLayer = null; this.fogEdges = null; this.fogEdgeRevision = -1;
        this.fogDirty = true; this.fogRevision = -1;
        this.pings.clear(); this.shipPos = null; this.activePadId = null; this.outposts.clear();
      }),
      b.on('input:bindingsChanged', () => { if (this._open) this.emitGuide(); }),
    );
    window.addEventListener('resize', this.onResize);
  }

  /** Poll the M key (and Tab while open); call every frame. */
  update(ctx: GameContext): void {
    if (ctx.input.wasPressed(Keys.MAP) && ctx.isGameplayPhase() && !(ctx.player?.isDead ?? false)
      && !ctx.uiBlockers.has(MENU_BLOCKER) && (this._open || ctx.uiBlockers.size === 0)) {
      if (this._open) this.close(); else this.open();
    } else if (this._open && ctx.input.wasPressed(Keys.INVENTORY) && !ctx.uiBlockers.has(MENU_BLOCKER)) {
      // 2026-09-09: Tab closes every screen; swallow it so nothing later in the frame opens the inventory on it.
      ctx.input.consume(Keys.INVENTORY);
      this.close();
    }
    if (this._open) this.draw(ctx);
  }

  /** 키 가이드 entries for the map (the guide appends `Tab 닫기` itself). */
  private emitGuide(): void {
    this.ctx.bus.emit('ui:keyGuide', {
      owner: 'map',
      keys: [
        { key: keyLabel(Keys.PING), label: '핑' },
        { key: '휠', label: '확대' },
        { key: `${keyLabel(Keys.FIRE)} 드래그`, label: '이동' },
      ],
    });
  }

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    if (!ctx.world?.ready) return;
    this._open = true;
    // Phase 10 (§2): the pointer lock is KEPT and the software cursor drives the UI — no `exitPointerLock()` here, so
    // the OS cursor never wanders onto another monitor. `setCursorMode` is ref-counted by the blocker token.
    ctx.uiBlockers.add(BLOCKER);
    ctx.escape.push(BLOCKER, () => this.close());
    ctx.input.setCursorMode(true, BLOCKER);
    this.root.hidden = false;
    this.fit();
    if (!this.staticCanvas || this.staticSeed !== ctx.world.seed) this.buildStatic(ctx);
    this.fogDirty = true;
    const fog = ctx.world.fog;
    setText(this.exploredEl, fog ? `${Math.round(fog.explored * 100)}%` : '—');
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    this.emitGuide();
    ctx.bus.emit('ui:mapToggled', { open: true });
  }

  /**
   * `relock` is kept for the existing call sites but is a no-op since Phase 10 — the lock was never released, so
   * there is nothing to re-request and no relock microtask.
   */
  close(relock = true): void {
    void relock;
    if (!this._open) return;
    const ctx = this.ctx;
    this._open = false;
    this.dragging = false;
    this.canvas.classList.remove('grabbing');
    this.root.hidden = true;
    ctx.uiBlockers.delete(BLOCKER);
    ctx.escape.remove(BLOCKER);
    ctx.input.setCursorMode(false, BLOCKER);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    ctx.bus.emit('ui:keyGuide', { owner: 'map', keys: null });
    ctx.bus.emit('ui:mapToggled', { open: false });
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
  /** Inverse of `toX` / `toY`: canvas-local px → world metres (Phase 10, for the middle-click ping). */
  private fromX(px: number): number { return (px - this.ox) / this.scale() - this.size / 2; }
  private fromZ(py: number): number { return (py - this.oy) / this.scale() - this.size / 2; }

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
    // 2026-09-09: the same pass also paints the **grey outline** used where the fog has not lifted — no colour,
    // no height ramp, just a near-flat grey with the contour lines and a touch of the same hillshade, so an
    // unexplored map still reads as "a map of this size with ridges here" and nothing more.
    const outImg = new ImageData(n, n);
    const od = outImg.data;
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
        const contour = lv !== Math.floor(hr / CONTOUR_STEP) || lv !== Math.floor(hd / CONTOUR_STEP);
        if (contour) {
          r *= 0.72; g *= 0.72; b *= 0.72;
          r += 12; g += 12; b += 10;
        }
        d[k * 4] = r; d[k * 4 + 1] = g; d[k * 4 + 2] = b; d[k * 4 + 3] = 255;
        // outline: 14 grey + a hint of relief, contour lines a little brighter
        const grey = 14 + 10 * dot + (contour ? 16 : 0);
        od[k * 4] = grey; od[k * 4 + 1] = grey + 1; od[k * 4 + 2] = grey + 2; od[k * 4 + 3] = 255;
      }
    }
    this.staticCanvas = this.upscale(img, n, true);
    this.outlineCanvas = this.upscale(outImg, n, false);
    this.fogLayer = null; this.fogEdges = null; this.fogEdgeRevision = -1;
    this.fogDirty = true;
  }

  /** `n × n` ImageData → an `STATIC_PX` canvas (smoothed), with the scanline texture + frame on the colour layer. */
  private upscale(img: ImageData, n: number, decorate: boolean): HTMLCanvasElement {
    const small = document.createElement('canvas');
    small.width = n; small.height = n;
    small.getContext('2d')!.putImageData(img, 0, 0);
    const big = document.createElement('canvas');
    big.width = STATIC_PX; big.height = STATIC_PX;
    const c = big.getContext('2d')!;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(small, 0, 0, STATIC_PX, STATIC_PX);
    if (decorate) {
      // faint scanlines for texture
      c.fillStyle = 'rgba(0,0,0,0.08)';
      for (let y = 0; y < STATIC_PX; y += 4) c.fillRect(0, y, STATIC_PX, 1);
    }
    // map edge
    c.strokeStyle = decorate ? 'rgba(232,230,225,0.35)' : 'rgba(232,230,225,0.18)';
    c.lineWidth = 2;
    c.strokeRect(1, 1, STATIC_PX - 2, STATIC_PX - 2);
    return big;
  }

  /**
   * The colour layer cut to the fog mask. Built only when `fog:revealed` marked it dirty (or on open) — the mask is
   * `cells × cells` (80² at `FOG_CELL_M` 8), pushed in as `ImageData` alpha and upscaled with smoothing so the
   * revealed area has a soft edge instead of 8 m stair steps.
   */
  private buildFogLayer(fog: FogRef | null): void {
    this.fogDirty = false;
    this.buildFogEdges(fog);
    if (!fog || !this.staticCanvas) { this.fogLayer = null; return; }
    this.fogRevision = fog.revision;
    const n = fog.cells;
    const img = new ImageData(n, n);
    const d = img.data;
    for (let i = 0; i < n * n; i++) {
      const o = i * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
      d[o + 3] = fog.mask[i] !== 0 ? 255 : 0;
    }
    const small = document.createElement('canvas');
    small.width = n; small.height = n;
    small.getContext('2d')!.putImageData(img, 0, 0);
    let big = this.fogLayer;
    if (!big) {
      big = document.createElement('canvas');
      big.width = STATIC_PX; big.height = STATIC_PX;
      this.fogLayer = big;
    }
    const c = big.getContext('2d')!;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, STATIC_PX, STATIC_PX);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(small, 0, 0, STATIC_PX, STATIC_PX);
    c.globalCompositeOperation = 'source-in';     // keep the colour only where the mask is opaque
    c.drawImage(this.staticCanvas, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }

  /**
   * 안개 **경계선**의 선분 목록을 다시 만든다 (2026-09-10). 밝혀진 칸이 밝혀지지 않은 이웃과 맞닿는
   * 변마다 선분 하나다. 맵 밖 이웃은 세지 않는다 — 지도 테두리가 이미 그 자리를 긋고 있다.
   * `cells²`(80² = 6400) 를 한 번 훑을 뿐이고, `fog.revision` 이 바뀔 때만 돈다.
   */
  private buildFogEdges(fog: FogRef | null): void {
    if (!fog) { this.fogEdges = null; this.fogEdgeRevision = -1; return; }
    this.fogEdgeRevision = fog.revision;
    const n = fog.cells;
    const cs = fog.cellSize;
    const half = (n * cs) / 2;
    const m = fog.mask;
    const out: number[] = [];
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        if (m[cz * n + cx] === 0) continue;
        const x0 = -half + cx * cs, z0 = -half + cz * cs;
        const x1 = x0 + cs, z1 = z0 + cs;
        if (cx + 1 < n && m[cz * n + cx + 1] === 0) out.push(x1, z0, x1, z1);
        if (cx > 0 && m[cz * n + cx - 1] === 0) out.push(x0, z0, x0, z1);
        if (cz + 1 < n && m[(cz + 1) * n + cx] === 0) out.push(x0, z1, x1, z1);
        if (cz > 0 && m[(cz - 1) * n + cx] === 0) out.push(x0, z0, x1, z0);
      }
    }
    this.fogEdges = out.length ? Float32Array.from(out) : null;
  }

  /** 안개 경계선을 긋는다 (어두운 밑선 + 밝은 선). 컬러 레이어 바로 위, 격자 밑이다. */
  private drawFogEdges(): void {
    const e = this.fogEdges;
    if (!e || e.length === 0) return;
    const c = this.c2d;
    const path = new Path2D();
    for (let i = 0; i < e.length; i += 4) {
      path.moveTo(this.toX(e[i]), this.toY(e[i + 1]));
      path.lineTo(this.toX(e[i + 2]), this.toY(e[i + 3]));
    }
    c.save();
    c.lineCap = 'square';
    c.strokeStyle = FOG_EDGE_UNDER; c.lineWidth = 3;
    c.stroke(path);
    c.strokeStyle = FOG_EDGE_LINE; c.lineWidth = 1.4;
    c.stroke(path);
    c.restore();
  }

  /** 빗금 무늬 타일 (한 번만 만든다). 컨텍스트가 없으면 null 이고 그때는 채움만 쓴다. */
  private hatch(): CanvasPattern | null {
    if (this.hazardHatch) return this.hazardHatch;
    const t = document.createElement('canvas');
    t.width = HATCH_TILE; t.height = HATCH_TILE;
    const tc = t.getContext('2d');
    if (!tc) return null;
    tc.strokeStyle = HATCH_LINE;
    tc.lineWidth = 2;
    tc.beginPath();
    tc.moveTo(-HATCH_TILE, HATCH_TILE); tc.lineTo(HATCH_TILE, -HATCH_TILE);
    tc.moveTo(0, HATCH_TILE * 2); tc.lineTo(HATCH_TILE * 2, 0);
    tc.stroke();
    this.hazardHatch = this.c2d.createPattern(t, 'repeat');
    return this.hazardHatch;
  }

  /** 안개 게이트: 아직 밝혀지지 않은 자리의 오브젝트는 지도에 그리지 않는다. 안개가 없으면 전부 보인다. */
  private discovered(pos: THREE.Vector3): boolean {
    const fog = this.ctx?.world?.fog;
    return !fog || fog.isDiscovered(pos);
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
    // 2026-09-09: 미탐색은 회색 윤곽, 밝혀진 곳만 컬러. 안개가 없는 세계(훈련장)는 예전처럼 컬러 한 장.
    const fog = ctx.world?.fog ?? null;
    if (fog) {
      if (this.fogDirty || this.fogRevision !== fog.revision) this.buildFogLayer(fog);
      else if (this.fogEdgeRevision !== fog.revision) this.buildFogEdges(fog);
      if (this.outlineCanvas) c.drawImage(this.outlineCanvas, this.ox, this.oy, extent, extent);
      if (this.fogLayer) c.drawImage(this.fogLayer, this.ox, this.oy, extent, extent);
      // 2026-09-09 의 컬러 레이어는 가장자리가 스무딩으로 번져 "여기까지 봤다" 가 안 읽혔다 (2026-09-10)
      this.drawFogEdges();
    } else if (this.staticCanvas) {
      c.drawImage(this.staticCanvas, this.ox, this.oy, extent, extent);
    }

    this.drawGrid(c);

    /*
     * 2026-09-09 — 환경 재해는 **안개 레이어 위**에 그린다. 함선이 궤도에서 관측해 알려 주는 현상이라
     * 걸어서 밝힌 구역과 상관이 없다 (사용자 명시 요구). 그래서 `discovered()` 게이트도 걸지 않는다.
     */
    this.drawHazard(ctx);

    const world = ctx.world;
    const t = ctx.time;
    if (world?.ready) {
      // 선로 · 플랫폼 · 전차 (2026-09-09): 지형지물이므로 발견한 것만. 전차는 매 프레임 움직인다.
      this.drawRails(ctx);
      // 버려진 구조물 (2026-09-09)
      for (const st of world.getStructures()) {
        if (!this.discovered(st.position)) continue;
        const x = this.toX(st.position.x), y = this.toY(st.position.z);
        const rr = Math.max(5, st.radius * s);
        if (!this.inView(x, y, rr + 12)) continue;
        c.strokeStyle = COL.structure; c.lineWidth = 1.3;
        c.fillStyle = 'rgba(216,196,138,0.12)';
        c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = COL.structure;
        c.fillRect(x - 3.5, y - 3.5, 7, 7);
        // 잠긴 문(전진기지 지하실 · 연구소 2층 잠긴 방)이 아직 잠겨 있으면 호박색 자물쇠 점을 하나 더 찍는다
        // (2026-09-12: 열쇠는 이제 그 건물 안에 있다는 보장이 없다 — 「열쇠 · 키카드를 챙겨 올 곳」이라는 표시다)
        if ((st.hasBasement || st.hasLockedRoom) && !st.unlocked) {
          c.fillStyle = COL.accent;
          c.beginPath(); c.arc(x + 6, y - 6, 2, 0, Math.PI * 2); c.fill();
        }
        c.fillStyle = COL.dim;
        c.font = FONT_LABEL;
        c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillText('구조물', x, y + rr + 2);
      }
      /* 폐허 전초 (2026-09-11, C-11) — 발견 이벤트로 쌓인 것만. 무너진 벽을 닮은 **ㄷ자** (한 변이 뚫린 사각)이고
       * 구조물의 채운 사각형과 겹치지 않게 테두리만 긋는다. */
      for (const [, pos] of this.outposts) {
        const x = this.toX(pos.x), y = this.toY(pos.z);
        if (!this.inView(x, y, 16)) continue;
        c.strokeStyle = COL.outpost; c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(x + 4.5, y - 4.5); c.lineTo(x - 4.5, y - 4.5); c.lineTo(x - 4.5, y + 4.5); c.lineTo(x + 1.5, y + 4.5);
        c.stroke();
        c.fillStyle = COL.outpost;
        c.fillRect(x + 3, y - 1, 1.6, 1.6);                 // 안테나 비콘 점
        c.fillStyle = COL.dim;
        c.font = FONT_LABEL;
        c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillText('폐허', x, y + 7);
      }
      // 거대 버섯 군락 (독성 포자 발생지) — 발견한 것만
      for (const src of ctx.world?.hazard?.getSources() ?? []) {
        if (!src.discovered) continue;
        const x = this.toX(src.position.x), y = this.toY(src.position.z);
        if (!this.inView(x, y, 10)) continue;
        c.strokeStyle = COL.grove; c.lineWidth = 1.3;
        c.beginPath(); c.arc(x, y - 1.5, 4, Math.PI, 0); c.stroke();
        c.beginPath(); c.moveTo(x, y - 1.5); c.lineTo(x, y + 3.5); c.stroke();
      }
      // nests
      for (const p of world.getNestPositions()) {
        if (!this.discovered(p)) continue;
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
        if (!this.discovered(cr.position)) continue;
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
      // gather nodes: 약초는 작은 십자, 고철 더미(2026-09-08)는 호박색 사각 — 둘 다 채집되면 흐려진다
      const nodes = world.getGatherNodes?.();
      if (nodes) {
        for (const g of nodes) {
          if (!this.discovered(g.position)) continue;
          const x = this.toX(g.position.x), y = this.toY(g.position.z);
          if (!this.inView(x, y, 5)) continue;
          if (g.kind === 'salvage') {
            c.strokeStyle = g.harvested ? 'rgba(255,179,71,0.25)' : 'rgba(255,179,71,0.9)';
            c.lineWidth = 1.2;
            c.strokeRect(x - 2.5, y - 2.5, 5, 5);
            continue;
          }
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
        // an active pad is squad-wide knowledge (the countdown is running) — never hidden by the fog
        if (e.id !== this.activePadId && !this.discovered(e.position)) continue;
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
        /* 2026-09-09: 전투불능 좌/우 핑 — 오프스크린 화살표의 ✚ / ✖ 과 같은 모양으로 맞춘다. */
        case 'help':
          c.strokeStyle = col; c.lineWidth = 2;
          c.beginPath(); c.moveTo(x - 5, y); c.lineTo(x + 5, y); c.moveTo(x, y - 5); c.lineTo(x, y + 5); c.stroke();
          break;
        case 'abandon':
          c.strokeStyle = col; c.lineWidth = 1.8;
          c.beginPath(); c.moveTo(x - 4, y - 4); c.lineTo(x + 4, y + 4); c.moveTo(x + 4, y - 4); c.lineTo(x - 4, y + 4); c.stroke();
          break;
        case 'structure': c.strokeStyle = col; c.lineWidth = 1.5; c.strokeRect(x - 4, y - 4, 8, 8); break;
        case 'rail': c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.moveTo(x - 5, y); c.lineTo(x + 5, y); c.stroke(); break;
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
        // Phase 7: a suspended member's ghost body stays on the map in grey (its ref is stale by definition).
        const suspended = r.suspended === true;
        if (!suspended && (!r.connected || (r.flags & PlayerFlags.DROPPING))) continue;
        const x = this.toX(r.position.x), y = this.toY(r.position.z);
        if (!this.inView(x, y, 30)) continue;
        const col = suspended ? COL_SUSPENDED : (NET_SLOT_COLORS_CSS[r.slot] ?? '#fff');
        c.globalAlpha = suspended ? 0.6 : r.stale ? 0.45 : 1;
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
        c.fillText(suspended ? `${r.name} · ${SUSPENDED_LABEL_KO}` : r.isDead ? `${r.name} · 전사` : r.name, x, y + 9);
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

  /* ── 2026-09-09: 환경 재해 · 선로 ───────────────────────────────────────── */

  /**
   * `HazardRef.getZones()` 의 도형을 안개 위에 얹는다. `world/` 가 재해를 아직 만들지 않으면 `hazard` 가 null
   * 이라 통째로 건너뛴다.
   *
   *   - `front` = **반평면**. 전선은 `center` 를 지나고 법선이 `(dirX, dirZ)` — 진행 방향이다. 그래서 **법선의
   *     반대편**(이미 지나온 쪽)이 위험이고, 그쪽을 붉게 채운 뒤 전선 자체를 굵게 긋는다.
   *   - `circle` = 원. `safeInside` 면 원 **바깥**이 위험이라 캔버스 전체에서 원을 도려내 채우고(even-odd),
   *     아니면 원 **안**을 채운다.
   *
   * 도형이 하나도 없어도 재해가 진행 중이면 이름표를 좌상단에 하나 남긴다 — 지도를 연 사람이 "지금 뭐가
   * 오고 있나" 를 여기서 읽는다.
   */
  private drawHazard(ctx: GameContext): void {
    const hz: HazardRef | null = ctx.world?.hazard ?? null;
    if (!hz || !hz.active) return;
    const c = this.c2d;
    const C = this.side;
    const s = this.scale();
    const L = this.size * 2;   // 반평면을 캔버스 밖까지 확실히 덮는 길이(m)

    // 2026-09-10: 채움 한 겹 + **빗금** 한 겹. 같은 길을 두 번 채우므로 `fill` 뒤에도 경로를 그대로 쓴다.
    const hatch = this.hatch();
    const paint = (rule?: CanvasFillRule): void => {
      c.fillStyle = HAZARD_FILL;
      if (rule) c.fill(rule); else c.fill();
      if (hatch) { c.fillStyle = hatch; if (rule) c.fill(rule); else c.fill(); }
    };
    /** 경계선: 어두운 밑선 위에 밝은 선 — 밝은 지형 위에서도 살아남는다. */
    const edge = (draw: () => void): void => {
      c.strokeStyle = HAZARD_LINE_UNDER; c.lineWidth = 4.5; c.beginPath(); draw(); c.stroke();
      c.strokeStyle = HAZARD_LINE; c.lineWidth = 2.2; c.beginPath(); draw(); c.stroke();
    };

    c.save();
    c.beginPath(); c.rect(0, 0, C, C); c.clip();
    for (const z of hz.getZones()) {
      if (z.shape === 'front') {
        const px = -z.dirZ, pz = z.dirX;                       // 전선 방향 (법선에 수직)
        const pts: Array<[number, number]> = [
          [z.center.x + px * L, z.center.z + pz * L],
          [z.center.x - px * L, z.center.z - pz * L],
          [z.center.x - px * L - z.dirX * L, z.center.z - pz * L - z.dirZ * L],
          [z.center.x + px * L - z.dirX * L, z.center.z + pz * L - z.dirZ * L],
        ];
        c.beginPath();
        pts.forEach(([wx, wz], i) => { const X = this.toX(wx), Y = this.toY(wz); if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
        c.closePath();
        paint();
        edge(() => {
          c.moveTo(this.toX(pts[0][0]), this.toY(pts[0][1]));
          c.lineTo(this.toX(pts[1][0]), this.toY(pts[1][1]));
        });
        continue;
      }
      const cx = this.toX(z.center.x), cy = this.toY(z.center.z);
      /* 2026-09-11 (C-15): 폭풍의 눈이 반경 0 까지 닫힌다. `Math.max(1, …)` 만 두면 다 닫힌 뒤에도 **1 px 짜리
       * 안전 구멍과 테두리**가 남아 "아직 안전지대가 있다" 로 읽혔다. 월드의 벽 비주얼(`hazard/parts/Visuals`)과
       * 같은 문턱 `CLOSED_RADIUS_M` 아래는 닫힌 원이다: 안이 안전한 원이면 캔버스 전체가 위험, 안이 위험한 원이면
       * 아무것도 없다. */
      if (z.radius <= CLOSED_RADIUS_M) {
        if (z.safeInside) { c.beginPath(); c.rect(0, 0, C, C); paint(); }
        continue;
      }
      const rr = Math.max(1, z.radius * s);
      c.beginPath();
      if (z.safeInside) {
        // 원 밖이 위험: 캔버스 사각형에서 원을 도려낸다 (even-odd).
        // `rect` 뒤에는 현재 점이 사각형 시작점이라, `moveTo` 없이 `arc` 를 부르면 그 점에서 선이 하나 그어진다.
        c.rect(0, 0, C, C);
        c.moveTo(cx + rr, cy);
        c.arc(cx, cy, rr, 0, Math.PI * 2);
        paint('evenodd');
      } else {
        c.arc(cx, cy, rr, 0, Math.PI * 2);
        paint();
      }
      edge(() => c.arc(cx, cy, rr, 0, Math.PI * 2));
    }
    c.restore();

    if (hz.kind) {
      c.fillStyle = COL.danger;
      c.font = FONT_LABEL;
      c.textAlign = 'left'; c.textBaseline = 'top';
      c.fillText(`${HAZARD_LABEL_KO[hz.kind]} · 안전지대 ${Math.max(0, Math.round((1 - hz.progress) * 100))}%`, 8, C - 16);
    }
  }

  /** 선로 중심선 + 플랫폼 + 전차. 발견한 것만 (전차는 자기 현재 위치로 판정하므로 지도에서 움직인다). */
  private drawRails(ctx: GameContext): void {
    const world = ctx.world;
    if (!world) return;
    const c = this.c2d;
    for (const line of world.getRailLines()) {
      const pts = line.points;
      if (pts.length < 2) continue;
      if (!pts.some((p) => this.discovered(p))) continue;
      c.strokeStyle = COL.rail; c.lineWidth = 1.4;
      c.setLineDash([5, 3]);
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const X = this.toX(pts[i].x), Y = this.toY(pts[i].z);
        if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
      }
      if (line.kind === 'loop') c.closePath();
      c.stroke();
      c.setLineDash([]);
      for (const p of line.platforms) {
        if (!this.discovered(p.position)) continue;
        const X = this.toX(p.position.x), Y = this.toY(p.position.z);
        if (!this.inView(X, Y, 8)) continue;
        c.strokeStyle = COL.rail; c.lineWidth = 1.4;
        c.strokeRect(X - 4, Y - 2.5, 8, 5);
      }
    }
    for (const tram of world.getTrams()) {
      if (!this.discovered(tram.position)) continue;
      const X = this.toX(tram.position.x), Y = this.toY(tram.position.z);
      if (!this.inView(X, Y, 10)) continue;
      c.save();
      c.translate(X, Y); c.rotate(-tram.yaw);
      c.fillStyle = tram.state === 'moving' ? COL.tram : 'rgba(255,210,127,0.5)';
      c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1;
      c.beginPath(); c.rect(-6, -3, 12, 6); c.fill(); c.stroke();
      c.restore();
    }
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
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    if (this._open) {
      this._open = false;
      this.ctx?.uiBlockers.delete(BLOCKER);
      this.ctx?.escape.remove(BLOCKER);
      this.ctx?.input.setCursorMode(false, BLOCKER);
    }
    this.staticCanvas = null;
    this.outlineCanvas = null;
    this.fogLayer = null; this.fogEdges = null; this.fogEdgeRevision = -1; this.hazardHatch = null;
    this.root.remove();
  }
}
