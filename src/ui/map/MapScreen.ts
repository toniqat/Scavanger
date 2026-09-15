import * as THREE from 'three';
import type { FogRef, GameContext, HazardRef, KeyGuideEntry, PingKind, RoverRef, RoverStationDef, StructureKind } from '@/shared';
import {
  HAZARD_LABEL_KO, Keys, MENU_BLOCKER, NET_SLOT_COLORS_CSS, PlayerFlags, SUSPENDED_LABEL_KO, UI_HOLD_CONFIRM_S, keyLabel, mouseButtonOf,
} from '@/shared';
import { el, fmtInt, setText, toggleClass } from '../dom';
import type { PingView } from '../hud/Pings';
import { PING_LABEL } from '../hud/Pings';
import {
  FONT_LABEL, MAP_COL, MARKER_SCALE, MapLabels, drawDiamond, drawGatherCross, drawHazardSwatch, drawLabel, drawPad, drawPlatform,
  drawPlayerArrow, drawPlayerCone, drawRover, drawShip, drawSquadArrow, drawSquadDead, drawStation, drawTram, strokeRail, strokeRoute,
} from './mapIcons';
import '../styles/rover.css';
/* 2026-09-14 (메신저 · NPC 퀘스트): 좌측 열의 퀘스트 패널 목록 + 호버 툴팁 */
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

/** 2026-09-13: 색 · 마커 그림은 `mapIcons` 로 옮겼다 (범례 견본이 같은 함수를 부른다). */
const COL = MAP_COL;

/**
 * 지도 라벨의 **짧은 원래 이름** (2026-09-13 사용자 결정). 예전에는 구조물이 전부 `구조물`, 폐허 전초가 `폐허` 였다.
 * 토스트(`hud/RaidAlerts`)는 여전히 `STRUCTURE_LABEL_KO` 의 정식 이름을 쓴다 — 지도 라벨만 짧게.
 */
const STRUCTURE_SHORT_KO: Readonly<Record<StructureKind, string>> = { outpost: '전진기지', lab: '연구소', wreck: '불시착 함선' };
/** 라벨 겹침 우선순위 (작을수록 먼저 자리를 차지한다). */
const PRIO = { ship: 0, pad: 1, station: 2, structure: 3, outpost: 4, platform: 5, nest: 6, grove: 7 } as const;
/** 지형지물 라벨 색 — 마커보다 조금 밝게 (어두운 윤곽이 둘린다). */
const LABEL_COL = 'rgba(232,230,225,0.85)';
/** 목적지 선택: 정류장을 집는 반경(px) · 클릭으로 치는 최대 이동(px). */
const STATION_HIT_PX = 18;
const CLICK_SLOP_PX = 5;
/** 범례 견본 캔버스 크기(CSS px) — 1.6배 플레이어 화살표가 들어가는 크기. */
const SW_W = 28, SW_H = 20;

