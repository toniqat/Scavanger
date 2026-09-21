import * as THREE from 'three';
import type { FogRef, GameContext, HazardRef, KeyGuideEntry, PingKind, RoverRef, RoverStationDef, StructureKind } from '@/shared';
import {
  HAZARD_LABEL_KO, Keys, MENU_BLOCKER, NET_SLOT_COLORS_CSS, PlayerFlags, SUSPENDED_LABEL_KO, UI_HOLD_CONFIRM_S,
  createHoldButtonCap, keyLabel, mouseButtonOf,
} from '@/shared';
import { el, fmtInt, setText, toggleClass } from '../dom';
import type { PingView } from '../hud/Pings';
import { PING_LABEL } from '../hud/Pings';
import {
  MAP_COL, MARKER_SCALE, MapLabels, drawAllyArrow, drawAllyDown, drawDiamond, drawGatherCross, drawHazardSwatch, drawLabel,
  drawPad, drawPlatform, drawPlayerArrow, drawPlayerCone, drawRover, drawShip, drawSquadArrow, drawSquadDead, drawStation, drawTram,
  strokeRail, strokeRoute,
} from './mapIcons';
/* 2026-09-15 (android squadmates): the android marker · legend row */
import { allyBodies } from '../hud/allySource';
import '../styles/rover.css';
/* 2026-09-14 (messenger · NPC quests): the left column's quest panel list + hover tooltip */
import { MapQuestPanels } from './QuestPanels';

const BLOCKER = 'map';
const SAMPLES = 256;          // height samples per axis for the static layer
const STATIC_PX = 1024;       // resolution of the cached static canvas
const CONTOUR_STEP = 4;       // meters between contour lines
const GRID_STEP = 100;        // meters between grid lines
const MIN_ZOOM = 1, MAX_ZOOM = 4;
const NEST_RADIUS_M = 22;     // soft hazard radius drawn around nests
// Canvas fonts cannot reference CSS variables; mirror the stacks from base.css.
const FONT_GRID = "9px 'Cascadia Mono', Consolas, monospace";

/** 2026-09-13: colours · marker painters moved to `mapIcons` (the legend samples call the same functions). */
const COL = MAP_COL;

/**
 * The **short proper names** for map labels (2026-09-13 user's decision). Structures all used to read `구조물`, a
 * ruined outpost `폐허`. The toast (`hud/RaidAlerts`) still uses the formal names of `STRUCTURE_LABEL_KO` — only
 * the map label is short.
 */
const STRUCTURE_SHORT_KO: Readonly<Record<StructureKind, string>> = { outpost: '전진기지', lab: '연구소', wreck: '불시착 함선' };
/** Label overlap priority (the smaller one takes its place first). */
const PRIO = { ship: 0, pad: 1, station: 2, structure: 3, outpost: 4, platform: 5, nest: 6, grove: 7 } as const;
/** Landmark label colour — a little brighter than the marker (a dark outline is drawn around it). */
const LABEL_COL = 'rgba(232,230,225,0.85)';
/** Destination selection: the radius that picks a station (px) · the largest movement still counted as a click (px). */
const STATION_HIT_PX = 18;
const CLICK_SLOP_PX = 5;
/** Legend sample canvas size (CSS px) — big enough to hold the ×1.6 player arrow. */
const SW_W = 28, SW_H = 20;

type LegendId = 'player' | 'squad' | 'ally' | 'pad' | 'ship' | 'gather' | 'rail' | 'tram' | 'rover' | 'route' | 'hazard';
interface LegendRow { id: LegendId; row: HTMLElement; cv: HTMLCanvasElement }
/**
 * Hazard zone fill · border. It is a red layer laid over the fog, so the terrain has to show through, but the
 * 2026-09-09 values (fill 0.16 · line 2 px) made it **impossible to see even whether a sandstorm · blizzard was
 * there at all** over coloured terrain. 2026-09-10: the fill is raised and one more layer of **hatching**
 * (`hazardHatch`) goes on top — the terrain still shows through, but "this side is dangerous" reads at a glance.
 * The border is thicker too and sits on a dark underline, so it survives over bright terrain.
 */
const HAZARD_FILL = 'rgba(255, 77, 77, 0.26)';
const HAZARD_LINE = 'rgba(255, 122, 70, 0.95)';
const HAZARD_LINE_UNDER = 'rgba(20, 6, 4, 0.75)';
/** Side of one hatch pattern tile (px) and the line colour. */
const HATCH_TILE = 9;
const HATCH_LINE = 'rgba(255, 90, 60, 0.34)';
/** A hazard circle of this radius (m) or less is drawn as **closed** (C-15) — the threshold at which `world/hazard/parts/Visuals` hides the wall. */
const CLOSED_RADIUS_M = 0.5;

/**
 * The fog border (2026-09-10) — the edges where a revealed cell meets one that is not revealed yet. The colour
 * layer's edge blurred softly from upscale smoothing, so "we have seen this far" did not read. Joining the grid
 * edges as they are draws a **crisp line**: a dark line under the bright one keeps it visible over any terrain
 * colour.
 */
const FOG_EDGE_LINE = 'rgba(232, 230, 225, 0.72)';
const FOG_EDGE_UNDER = 'rgba(6, 8, 10, 0.85)';
/** Phase 7: icon / label colour of a suspended squad member (socket down, ghost body kept). */
const COL_SUSPENDED = '#8a8f99';
const PING_CSS: Record<PingKind, string> = {
  ground: COL.info, enemy: COL.danger, crate: COL.success, extraction: COL.accent, item: COL.pickup, attack: COL.attack, caution: COL.caution,
  /* appended (2026-09-09): the downed left / right pings + structure · rail */
  help: COL.danger, abandon: '#8a929c', structure: '#d8c48a', rail: '#9fb4c7',
};

interface MapPing { id: number; kind: PingKind; position: THREE.Vector3; expires: number; owner?: { name: string; color: string } | null; label?: string; lost?: boolean }

/**
 * Tactical map (M). Static terrain layer (height shading + hillshade + contours) cached per
 * `world:ready`; dynamic layer (pads, nests, crates, pings, player, ship) redrawn every frame while open.
 * Wheel zooms around the cursor, left-drag pans, **middle-click drops a ping** (Phase 10, `setPingPlacer`).
 * Adds `ctx.uiBlockers` token 'map' and enters cursor mode with the same token — that releases the pointer lock
 * (`Input.setCursorMode`); the relock on close is `main.ts`'s single relock point.
 *
 * 2026-09-09: **Tab (`Keys.INVENTORY`) closes it too** (consumed, so the inventory does not open on the same press —
 * `InventorySystem` polls earlier in the frame but its own guard already refuses while the `'map'` blocker is up),
 * and while open it emits `ui:keyGuide {owner:'map'}` (`핑` · `확대` · `이동`; re-emitted on
 * `input:bindingsChanged`, `null` on close) for the bottom-right key guide, which appends the `Tab 닫기` entry
 * itself.
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
   * 2026-09-09 — the fog of war. `staticCanvas` is the coloured terrain, visible **only where it is revealed**,
   * and `outlineCanvas` is the grey outline laid under unexplored ground (contours + faint shading, no colour and
   * no detail). `fogLayer` is the canvas that results from cutting the colour layer with the fog mask, and it is
   * rebuilt **only when `fog:revealed` arrives** — the mask is not walked every frame. In a world with no fog
   * (the training range) all three behave as one colour sheet, as before.
   */
  private outlineCanvas: HTMLCanvasElement | null = null;
  private fogLayer: HTMLCanvasElement | null = null;
  private fogDirty = true;
  private fogRevision = -1;
  /**
   * The segments of the fog border (2026-09-10), in world metres as `[x0, z0, x1, z1, …]`. Rebuilt only when
   * `fog.revision` changes (one walk of the mask grid); each frame the array is simply stroked as it is.
   */
  private fogEdges: Float32Array | null = null;
  private fogEdgeRevision = -1;
  /** The hatch pattern laid over a hazard danger zone. Built once, after the canvas context exists. */
  private hazardHatch: CanvasPattern | null = null;
  /** 2026-09-13: the toxic-spore circle union — this frame's circles `[cx, cy, r, …]` (px) and the arc-interval scratch. Reused. */
  private readonly sporeCircles: number[] = [];
  private readonly arcScratch: number[] = [];
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
   * 2026-09-11 (C-11): the discovered **ruined outposts** (id → position). `WorldRef` holds no list of them (they
   * are not mixed into the structure list), so `fog:discovered {kind:'outpost'}` is accumulated instead. A late
   * joiner gets them again on the next discovery check after `fog sync`. Cleared on `world:ready` · `game:abort`.
   */
  private outposts = new Map<string, THREE.Vector3>();
  /** When set (HudSystem → Pings.getPings) pings are drawn from here (carries owner name/colour); else from events. */
  private pingSource: (() => readonly PingView[]) | null = null;
  /** Phase 10: middle-click on the map → this placer (HudSystem → `Pings.placeAtWorld`). */
  private pingPlacer: ((position: THREE.Vector3, kind: PingKind) => void) | null = null;
  private pingVec = new THREE.Vector3();
  private unsubs: Array<() => void> = [];

  /* 2026-09-13: the label overlap layer · legend samples */
  private readonly labels = new MapLabels();
  private legendEl: HTMLElement;
  private legendRows: LegendRow[] = [];
  /* 2026-09-14: the left column = head → quest panels (`quests`) → legend (bottom left) → foot rows. The column
   * height is pinned by `fit` to the canvas height. */
  private readonly sideEl: HTMLElement;
  private readonly quests: MapQuestPanels;

  /* 2026-09-13: the rover destination selection mode */
  private roverMode = false;
  /** Destination selection mode **opened** the map — ending the mode closes it too (entering on an already open map leaves it). */
  private roverOpenedMap = false;
  private roverEnteredAt = 0;
  private selectedStation: string | null = null;
  private hoverStation: string | null = null;
  private tripError: string | null = null;
  private downX = 0;
  private downY = 0;
  private dragMoved = false;
  private roverPanel: HTMLElement;
  private rvHint: HTMLElement;
  private rvDest: HTMLElement;
  private rvDist: HTMLElement;
  private rvFare: HTMLElement;
  private rvCredits: HTMLElement;
  private rvReason: HTMLElement;
  private rvBtn: HTMLButtonElement;
  private rvBtnFill: HTMLElement;
  /** The left-click hold keycap left of the label (2026-09-15, 2nd pass) — hidden while blocked. */
  private rvBtnCap: HTMLElement;
  private rvBtnLbl: HTMLElement;
  private holdStart = 0;
  private holdRaf = 0;

  /*
   * 2026-09-13: Escape **does** close the map (the stale 2026-09-08 note said otherwise) — `open()` pushes it onto
   * `ctx.escape` like every screen (the 2026-09-09 rule: Escape closes exactly one screen, the topmost). M
   * (`Keys.MAP`) and Tab close it too (polled in `update`); the key guide shows all three.
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
    // Phase 10: the ping button (middle-click by default) drops a ping at that map point instead of starting a pan.
    // 2026-09-13: it follows `Keys.PING` (the key guide shows `keyLabel(Keys.PING)`) — unless it was rebound onto the
    // left button, which pans / picks here.
    const pingBtn = mouseButtonOf(Keys.PING, 1);
    if (pingBtn !== 0 && e.button === pingBtn) { e.preventDefault(); this.pingAt(e.clientX, e.clientY); return; }
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.lastMx = e.clientX; this.lastMy = e.clientY;
    this.downX = e.clientX; this.downY = e.clientY;
    this.dragMoved = false;
    this.canvas.classList.add('grabbing');
  };
  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastMx, dy = e.clientY - this.lastMy;
    this.lastMx = e.clientX; this.lastMy = e.clientY;
    if (!this.dragMoved && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > CLICK_SLOP_PX) this.dragMoved = true;
    this.ox += dx; this.oy += dy;
    this.clampView();
  };
  private onMouseUp = (e: MouseEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas.classList.remove('grabbing');
    // 2026-09-13: in destination selection mode a left click that did not drag = pick a station (a drag still only pans)
    if (this.roverMode && !this.dragMoved) this.pickStation(e.clientX, e.clientY);
  };
  /** Station hover in destination selection mode (cursor shape · highlight ring). */
  private onHover = (e: MouseEvent): void => {
    if (!this.roverMode) {
      if (this.hoverStation !== null) { this.hoverStation = null; this.canvas.classList.remove('pick'); }
      return;
    }
    this.hoverStation = this.stationAt(e.clientX, e.clientY)?.id ?? null;
    toggleClass(this.canvas, 'pick', this.hoverStation !== null);
  };
  private readonly onHoldUp = (): void => { this.stopHold(); };
  private onResize = (): void => { if (this._open) this.fit(); };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'map-screen interactive', parent });
    this.root.hidden = true;
    const frame = el('div', { cls: 'map-frame', parent: this.root });

    const side = el('div', { cls: 'map-side', parent: frame });
    const head = el('div', { cls: 'map-head', parent: side });
    el('div', { cls: 'map-title', text: '전술 지도', parent: head });
    this.seedEl = el('div', { cls: 'map-seed ui-mono', text: 'SEED —', parent: head });
    this.sideEl = side;

    /* 2026-09-14 (user's decision): the list of running NPC quest panels above the legend — it takes the spare
     * height and scrolls when it is long. The legend sits below it, at the bottom left
     * (`.map-legend { margin-top: auto }`). */
    this.quests = new MapQuestPanels(side, this.root);

    /* The legend (2026-09-13 rework, user's decision): landmarks whose label says their name (structures · ruined
     * outposts · mushroom groves · bug nests), pings · crates, and what was taken off the map (dropped items ·
     * deployables · mines) are not in the legend. Extraction points are one row (the map still draws the amber
     * pulse of the active point). A sample is not a CSS shape but a small canvas calling **the same painter the
     * map uses** (`mapIcons`). */
    this.legendEl = el('div', { cls: 'map-legend', parent: side });
    el('div', { cls: 'ui-label', text: '범례', parent: this.legendEl });
    const entries: Array<[LegendId, string]> = [
      ['player', '플레이어'],
      ['squad', '분대원'],
      /* 2026-09-15: android squadmates — the row appears only while at least one unit is on the roster (`refreshLegend`) */
      ['ally', '안드로이드'],
      ['pad', '탈출 지점'],
      ['ship', '탈출 함선'],
      ['gather', '채집물'],
      ['rail', '선로 · 플랫폼'],
      ['tram', '전차'],
      ['rover', '탐사 차량'],
      ['route', '차량 경로 · 정류장'],
      ['hazard', '위험 구역'],
    ];
    for (const [id, label] of entries) {
      const row = el('div', { cls: 'map-legend-row', parent: this.legendEl });
      row.dataset.legend = id;
      const cv = el('canvas', { cls: 'sw-cv', parent: row });
      el('span', { text: label, parent: row });
      this.legendRows.push({ id, row, cv });
    }

    /* 2026-09-13: the rover destination selection panel — it takes the legend's place while the mode runs */
    this.roverPanel = el('div', { cls: 'map-rover', parent: side });
    this.roverPanel.hidden = true;
    el('div', { cls: 'ui-label', text: '탐사 차량 · 목적지 선택', parent: this.roverPanel });
    this.rvHint = el('div', { cls: 'map-rover-hint', text: '지도에서 정류장을 선택하세요', parent: this.roverPanel });
    const rows = el('div', { cls: 'map-rover-rows', parent: this.roverPanel });
    const row = (label: string): HTMLElement => {
      const r = el('div', { cls: 'map-rover-row', parent: rows });
      el('span', { cls: 'k', text: label, parent: r });
      return el('span', { cls: 'v ui-mono', text: '—', parent: r });
    };
    this.rvDest = row('목적지');
    this.rvDist = row('거리');
    this.rvFare = row('요금 (분대 전원)');
    this.rvCredits = row('보유 크레딧');
    this.rvReason = el('div', { cls: 'map-rover-reason', parent: this.roverPanel });
    this.rvBtn = el('button', { cls: 'map-rover-go', parent: this.roverPanel });
    this.rvBtn.type = 'button';
    this.rvBtnFill = el('span', { cls: 'fill', parent: this.rvBtn });
    // 2026-09-15, 2nd pass (user's decision): 「hold for N seconds to depart」 is replaced by the left-click hold
    // keycap **inside** the button. The line below keeps only the **warning** that line really carried.
    this.rvBtnCap = createHoldButtonCap(this.rvBtn);
    this.rvBtnLbl = el('span', { cls: 'lbl', text: '목적지를 선택하세요', parent: this.rvBtn });
    el('div', { cls: 'map-rover-note', text: '출발하면 도착까지 내릴 수 없습니다.', parent: this.roverPanel });
    // An irreversible confirm = a 1 s hold (CLAUDE.md). A click · Enter · Space does nothing.
    this.rvBtn.addEventListener('pointerdown', (e) => this.startHold(e));
    this.rvBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); });

    // 2026-09-13 (user's decision): the bottom-left `초기화` button and the controls notice row were removed — the
    //             controls are said by the bottom-right key guide.
    const foot = el('div', { cls: 'map-foot', parent: side });
    const exploredRow = el('div', { cls: 'map-zoom-row', parent: foot });
    el('span', { cls: 'ui-label', text: '탐색률', parent: exploredRow });
    this.exploredEl = el('span', { cls: 'ui-mono', text: '—', parent: exploredRow });
    const zoomRow = el('div', { cls: 'map-zoom-row', parent: foot });
    el('span', { cls: 'ui-label', text: '확대', parent: zoomRow });
    this.zoomEl = el('span', { cls: 'ui-mono', text: '1.0×', parent: zoomRow });

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
    this.canvas.addEventListener('mousemove', this.onHover);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean { return this._open; }
  /** 2026-09-13 (debug · smoke): whether the rover destination selection mode is on · the picked station id. */
  get isRoverMode(): boolean { return this.roverMode; }
  get roverSelection(): string | null { return this.selectedStation; }
  /** Ids of the visible legend rows (debug · smoke). */
  get legendIds(): string[] { return this.legendRows.filter((r) => !r.row.hidden).map((r) => r.id); }
  /** 2026-09-14 (debug · smoke): quest ids drawn as quest panels · the quest whose tooltip is up. */
  get questIds(): string[] { return this.quests.questIds; }
  get questTip(): string | null { return this.quests.tipQuest; }
  /** Smoke hook: picks a station from code in destination selection mode (the same path as a click). false when the mode is off or the id is unknown. */
  selectStation(id: string): boolean {
    if (!this.roverMode) return false;
    const rv = this.ctx?.world?.rover;
    if (!rv?.route.stations.some((s) => s.id === id)) return false;
    this.selectedStation = id;
    this.tripError = null;
    return true;
  }

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
        if (this.roverMode) this.exitRoverMode(true);
        if (this._open) this.refreshLegend();
      }),
      // 2026-09-13: the rover — just boarded opens destination selection mode; departure · getting off · destruction closes it
      b.on('rover:destinationSelect', ({ open }) => {
        if (open) this.enterRoverMode();
        else if (this.roverMode) this.exitRoverMode(true);
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
      // 2026-09-13: when the flow of those left behind resets, the highlight on the departed pad is cleared (another console can call again)
      b.on('extraction:reset', () => { this.activePadId = null; this.shipPos = null; }),
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
      // 2026-09-14 (tutorial): a step change adds or drops the ship legend row (the map canvas checks for itself every frame)
      // 2026-09-18: the tutorial objective panel at the top of the left column is rebuilt on the spot too (the poll would be half a beat late)
      b.on('tutorial:changed', () => { if (this._open) { this.refreshLegend(); this.quests.refresh(true); } }),
      // 2026-09-14: the quest panels — at once when objective progress · state changes (the rest is `quests.tick`'s polling)
      b.on('npc:objectiveProgress', () => { if (this._open) this.quests.refresh(true); }),
      b.on('npc:questChanged', () => { if (this._open) this.quests.refresh(true); }),
    );
    this.quests.bind(ctx);
    window.addEventListener('resize', this.onResize);
  }

  /** Poll the M key (and Tab while open); call every frame. */
  update(ctx: GameContext): void {
    if (ctx.input.wasPressed(Keys.MAP) && ctx.isGameplayPhase() && !(ctx.player?.isDead ?? false)
      && !ctx.uiBlockers.has(MENU_BLOCKER) && (this._open || ctx.uiBlockers.size === 0)) {
      if (this._open) this.close();
      else {
        // 2026-09-13: while aboard a stopped rover, M opens destination selection mode
        const rv = ctx.world?.rover;
        if (rv?.localAboard && rv.vehicle.state === 'stopped') this.enterRoverMode(); else this.open();
      }
    } else if (this._open && ctx.input.wasPressed(Keys.INVENTORY) && !ctx.uiBlockers.has(MENU_BLOCKER)
      && ctx.escape.topKey === BLOCKER) {
      /*
       * 2026-09-09: Tab closes every screen; swallow it so nothing later in the frame opens the inventory on it.
       * 2026-09-15: **only the topmost one** — the same order as Escape (`shared/escape`). Tab polling has its
       * close order decided by the system registration order in `main.ts`, so when a screen opened later sits
       * above the map (a container · the inventory window) that one has to close first. Only `ctx.escape` knows
       * the open order, so all that is checked here is whether the top is this screen.
       */
      ctx.input.consume(Keys.INVENTORY);
      this.close();
    }
    if (this.roverMode) this.tickRoverMode(ctx);
    if (this._open) {
      this.quests.tick(ctx.time);
      this.draw(ctx);
    }
  }

  /**
   * Key guide entries for the map (the guide appends `Tab 또는 Esc 또는 M 닫기` itself — owner `'map'`).
   * 2026-09-13: the ping key names the button that actually places a ping on the map (`Keys.PING`), and panning
   * names the left click that actually drags (`Mouse0`) (it used to read `Keys.FIRE` and lied once the fire key
   * was rebound). In destination selection mode `좌클릭 목적지 선택` comes first.
   */
  private emitGuide(): void {
    const keys: KeyGuideEntry[] = [];
    if (this.roverMode) keys.push({ key: keyLabel('Mouse0'), label: '목적지 선택' });
    if (mouseButtonOf(Keys.PING, 1) !== 0) keys.push({ key: keyLabel(Keys.PING), label: '핑' });
    // 2026-09-15: only one key inside a keycap (`LMB` → the mouse glyph), 「드래그」 goes on the action side. `휠`
    //             (scrolling) is not a button that gets pressed, so it stays as text.
    keys.push({ key: '휠', label: '확대' }, { key: keyLabel('Mouse0'), label: '드래그 이동' });
    this.ctx.bus.emit('ui:keyGuide', { owner: 'map', keys });
  }

  open(): void {
    if (this._open) return;
    const ctx = this.ctx;
    if (!ctx.world?.ready) return;
    this._open = true;
    // Cursor mode releases the pointer lock and the real cursor drives the UI. `setCursorMode` is ref-counted by the
    // blocker token; no explicit `exitPointerLock()` is needed here.
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
    this.refreshLegend();
    this.quests.refresh(true);
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
    this.resetRoverMode();
    this.quests.hide();
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
    // 2026-09-14: left column 240 → 280 px (quest panels + a 2-column legend) — the horizontal margin grows with
    //             it (column 280 + gap 22 + padding 44 + border · slack)
    const side = Math.max(240, Math.floor(Math.min(vh * 0.85, vw - 380)));
    // Column height = the canvas border box height. Unpinned, the frame grows with the quest panels and runs off screen.
    this.sideEl.style.height = `${side + 2}px`;
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
   * Rebuilds the segment list of the fog **border** (2026-09-10). One segment per edge where a revealed cell
   * meets a neighbour that is not revealed. A neighbour outside the map does not count — the map border already
   * draws that line. It is one walk of `cells²` (80² = 6400) and runs only when `fog.revision` changes.
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

  /** Strokes the fog border (a dark underline + a bright line). Right above the colour layer, below the grid. */
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

  /** The hatch pattern tile (built once). Without a context it is null, and then only the fill is used. */
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

  /** The fog gate: an object standing where nothing is revealed yet is not drawn on the map. With no fog everything shows. */
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
    // 2026-09-09: unexplored ground is a grey outline, only revealed ground is coloured. A world with no fog (the
    //             training range) is one colour sheet as before.
    const fog = ctx.world?.fog ?? null;
    if (fog) {
      if (this.fogDirty || this.fogRevision !== fog.revision) this.buildFogLayer(fog);
      else if (this.fogEdgeRevision !== fog.revision) this.buildFogEdges(fog);
      if (this.outlineCanvas) c.drawImage(this.outlineCanvas, this.ox, this.oy, extent, extent);
      if (this.fogLayer) c.drawImage(this.fogLayer, this.ox, this.oy, extent, extent);
      // 2026-09-09's colour layer had its edge blurred by smoothing, so "we have seen this far" did not read (2026-09-10)
      this.drawFogEdges();
    } else if (this.staticCanvas) {
      c.drawImage(this.staticCanvas, this.ox, this.oy, extent, extent);
    }

    this.drawGrid(c);

    /*
     * 2026-09-09 — environmental hazards are drawn **on top of the fog layer**. They are a phenomenon the ship
     * observes from orbit and reports, so they have nothing to do with the ground revealed on foot (an explicit
     * request from the user). The `discovered()` gate is therefore not raised on them either.
     */
    this.drawHazard(ctx);

    const world = ctx.world;
    const t = ctx.time;
    const labels = this.labels;
    if (world?.ready) {
      // rails · platforms · trams (2026-09-09): landmarks, so only the discovered ones. A tram moves every frame.
      this.drawRails(ctx);
      // the rover dirt road · stations (2026-09-13) — the vehicle body is drawn below, after the ship
      const rover = world.rover ?? null;
      if (rover) this.drawRoverRoute(rover);
      // abandoned structures (2026-09-09)
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
        // while a locked door (the outpost basement · the lab's locked room on floor 2) is still locked, one more
        // amber lock dot is drawn (2026-09-12: the key is no longer guaranteed to be inside that building — the
        // dot means 「somewhere to bring a key · keycard to」)
        if ((st.hasBasement || st.hasLockedRoom) && !st.unlocked) {
          c.fillStyle = COL.accent;
          c.beginPath(); c.arc(x + 6, y - 6, 2, 0, Math.PI * 2); c.fill();
        }
        // 2026-09-13: the short proper name instead of `구조물` (`연구소` · `전진기지` · `불시착 함선`)
        labels.add(STRUCTURE_SHORT_KO[st.kind] ?? '구조물', x, y + rr + 2, LABEL_COL, PRIO.structure);
      }
      /* Ruined outposts (2026-09-11, C-11) — only those accumulated from discovery events. A **ㄷ shape** like a
       * collapsed wall (a square with one side open), stroked as an outline only so it never reads as the
       * structure's filled square. */
      for (const [, pos] of this.outposts) {
        const x = this.toX(pos.x), y = this.toY(pos.z);
        if (!this.inView(x, y, 16)) continue;
        c.strokeStyle = COL.outpost; c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(x + 4.5, y - 4.5); c.lineTo(x - 4.5, y - 4.5); c.lineTo(x - 4.5, y + 4.5); c.lineTo(x + 1.5, y + 4.5);
        c.stroke();
        c.fillStyle = COL.outpost;
        c.fillRect(x + 3, y - 1, 1.6, 1.6);                 // antenna beacon dot
        labels.add('폐허 전초', x, y + 7, LABEL_COL, PRIO.outpost);
      }
      // giant mushroom groves (where the toxic spores come from) — only the discovered ones
      for (const src of ctx.world?.hazard?.getSources() ?? []) {
        if (!src.discovered) continue;
        const x = this.toX(src.position.x), y = this.toY(src.position.z);
        if (!this.inView(x, y, 10)) continue;
        c.strokeStyle = COL.grove; c.lineWidth = 1.3;
        c.beginPath(); c.arc(x, y - 1.5, 4, Math.PI, 0); c.stroke();
        c.beginPath(); c.moveTo(x, y - 1.5); c.lineTo(x, y + 3.5); c.stroke();
        labels.add('버섯 군락', x, y + 6, LABEL_COL, PRIO.grove);
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
        labels.add('벌레 둥지', x, y + 7, LABEL_COL, PRIO.nest);
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
      // gather nodes: herbs are a small cross, a scrap pile (2026-09-08) an amber square — both dim once harvested
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
          drawGatherCross(c, x, y, g.harvested ? 'rgba(127,230,161,0.25)' : COL.gather);
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
        drawPad(c, x, y, active);
        labels.add('탈출', x, y + 10, active ? COL.accent : LABEL_COL, PRIO.pad);
      }
      // landed ship (2026-09-14: the tutorial hides the ship from the map until the last `extract` step — the legend row with it)
      if (this.shipPos && !this.hidesShip()) {
        const x = this.toX(this.shipPos.x), y = this.toY(this.shipPos.z);
        if (this.inView(x, y, 20)) {
          drawShip(c, x, y);
          labels.add('함선', x, y + 10, COL.success, PRIO.ship);
        }
      }
      // the rover body (2026-09-13)
      if (rover) this.drawRoverVehicle(rover);
      // the landmark labels go out here in one pass — where two overlap the lower-priority one is dropped
      labels.flush(c);
      if (rover && this.roverMode) this.drawRoverReason(rover);
    }
    /* 2026-09-13 (user's decision): dropped items · deployables · mines are not drawn on the map. */
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
        /* 2026-09-09: the downed left / right pings — matched to the ✚ / ✖ of the off-screen arrows. */
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
      const label = p.label ?? PING_LABEL[p.kind];
      drawLabel(c, p.owner ? `${p.owner.name} · ${label}` : label, x, y - 8, col, 'bottom');
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
        // 2026-09-13: the ×1.6 arrow — the same function as the legend sample (`mapIcons`)
        if (r.isDead) drawSquadDead(c, x, y, col);
        else drawSquadArrow(c, x, y, Math.atan2(-Math.cos(r.yaw), -Math.sin(r.yaw)), col);
        drawLabel(c, suspended ? `${r.name} · ${SUSPENDED_LABEL_KO}` : r.isDead ? `${r.name} · 전사` : r.name, x, y + 9 * MARKER_SCALE, col);
        c.globalAlpha = 1;
      }
    }
    /* 2026-09-15 (android squadmates): the same place · the same slot colour as a squadmate marker, in **a
     * different shape** (`drawAllyArrow` — a hollow triangle + a centre dot). There is deliberately no
     * multiplayer gate: a unit from the cheat follows into a solo raid too. Hidden bodies (drop pod · liftoff
     * ship) are left out, and a downed or dead one is drawn as a square + X. */
    for (const b of allyBodies(ctx)) {
      if (b.hidden || b.mode !== 'raid') continue;
      const x = this.toX(b.position.x), y = this.toY(b.position.z);
      if (!this.inView(x, y, 30)) continue;
      const col = NET_SLOT_COLORS_CSS[b.slot] ?? '#fff';
      c.globalAlpha = b.dead ? 0.55 : 1;
      if (b.dead || b.downed) drawAllyDown(c, x, y, col);
      else drawAllyArrow(c, x, y, Math.atan2(-Math.cos(b.yaw), -Math.sin(b.yaw)), col);
      drawLabel(c, b.dead ? `${b.name} · 파괴됨` : b.downed ? `${b.name} · 쓰러짐` : b.name, x, y + 9 * MARKER_SCALE, col);
      c.globalAlpha = 1;
    }
    // player — forward = (-sin yaw, -cos yaw) in world XZ; canvas y = +Z
    const player = ctx.player;
    if (player) {
      const x = this.toX(player.position.x), y = this.toY(player.position.z);
      const ang = Math.atan2(-Math.cos(player.yaw), -Math.sin(player.yaw));
      drawPlayerCone(c, x, y, ang);
      drawPlayerArrow(c, x, y, ang);
    }
    c.globalAlpha = 1;
  }

  /* ── 2026-09-09: environmental hazards · rails ─────────────────────────── */

  /**
   * Lays the shapes of `HazardRef.getZones()` over the fog. While `world/` has not built a hazard yet, `hazard`
   * is null and the whole thing is skipped.
   *
   *   - `front` = a **half-plane**. The front line passes through `center` and its normal is `(dirX, dirZ)` — the
   *     travel direction. So the **far side of the normal** (the side already passed) is the danger: it is filled
   *     red and then the front line itself is stroked thick.
   *   - `circle` = a circle. With `safeInside` the **outside** of the circle is the danger, so the circle is cut
   *     out of the whole canvas and filled (even-odd); otherwise the **inside** is filled.
   *
   * Even with no shape at all, a running hazard leaves one name tag at the top left — whoever opened the map
   * reads "what is coming right now" here.
   */
  private drawHazard(ctx: GameContext): void {
    const hz: HazardRef | null = ctx.world?.hazard ?? null;
    if (!hz || !hz.active) return;
    const c = this.c2d;
    const C = this.side;
    const s = this.scale();
    const L = this.size * 2;   // length (m) that certainly covers the half-plane past the canvas edge

    // 2026-09-10: one fill layer + one **hatch** layer. The same path is filled twice, so it is reused after `fill`.
    const hatch = this.hatch();
    const paint = (rule?: CanvasFillRule): void => {
      c.fillStyle = HAZARD_FILL;
      if (rule) c.fill(rule); else c.fill();
      if (hatch) { c.fillStyle = hatch; if (rule) c.fill(rule); else c.fill(); }
    };
    /** Border: a bright line over a dark underline — it survives over bright terrain. */
    const edge = (draw: () => void): void => {
      c.strokeStyle = HAZARD_LINE_UNDER; c.lineWidth = 4.5; c.beginPath(); draw(); c.stroke();
      c.strokeStyle = HAZARD_LINE; c.lineWidth = 2.2; c.beginPath(); draw(); c.stroke();
    };

    c.save();
    c.beginPath(); c.rect(0, 0, C, C); c.clip();
    /* 2026-09-13: **nothing is drawn outside the map square** (the user's request). The eye of the storm now
     * starts as a circle containing all four map corners, so most of it lies outside the map, and on a zoomed ·
     * panned map the canvas can be wider than the map. This clip is stacked on the canvas clip. */
    const mapX = this.toX(-this.size / 2), mapY = this.toY(-this.size / 2), mapW = this.size * s;
    c.beginPath(); c.rect(mapX, mapY, mapW, mapW); c.clip();
    const union = this.sporeCircles;
    union.length = 0;
    for (const z of hz.getZones()) {
      if (z.shape === 'front') {
        const px = -z.dirZ, pz = z.dirX;                       // front-line direction (perpendicular to the normal)
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
      /* 2026-09-11 (C-15): the eye of the storm closes all the way to radius 0. With only `Math.max(1, …)`, a
       * **1 px safe hole and its border** were left even after it had closed, and that read as "there is still a
       * safe zone". Below `CLOSED_RADIUS_M`, the same threshold as the world's wall visuals
       * (`hazard/parts/Visuals`), the circle is closed: a safe-inside circle makes the whole canvas dangerous, a
       * danger-inside circle draws nothing. */
      if (z.radius <= CLOSED_RADIUS_M) {
        if (z.safeInside) { c.beginPath(); c.rect(0, 0, C, C); paint(); }
        continue;
      }
      const rr = Math.max(1, z.radius * s);
      c.beginPath();
      if (z.safeInside) {
        // outside the circle is the danger: the circle is cut out of the canvas rectangle (even-odd).
        // after `rect` the current point is the rectangle's start, so calling `arc` with no `moveTo` draws a line from it.
        c.rect(0, 0, C, C);
        c.moveTo(cx + rr, cy);
        c.arc(cx, cy, rr, 0, Math.PI * 2);
        paint('evenodd');
        edge(() => c.arc(cx, cy, rr, 0, Math.PI * 2));
      } else {
        /* 2026-09-13: a danger-inside circle (toxic spores) is not drawn here but collected and drawn as **one
         * union shape** — filling per circle painted the overlaps twice and the borders cut across each other's
         * insides into a Venn diagram. */
        union.push(cx, cy, rr);
      }
    }
    if (union.length > 0) this.drawCircleUnion(union, paint, edge);
    c.restore();

    if (hz.kind) {
      drawLabel(c, `${HAZARD_LABEL_KO[hz.kind]} · 안전지대 ${Math.max(0, Math.round((1 - hz.progress) * 100))}%`, 8, C - 17, COL.danger, 'top', 'left');
    }
  }

  /**
   * 2026-09-13 — draws the **union** of several circles as one shape. `circles` = `[cx, cy, r, …]` in canvas px.
   *   - Fill: every circle goes into one path and is filled once with nonzero (they wind the same way, so an
   *     overlap is painted only once).
   *   - Border: per circle only the **arcs no other circle covers** are stroked — the inner arcs of overlapping
   *     circles disappear and one outer outline is left. A circle entirely inside another (of two identical
   *     circles, the later one) gets no border.
   */
  private drawCircleUnion(
    circles: readonly number[], paint: () => void, edge: (draw: () => void) => void,
  ): void {
    const c = this.c2d;
    const n = circles.length / 3;
    const TAU = Math.PI * 2;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = circles[i * 3], y = circles[i * 3 + 1], r = circles[i * 3 + 2];
      c.moveTo(x + r, y);
      c.arc(x, y, r, 0, TAU);
    }
    paint();
    const iv = this.arcScratch;
    edge(() => {
      for (let i = 0; i < n; i++) {
        const xi = circles[i * 3], yi = circles[i * 3 + 1], ri = circles[i * 3 + 2];
        iv.length = 0;
        let hidden = false;
        for (let j = 0; j < n && !hidden; j++) {
          if (j === i) continue;
          const dx = circles[j * 3] - xi, dy = circles[j * 3 + 1] - yi, rj = circles[j * 3 + 2];
          const d = Math.hypot(dx, dy);
          if (d >= ri + rj) continue;                                   // apart
          if (d + ri <= rj) {                                           // i lies entirely inside j
            const same = d < 1e-6 && Math.abs(ri - rj) < 1e-6;
            if (!same || j < i) hidden = true;
            continue;
          }
          if (d + rj <= ri) continue;                                   // j is inside i — it covers none of i's rim
          const cosA = (ri * ri + d * d - rj * rj) / (2 * ri * d);
          const a = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
          const phi = Math.atan2(dy, dx);
          // fold [phi − a, phi + a] into [0, TAU) (split in two when it overflows)
          const s0 = ((phi - a) % TAU + TAU) % TAU;
          const e0 = s0 + 2 * a;
          if (e0 > TAU) { iv.push(s0, TAU, 0, e0 - TAU); } else iv.push(s0, e0);
        }
        if (hidden) continue;
        // sort by start angle (insertion sort over pairs — there are only a few circles)
        for (let k = 2; k < iv.length; k += 2) {
          const s = iv[k], e = iv[k + 1];
          let m = k - 2;
          while (m >= 0 && iv[m] > s) { iv[m + 2] = iv[m]; iv[m + 3] = iv[m + 1]; m -= 2; }
          iv[m + 2] = s; iv[m + 3] = e;
        }
        let cur = 0;
        for (let k = 0; k < iv.length; k += 2) {
          if (iv[k] > cur) { c.moveTo(xi + ri * Math.cos(cur), yi + ri * Math.sin(cur)); c.arc(xi, yi, ri, cur, iv[k]); }
          if (iv[k + 1] > cur) cur = iv[k + 1];
        }
        if (cur < TAU) { c.moveTo(xi + ri * Math.cos(cur), yi + ri * Math.sin(cur)); c.arc(xi, yi, ri, cur, TAU); }
      }
    });
  }

  /** Rail centre lines + platforms + trams. Only the discovered ones (a tram is judged by its current position, so it moves on the map). */
  private drawRails(ctx: GameContext): void {
    const world = ctx.world;
    if (!world) return;
    const c = this.c2d;
    for (const line of world.getRailLines()) {
      const pts = line.points;
      if (pts.length < 2) continue;
      if (!pts.some((p) => this.discovered(p))) continue;
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const X = this.toX(pts[i].x), Y = this.toY(pts[i].z);
        if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
      }
      if (line.kind === 'loop') c.closePath();
      strokeRail(c);
      for (const p of line.platforms) {
        if (!this.discovered(p.position)) continue;
        const X = this.toX(p.position.x), Y = this.toY(p.position.z);
        if (!this.inView(X, Y, 8)) continue;
        drawPlatform(c, X, Y);
        this.labels.add('플랫폼', X, Y + 4, LABEL_COL, PRIO.platform);
      }
    }
    for (const tram of world.getTrams()) {
      if (!this.discovered(tram.position)) continue;
      const X = this.toX(tram.position.x), Y = this.toY(tram.position.z);
      if (!this.inView(X, Y, 10)) continue;
      drawTram(c, X, Y, tram.yaw, tram.state === 'moving');
    }
  }

  /* ── 2026-09-13: the rover ─────────────────────────────────────────────── */

  /** Whether a station is visible on the map — either every station is revealed (somebody boarded) or its sign post was discovered. */
  private stationVisible(rover: RoverRef, st: RoverStationDef): boolean {
    return rover.stationsRevealed || this.discovered(st.polePosition);
  }

  /** The dirt road (only once revealed) + station markers · labels. In destination selection mode the fare · current position · blocked stations are drawn too. */
  private drawRoverRoute(rover: RoverRef): void {
    const c = this.c2d;
    const pts = rover.route.points;
    if (rover.stationsRevealed && pts.length >= 2) {
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const X = this.toX(pts[i].x), Y = this.toY(pts[i].z);
        if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
      }
      c.closePath();
      strokeRoute(c);
    }
    const v = rover.vehicle;
    for (const st of rover.route.stations) {
      if (!this.stationVisible(rover, st)) continue;
      const X = this.toX(st.polePosition.x), Y = this.toY(st.polePosition.z);
      if (!this.inView(X, Y, 40)) continue;
      const swallowed = rover.isStationSwallowed(st.id);
      if (!this.roverMode) {
        drawStation(c, X, Y, { swallowed });
        this.labels.add(st.label, X, Y + 8, swallowed ? COL.danger : COL.station, PRIO.station);
        continue;
      }
      const current = v.stationId === st.id;
      const blocked = !current && rover.tripBlock(st.id) !== null;
      const ring = current ? 'current' : st.id === this.selectedStation ? 'selected' : st.id === this.hoverStation ? 'hover' : null;
      drawStation(c, X, Y, { swallowed, disabled: blocked, ring });
      this.labels.add(st.label, X, Y + 12, current ? COL.success : blocked ? COL.dim : COL.station, PRIO.station);
      const fare = current ? null : rover.fareTo(st.id);
      const sub = current ? '현재 위치' : fare !== null ? `${fmtInt(fare)} 크레딧` : '';
      if (sub) this.labels.add(sub, X, Y + 25, current ? COL.success : blocked ? COL.dim : COL.accent, PRIO.station);
    }
  }

  /** The vehicle marker — when its current spot has been discovered · the stations are revealed · or the local player is aboard. */
  private drawRoverVehicle(rover: RoverRef): void {
    const v = rover.vehicle;
    if (!rover.stationsRevealed && !rover.localAboard && !this.discovered(v.position)) return;
    const X = this.toX(v.position.x), Y = this.toY(v.position.z);
    if (!this.inView(X, Y, 14)) return;
    drawRover(this.c2d, X, Y, v.yaw, v.state === 'destroyed');
  }

  /** Destination selection mode: when the hovered · selected station is blocked, its reason is written in red beside the marker. */
  private drawRoverReason(rover: RoverRef): void {
    const id = this.hoverStation ?? this.selectedStation;
    if (!id || rover.vehicle.stationId === id) return;
    const st = this.findStation(rover, id);
    if (!st) return;
    const reason = rover.tripBlock(id);
    if (!reason) return;
    drawLabel(this.c2d, reason, this.toX(st.polePosition.x), this.toY(st.polePosition.z) - 12, COL.danger, 'bottom');
  }

  private findStation(rover: RoverRef, id: string): RoverStationDef | null {
    for (const st of rover.route.stations) if (st.id === id) return st;
    return null;
  }

  /** Canvas coordinates → the nearest visible station (within `STATION_HIT_PX`), null with none. */
  private stationAt(clientX: number, clientY: number): RoverStationDef | null {
    const rover = this.ctx?.world?.rover;
    if (!rover) return null;
    const r = this.canvas.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    let best: RoverStationDef | null = null, bestD = STATION_HIT_PX;
    for (const st of rover.route.stations) {
      if (!this.stationVisible(rover, st)) continue;
      const d = Math.hypot(this.toX(st.polePosition.x) - mx, this.toY(st.polePosition.z) - my);
      if (d < bestD) { bestD = d; best = st; }
    }
    return best;
  }

  private pickStation(clientX: number, clientY: number): void {
    const st = this.stationAt(clientX, clientY);
    this.selectedStation = st ? st.id : null;
    this.tripError = null;
    if (st) this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /**
   * Enters destination selection mode (`rover:destinationSelect {open:true}` · M while aboard and stopped). It
   * opens the map when the map is closed — while another screen is up (the inventory and so on) it does not take
   * over but is ignored (M can open it later).
   */
  private enterRoverMode(): void {
    const ctx = this.ctx;
    if (!ctx?.world?.rover) return;
    if (!this._open) {
      if (ctx.uiBlockers.size > 0 || !ctx.isGameplayPhase()) return;
      this.open();
      if (!this._open) return;
      this.roverOpenedMap = true;
    }
    this.roverMode = true;
    this.roverEnteredAt = ctx.time;
    this.selectedStation = null;
    this.tripError = null;
    this.legendEl.hidden = true;
    this.roverPanel.hidden = false;
    // 2026-09-14: the destination panel takes the column's room — the quest list hides too and the foot rows go to the bottom (`.is-rover`)
    this.quests.setSuppressed(true);
    this.sideEl.classList.add('is-rover');
    this.emitGuide();
  }

  /** Clears only the mode state (the map is left alone) — called by `close()`. */
  private resetRoverMode(): void {
    this.stopHold();
    this.roverMode = false;
    this.roverOpenedMap = false;
    this.selectedStation = null;
    this.hoverStation = null;
    this.tripError = null;
    this.legendEl.hidden = false;
    this.roverPanel.hidden = true;
    this.quests.setSuppressed(false);
    this.sideEl.classList.remove('is-rover');
    this.canvas.classList.remove('pick');
  }

  /** Ends the mode. With `closeMap` and a map the mode opened, the map closes too; otherwise the map's guide is restored. */
  private exitRoverMode(closeMap: boolean): void {
    const opened = this.roverOpenedMap;
    this.resetRoverMode();
    if (!this._open) return;
    if (closeMap && opened) this.close(); else this.emitGuide();
  }

  /**
   * Every frame: the mode ends once the vehicle leaves the stopped state (somebody paid · it was destroyed) or the
   * local player is no longer aboard. For the first 0.5 s after entering, `localAboard` is not read
   * (`rover:destinationSelect` can arrive before the aboard flag). The panel values are written here too.
   */
  private tickRoverMode(ctx: GameContext): void {
    const rover = ctx.world?.rover ?? null;
    const settled = ctx.time - this.roverEnteredAt > 0.5;
    if (!rover || rover.vehicle.state === 'destroyed' || (settled && (!rover.localAboard || rover.vehicle.state !== 'stopped'))) {
      this.exitRoverMode(true);
      return;
    }
    const credits = ctx.meta?.credits;
    setText(this.rvCredits, typeof credits === 'number' ? `${fmtInt(credits)} 크레딧` : '—');
    const st = this.selectedStation ? this.findStation(rover, this.selectedStation) : null;
    if (!st) {
      this.rvHint.hidden = false;
      setText(this.rvDest, '—'); setText(this.rvDist, '—'); setText(this.rvFare, '—');
      setText(this.rvReason, this.tripError ?? '');
      setText(this.rvBtnLbl, '목적지를 선택하세요');
      this.setBtnBlocked(true);
      return;
    }
    this.rvHint.hidden = true;
    const dist = rover.tripDistance(st.id);
    const fare = rover.fareTo(st.id);
    const block = rover.vehicle.stationId === st.id ? '지금 서 있는 정류장입니다' : rover.tripBlock(st.id);
    setText(this.rvDest, st.label);
    setText(this.rvDist, dist !== null ? `${fmtInt(Math.round(dist))} m` : '—');
    setText(this.rvFare, fare !== null ? `${fmtInt(fare)} 크레딧` : '—');
    setText(this.rvReason, this.tripError ?? block ?? '');
    setText(this.rvBtnLbl, fare !== null ? `${fmtInt(fare)} 크레딧 지불 · 출발` : '출발할 수 없음');
    this.setBtnBlocked(block !== null);
  }

  private setBtnBlocked(blocked: boolean): void {
    toggleClass(this.rvBtn, 'is-blocked', blocked);
    // Showing the 「hold it down」 glyph while pressing achieves nothing would be a lie (2026-09-15, 2nd pass).
    this.rvBtnCap.style.display = blocked ? 'none' : '';
    this.rvBtn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (blocked && this.holdStart) this.stopHold();
  }

  /* Confirming departure = a `UI_HOLD_CONFIRM_S` hold (the same gauge as the pause menu · crafting — the gauge
   * runs on rAF and an early release drops it to 0) */
  private startHold(e: PointerEvent): void {
    if (e.button !== 0 || !this.roverMode || this.holdStart) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.rvBtn.classList.contains('is-blocked')) { this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.6 }); return; }
    this.holdStart = performance.now();
    this.rvBtn.classList.add('is-holding');
    window.addEventListener('pointerup', this.onHoldUp);
    window.addEventListener('pointercancel', this.onHoldUp);
    this.ctx.bus.emit('audio:play', { id: 'ui_pickup' });
    this.tickHold();
  }

  private readonly tickHold = (): void => {
    if (!this.holdStart) return;
    this.holdRaf = 0;
    const t = Math.min(1, (performance.now() - this.holdStart) / (Math.max(0.05, UI_HOLD_CONFIRM_S) * 1000));
    this.rvBtnFill.style.width = `${(t * 100).toFixed(1)}%`;
    if (t < 1) { this.holdRaf = requestAnimationFrame(this.tickHold); return; }
    this.stopHold();
    this.confirmTrip();
  };

  private stopHold(): void {
    if (this.holdRaf) { cancelAnimationFrame(this.holdRaf); this.holdRaf = 0; }
    if (!this.holdStart) return;
    this.holdStart = 0;
    window.removeEventListener('pointerup', this.onHoldUp);
    window.removeEventListener('pointercancel', this.onHoldUp);
    this.rvBtnFill.style.width = '0%';
    this.rvBtn.classList.remove('is-holding');
  }

  /** The hold finished — payment + the departure request. Blocked, the reason goes on the panel; departing closes the mode and the map. */
  private confirmTrip(): void {
    const rover = this.ctx.world?.rover;
    const id = this.selectedStation;
    if (!rover || !id) return;
    const reason = rover.requestTrip(id);
    if (reason) {
      this.tripError = reason;
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.6 });
      return;
    }
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.resetRoverMode();
    this.close();
  }

  /**
   * 2026-09-14 (tutorial): whether the landed extraction ship must not be drawn on the map right now.
   * The tutorial raid only tells about the ship once the last `extract` step begins — there 「go to the ship」 is
   * the objective itself, so the marker acts as the guide. The rule is owned by `tutorial/parts/Gates` alone and
   * is only asked here; outside the tutorial it is always false, so the normal map does not change by one glyph.
   */
  private hidesShip(): boolean {
    return this.ctx?.tutorial?.hides('hud', 'shipMarker') ?? false;
  }

  /* ── legend ────────────────────────────────────────────────────────────── */

  /**
   * Shows the legend rows · redraws the samples (on opening the map · a new world). The squadmate row only in
   * multiplayer, rail · tram only while there are rails, the two rover rows only while there is a vehicle. The
   * squadmate sample uses the slot colour of an actual squadmate.
   */
  private refreshLegend(): void {
    const ctx = this.ctx;
    const world = ctx?.world;
    const hasRail = !!world?.ready && world.getRailLines().length > 0;
    const hasRover = !!world?.rover;
    const multi = !!ctx?.isMultiplayer;
    let squadCol = NET_SLOT_COLORS_CSS[1];
    if (multi && ctx.net) for (const r of ctx.net.getRemotePlayers()) { if (NET_SLOT_COLORS_CSS[r.slot]) { squadCol = NET_SLOT_COLORS_CSS[r.slot]; break; } }
    const hideShip = this.hidesShip();
    // 2026-09-15: the android row only while at least one body exists (one unit from the cheat, or the squad's three)
    const allies = ctx ? allyBodies(ctx) : null;
    const hasAlly = !!allies && allies.length > 0;
    const allyCol = hasAlly ? (NET_SLOT_COLORS_CSS[allies[0].slot] ?? '#fff') : NET_SLOT_COLORS_CSS[3];
    for (const lr of this.legendRows) {
      const show = lr.id === 'squad' ? multi : lr.id === 'ally' ? hasAlly
        : lr.id === 'rail' || lr.id === 'tram' ? hasRail : lr.id === 'rover' || lr.id === 'route' ? hasRover : lr.id === 'ship' ? !hideShip : true;
      lr.row.hidden = !show;
      if (show) this.drawSwatch(lr, lr.id === 'ally' ? allyCol : squadCol);
    }
  }

  /** One legend sample cell — it calls **the same painter as the map** at the same size. */
  private drawSwatch(lr: LegendRow, squadCol: string): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cv = lr.cv;
    const w = Math.round(SW_W * dpr), h = Math.round(SW_H * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, SW_W, SW_H);
    const cx = SW_W / 2, cy = SW_H / 2;
    const k = MARKER_SCALE;
    switch (lr.id) {
      // the arrow is nudged so the midpoint of its front and rear ends sits at the sample's centre
      case 'player': drawPlayerArrow(c, cx - 1.5 * k, cy, 0); break;
      case 'squad': drawSquadArrow(c, cx - 1 * k, cy, 0, squadCol); break;
      case 'ally': drawAllyArrow(c, cx - 1 * k, cy, 0, squadCol); break;
      case 'pad': drawPad(c, cx, cy); break;
      case 'ship': drawShip(c, cx, cy); break;
      case 'gather': drawGatherCross(c, cx, cy); break;
      case 'rail': c.beginPath(); c.moveTo(2, cy); c.lineTo(SW_W - 2, cy); strokeRail(c); drawPlatform(c, cx, cy); break;
      case 'tram': drawTram(c, cx, cy, 0, true); break;
      case 'rover': drawRover(c, cx - 1.5, cy, 0); break;
      case 'route': c.beginPath(); c.moveTo(1, cy); c.lineTo(SW_W - 1, cy); strokeRoute(c); drawStation(c, cx, cy); break;
      case 'hazard': drawHazardSwatch(c, 3, 4, SW_W - 6, SW_H - 8); break;
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
    drawDiamond(c, x, y, r, stroke, fill);
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
    this.stopHold();
    this.quests.dispose();
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