type LegendId = 'player' | 'squad' | 'pad' | 'ship' | 'gather' | 'rail' | 'tram' | 'rover' | 'route' | 'hazard';
interface LegendRow { id: LegendId; row: HTMLElement; cv: HTMLCanvasElement }
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
  /** 2026-09-13: 독성 포자 원 합집합 — 이번 프레임의 원 `[cx, cy, r, …]` (px) 과 호 구간 스크래치. 재사용한다. */
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

  /* 2026-09-13: 라벨 겹침 층 · 범례 견본 */
  private readonly labels = new MapLabels();
  private legendEl: HTMLElement;
  private legendRows: LegendRow[] = [];
  /* 2026-09-14: 좌측 열 = 머리 → 퀘스트 패널(`quests`) → 범례(좌측 하단) → 발밑 줄. 열 높이는 `fit` 이 캔버스 높이로 못 박는다. */
  private readonly sideEl: HTMLElement;
  private readonly quests: MapQuestPanels;

  /* 2026-09-13: 탐사 차량 목적지 선택 모드 */
  private roverMode = false;
  /** 목적지 선택 모드가 지도를 **열었다** — 모드가 끝나면 지도도 닫는다 (이미 열린 지도에 들어왔으면 지도는 남긴다). */
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
  private rvBtnLbl: HTMLElement;
  private holdStart = 0;
  private holdRaf = 0;

  /*
   * 2026-09-13: Escape **does** close the map (the stale 2026-09-08 note said otherwise) — `open()` pushes it onto
   * `ctx.escape` like every screen (2026-09-09 규칙: Escape 는 맨 위 화면 하나를 닫는다). M (`Keys.MAP`) and Tab close it
   * too (polled in `update`); the 키 가이드 shows all three.
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
    // 2026-09-13: it follows `Keys.PING` (the 키 가이드 shows `keyLabel(Keys.PING)`) — unless it was rebound onto the
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
    // 2026-09-13: 목적지 선택 모드에서 끌지 않은 좌클릭 = 정류장 고르기 (끌면 예전처럼 이동만)
    if (this.roverMode && !this.dragMoved) this.pickStation(e.clientX, e.clientY);
  };
  /** 목적지 선택 모드의 정류장 호버 (커서 모양 · 강조 링). */
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

    /* 2026-09-14 (사용자 결정): 범례 윗부분에 진행 중인 NPC 퀘스트 패널 목록 — 남는 높이를 차지하고 길면 스크롤한다.
     * 범례는 그 아래, 좌측 하단에 붙는다 (`.map-legend { margin-top: auto }`). */
    this.quests = new MapQuestPanels(side, this.root);

    /* 범례 (2026-09-13 개편, 사용자 결정): 라벨이 이름을 말하는 지형지물(구조물 · 폐허 전초 · 버섯 군락 · 벌레 둥지)과 핑 · 상자 ·
     * 지도에서 뺀 것(떨어진 아이템 · 설치물 · 지뢰)은 범례에 없다. 탈출 지점은 한 줄 (지도는 활성 지점의 호박색 펄스를 그대로 그린다).
     * 견본은 CSS 모양이 아니라 **지도와 같은 그리기 함수**를 부르는 작은 캔버스다 (`mapIcons`). */
    this.legendEl = el('div', { cls: 'map-legend', parent: side });
    el('div', { cls: 'ui-label', text: '범례', parent: this.legendEl });
    const entries: Array<[LegendId, string]> = [
      ['player', '플레이어'],
      ['squad', '분대원'],
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

    /* 2026-09-13: 탐사 차량 목적지 선택 패널 — 선택 모드 동안 범례 자리를 차지한다 */
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
    this.rvBtnLbl = el('span', { cls: 'lbl', text: '목적지를 선택하세요', parent: this.rvBtn });
    el('div', { cls: 'map-rover-note', text: `버튼을 ${UI_HOLD_CONFIRM_S}초 동안 누르고 있어야 출발합니다. 출발하면 도착까지 내릴 수 없습니다.`, parent: this.roverPanel });
    // 되돌릴 수 없는 확정 = 1초 홀드 (CLAUDE.md). 클릭 · Enter · Space 로는 아무것도 하지 않는다.
    this.rvBtn.addEventListener('pointerdown', (e) => this.startHold(e));
    this.rvBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); });

    // 2026-09-13 (사용자 결정): 좌하단 `초기화` 버튼과 조작 안내 줄은 없앴다 — 조작은 우하단 키 가이드가 말한다.
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
  /** 2026-09-13 (debug · smoke): 탐사 차량 목적지 선택 모드인가 · 고른 정류장 id. */
  get isRoverMode(): boolean { return this.roverMode; }
  get roverSelection(): string | null { return this.selectedStation; }
  /** 보이는 범례 줄 id 목록 (debug · smoke). */
  get legendIds(): string[] { return this.legendRows.filter((r) => !r.row.hidden).map((r) => r.id); }
  /** 2026-09-14 (debug · smoke): 퀘스트 패널로 그려진 퀘스트 id · 툴팁이 떠 있는 퀘스트. */
  get questIds(): string[] { return this.quests.questIds; }
  get questTip(): string | null { return this.quests.tipQuest; }
  /** Smoke hook: 목적지 선택 모드에서 정류장을 코드로 고른다 (클릭과 같은 경로). 모드가 아니거나 모르는 id 면 false. */
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
      // 2026-09-13: 탐사 차량 — 막 탔으면 목적지 선택 모드로 연다, 출발 · 하차 · 파괴면 닫는다
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
      // 2026-09-13: 남겨진 사람의 흐름이 리셋되면 떠난 패드 강조를 지운다 (다른 콘솔로 다시 부를 수 있다)
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
      // 2026-09-14 (튜토리얼): 단계가 넘어가면 함선 범례 줄이 붙거나 떨어진다 (지도 캔버스는 프레임마다 스스로 본다)
      b.on('tutorial:changed', () => { if (this._open) this.refreshLegend(); }),
      // 2026-09-14: 퀘스트 패널 — 목표 진행 · 상태가 바뀌면 곧바로 (나머지는 `quests.tick` 의 폴링)
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
        // 2026-09-13: 탐사 차량에 타 정차해 있으면 M 은 목적지 선택 모드로 연다
        const rv = ctx.world?.rover;
        if (rv?.localAboard && rv.vehicle.state === 'stopped') this.enterRoverMode(); else this.open();
      }
    } else if (this._open && ctx.input.wasPressed(Keys.INVENTORY) && !ctx.uiBlockers.has(MENU_BLOCKER)) {
      // 2026-09-09: Tab closes every screen; swallow it so nothing later in the frame opens the inventory on it.
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
   * 키 가이드 entries for the map (the guide appends `Tab 또는 Esc 또는 M 닫기` itself — owner `'map'`).
   * 2026-09-13: 핑 키는 지도에서 실제로 핑을 찍는 버튼(`Keys.PING`)을, 이동은 실제로 끄는 좌클릭(`Mouse0`)을 말한다
   * (예전에는 `Keys.FIRE` 를 읽어 사격 키를 바꾸면 거짓말을 했다). 목적지 선택 모드면 맨 앞에 `좌클릭 목적지 선택`.
   */
  private emitGuide(): void {
    const keys: KeyGuideEntry[] = [];
    if (this.roverMode) keys.push({ key: keyLabel('Mouse0'), label: '목적지 선택' });
    if (mouseButtonOf(Keys.PING, 1) !== 0) keys.push({ key: keyLabel(Keys.PING), label: '핑' });
    // 2026-09-15: 키캡 안에는 키 하나만 (`LMB` → 마우스 그림), 「드래그」 는 동작 쪽으로. `휠`(굴리기)은 누르는 버튼이 아니라 글자로 둔다.
    keys.push({ key: '휠', label: '확대' }, { key: keyLabel('Mouse0'), label: '드래그 이동' });
    this.ctx.bus.emit('ui:keyGuide', { owner: 'map', keys });
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
    // 2026-09-14: 좌측 열 240 → 280 px (퀘스트 패널 + 2열 범례) — 가로 여유도 그만큼 (열 280 + 간격 22 + 안여백 44 + 테두리 · 여유)
    const side = Math.max(240, Math.floor(Math.min(vh * 0.85, vw - 380)));
    // 열 높이 = 캔버스 테두리 상자 높이. 못 박지 않으면 퀘스트 패널이 늘어난 만큼 프레임이 자라 화면 밖으로 나간다.
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
    const labels = this.labels;
    if (world?.ready) {
      // 선로 · 플랫폼 · 전차 (2026-09-09): 지형지물이므로 발견한 것만. 전차는 매 프레임 움직인다.
      this.drawRails(ctx);
      // 탐사 차량 흙길 · 정류장 (2026-09-13) — 차체는 아래에서 함선 뒤에 그린다
      const rover = world.rover ?? null;
      if (rover) this.drawRoverRoute(rover);
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
        // 2026-09-13: `구조물` 대신 짧은 원래 이름 (연구소 · 전진기지 · 불시착 함선)
        labels.add(STRUCTURE_SHORT_KO[st.kind] ?? '구조물', x, y + rr + 2, LABEL_COL, PRIO.structure);
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
        labels.add('폐허 전초', x, y + 7, LABEL_COL, PRIO.outpost);
      }
      // 거대 버섯 군락 (독성 포자 발생지) — 발견한 것만
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
      // landed ship (2026-09-14: 튜토리얼은 마지막 `extract` 단계 전까지 함선을 지도에서 감춘다 — 범례 줄도 같이)
      if (this.shipPos && !this.hidesShip()) {
        const x = this.toX(this.shipPos.x), y = this.toY(this.shipPos.z);
        if (this.inView(x, y, 20)) {
          drawShip(c, x, y);
          labels.add('함선', x, y + 10, COL.success, PRIO.ship);
        }
      }
      // 탐사 차량 차체 (2026-09-13)
      if (rover) this.drawRoverVehicle(rover);
      // 지형지물 라벨은 여기서 한 번에 — 겹치면 우선순위가 낮은 것을 버린다
      labels.flush(c);
      if (rover && this.roverMode) this.drawRoverReason(rover);
    }
    /* 2026-09-13 (사용자 결정): 떨어진 아이템 · 설치물 · 지뢰는 지도에 그리지 않는다. */
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
        // 2026-09-13: 1.6배 화살표 — 범례 견본과 같은 함수 (`mapIcons`)
        if (r.isDead) drawSquadDead(c, x, y, col);
        else drawSquadArrow(c, x, y, Math.atan2(-Math.cos(r.yaw), -Math.sin(r.yaw)), col);
        drawLabel(c, suspended ? `${r.name} · ${SUSPENDED_LABEL_KO}` : r.isDead ? `${r.name} · 전사` : r.name, x, y + 9 * MARKER_SCALE, col);
        c.globalAlpha = 1;
      }
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
    /* 2026-09-13: **맵 사각형 밖은 그리지 않는다** (사용자 요구). 폭풍의 눈이 이제 맵 네 꼭짓점을 품는 원으로 시작해
     * 원의 대부분이 맵 밖에 있고, 확대 · 이동한 지도에서는 캔버스가 맵보다 넓을 수 있다. 캔버스 클립과 겹쳐 건다. */
    const mapX = this.toX(-this.size / 2), mapY = this.toY(-this.size / 2), mapW = this.size * s;
    c.beginPath(); c.rect(mapX, mapY, mapW, mapW); c.clip();
    const union = this.sporeCircles;
    union.length = 0;
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
        edge(() => c.arc(cx, cy, rr, 0, Math.PI * 2));
      } else {
        /* 2026-09-13: 안이 위험한 원(독성 포자)은 여기서 그리지 않고 모아 뒀다가 **합집합 한 도형**으로 그린다 —
         * 원마다 채우면 겹친 곳이 두 번 칠해지고 테두리가 서로의 안쪽을 가로질러 벤다이어그램이 됐다. */
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
   * 2026-09-13 — 원 여럿의 **합집합**을 한 도형으로 그린다. `circles` = 캔버스 px 의 `[cx, cy, r, …]`.
   *   - 채움: 원을 한 경로에 모두 넣고 nonzero 로 한 번 채운다 (같은 방향으로 도는 원이라 겹친 곳도 한 번만 칠해진다).
   *   - 테두리: 원마다 **다른 원에 덮이지 않은 호**만 긋는다 — 겹친 원의 안쪽 호가 사라져 바깥 윤곽 하나만 남는다.
   *     다른 원에 통째로 들어간 원(같은 원이 둘이면 뒤의 것)은 테두리가 없다.
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
          if (d >= ri + rj) continue;                                   // 떨어져 있다
          if (d + ri <= rj) {                                           // i 가 j 안에 통째로
            const same = d < 1e-6 && Math.abs(ri - rj) < 1e-6;
            if (!same || j < i) hidden = true;
            continue;
          }
          if (d + rj <= ri) continue;                                   // j 가 i 안 — i 의 둘레를 덮지 않는다
          const cosA = (ri * ri + d * d - rj * rj) / (2 * ri * d);
          const a = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
          const phi = Math.atan2(dy, dx);
          // [phi − a, phi + a] 를 [0, TAU) 로 접어 넣는다 (넘치면 둘로 쪼갠다)
          const s0 = ((phi - a) % TAU + TAU) % TAU;
          const e0 = s0 + 2 * a;
          if (e0 > TAU) { iv.push(s0, TAU, 0, e0 - TAU); } else iv.push(s0, e0);
        }
        if (hidden) continue;
        // 시작각으로 정렬 (쌍 단위 삽입 정렬 — 원이 몇 개뿐이다)
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

  /** 선로 중심선 + 플랫폼 + 전차. 발견한 것만 (전차는 자기 현재 위치로 판정하므로 지도에서 움직인다). */
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

  /* ── 2026-09-13: 탐사 차량 ─────────────────────────────────────────────── */

  /** 정류장이 지도에 보이는가 — 모든 정류장이 공개됐거나(누군가 탔다) 안개로 그 표지 기둥을 발견했다. */
  private stationVisible(rover: RoverRef, st: RoverStationDef): boolean {
    return rover.stationsRevealed || this.discovered(st.polePosition);
  }

  /** 흙길(공개된 뒤에만) + 정류장 마커 · 라벨. 목적지 선택 모드면 요금 · 현재 위치 · 막힌 정류장을 함께 그린다. */
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

  /** 차체 마커 — 지금 자리를 발견했거나 · 정류장이 공개됐거나 · 내가 타 있으면. */
  private drawRoverVehicle(rover: RoverRef): void {
    const v = rover.vehicle;
    if (!rover.stationsRevealed && !rover.localAboard && !this.discovered(v.position)) return;
    const X = this.toX(v.position.x), Y = this.toY(v.position.z);
    if (!this.inView(X, Y, 14)) return;
    drawRover(this.c2d, X, Y, v.yaw, v.state === 'destroyed');
  }

  /** 목적지 선택 모드: 호버 · 선택한 정류장이 막혀 있으면 그 사유를 마커 옆에 붉게 쓴다. */
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

  /** 캔버스 좌표 → 가장 가까운 보이는 정류장 (`STATION_HIT_PX` 안), 없으면 null. */
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
   * 목적지 선택 모드로 들어간다 (`rover:destinationSelect {open:true}` · 타 있는 채 정차 중 M). 지도가 닫혀 있으면 연다 —
   * 다른 화면이 떠 있으면(인벤토리 등) 가로채지 않고 무시한다 (나중에 M 으로 열 수 있다).
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
    // 2026-09-14: 목적지 선택 패널이 열의 자리를 쓴다 — 퀘스트 목록도 숨기고 발밑 줄은 바닥에 (`.is-rover`)
    this.quests.setSuppressed(true);
    this.sideEl.classList.add('is-rover');
    this.emitGuide();
  }

  /** 모드 상태만 지운다 (지도는 건드리지 않는다) — `close()` 가 부른다. */
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

  /** 모드를 끝낸다. `closeMap` 이고 모드가 지도를 열었으면 지도도 닫는다, 아니면 지도의 가이드를 되돌린다. */
  private exitRoverMode(closeMap: boolean): void {
    const opened = this.roverOpenedMap;
    this.resetRoverMode();
    if (!this._open) return;
    if (closeMap && opened) this.close(); else this.emitGuide();
  }

  /**
   * 매 프레임: 차가 정차 상태를 벗어났거나(누가 결제했다 · 파괴) 내가 더 이상 타 있지 않으면 모드를 끝낸다. 들어온 직후
   * 0.5 초는 `localAboard` 를 보지 않는다 (`rover:destinationSelect` 가 탑승 표시보다 먼저 올 수 있다). 패널 값도 여기서 쓴다.
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
    this.rvBtn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (blocked && this.holdStart) this.stopHold();
  }

  /* 출발 확정 = `UI_HOLD_CONFIRM_S` 홀드 (일시정지 메뉴 · 제작과 같은 게이지 — 게이지는 rAF, 일찍 떼면 0) */
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

  /** 홀드가 끝났다 — 결제 + 출발 요청. 막히면 사유를 패널에, 나가면 모드와 지도를 닫는다. */
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
   * 2026-09-14 (튜토리얼): 착륙해 있는 탈출 함선을 지금 지도에 그리면 안 되는가.
   * 튜토리얼 레이드는 마지막 `extract` 단계에 들어서야 함선을 알려 준다 — 그때는 「함선을 찾아가라」가 곧
   * 목표라 표시가 안내 역할을 한다. 규칙은 `tutorial/parts/Gates` 하나가 갖고 여기서는 묻기만 한다;
   * 튜토리얼이 아니면 언제나 false 라 평소 지도는 한 글자도 바뀌지 않는다.
   */
  private hidesShip(): boolean {
    return this.ctx?.tutorial?.hides('hud', 'shipMarker') ?? false;
  }

  /* ── 범례 ──────────────────────────────────────────────────────────────── */

  /**
   * 범례 줄 보이기 · 견본 다시 그리기 (지도를 열 때 · 새 월드). 분대원은 멀티에서만, 선로 · 전차는 선로가 있을 때만,
   * 탐사 차량 두 줄은 차량이 있을 때만. 분대원 견본은 실제 분대원의 슬롯 색을 쓴다.
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
    for (const lr of this.legendRows) {
      const show = lr.id === 'squad' ? multi : lr.id === 'rail' || lr.id === 'tram' ? hasRail : lr.id === 'rover' || lr.id === 'route' ? hasRover : lr.id === 'ship' ? !hideShip : true;
      lr.row.hidden = !show;
      if (show) this.drawSwatch(lr, squadCol);
    }
  }

  /** 범례 견본 한 칸 — 지도와 **같은 그리기 함수**를 같은 크기로 부른다. */
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
      // 화살표는 앞 끝과 뒤 끝의 가운데가 견본 가운데에 오게 민다
      case 'player': drawPlayerArrow(c, cx - 1.5 * k, cy, 0); break;
      case 'squad': drawSquadArrow(c, cx - 1 * k, cy, 0, squadCol); break;
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
