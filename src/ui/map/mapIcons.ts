/**
 * src/ui/map/mapIcons.ts — 전술 지도 마커를 **그리는 함수**와 라벨 층 (2026-09-13).
 *
 * 지도(`MapScreen.draw`)와 좌측 범례의 견본 캔버스가 **같은 함수**를 부른다 — 범례에 그려진 아이콘이 곧 지도에 그려지는
 * 아이콘이다 (사용자 결정: 「플레이어 · 분대원이 월드맵에 표시되는 것과 범례 아이콘이 정확히 같아야」). 예전에는 범례가 CSS 삼각형
 * (`.sw.player`)이라 지도의 노치 화살표 · 윤곽선 · 크기와 달랐다. 크기를 바꿀 때는 `MARKER_SCALE` 한 곳만 고친다.
 *
 * 함수는 전부 캔버스 좌표 (CSS px) 기준이고 상태가 없다. `MapLabels` 는 프레임마다 라벨을 모아 **겹치면 우선순위가 낮은 것을
 * 버리고** 어두운 윤곽을 둘러 그린다 — 줌을 뺀 지도에서 구조물 · 둥지 · 정류장 이름이 겹쳐 읽히지 않던 것을 막는다.
 */

/** 지도 색 (Canvas 는 CSS 변수를 못 읽어 `base.css` 의 값을 옮겨 적는다). */
export const MAP_COL = {
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
  /* appended (2026-09-09): 레이드 플레이 개선 — 구조물 · 선로 · 전차 · 환경 재해 */
  structure: '#d8c48a',
  rail: '#9fb4c7',
  tram: '#ffd27f',
  grove: '#b98cff',
  /* appended (2026-09-11, C-11): 폐허 전초 (POI) — 구조물(모래색)보다 낮은 채도의 콘크리트 색 */
  outpost: '#a9a59a',
  /* appended (2026-09-13): 탐사 차량 — 흙길(황갈색 점선) · 정류장 · 차체(올리브) */
  route: '#c9a06a',
  station: '#e6c48a',
  rover: '#a9c96c',
};

/** 캔버스 라벨 글꼴 (base.css 의 스택을 옮겨 적는다). */
export const FONT_LABEL = "600 10px 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', sans-serif";

/**
 * 플레이어 · 분대원 화살표의 배율 (2026-09-13 사용자 결정: 더 크게 — 1.6배). 화살표 좌표는 예전 값 × 이 배율이다.
 */
export const MARKER_SCALE = 1.6;

const OUTLINE = 'rgba(0,0,0,0.7)';

/** 노치 화살표 한 개 (`tip` 앞 끝, `back` 뒤 끝 x, `half` 날개 반폭, `notch` 홈 x). `ang` = 캔버스 회전 (0 = 오른쪽). */
function notchedArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color: string,
  tip: number, back: number, half: number, notch: number): void {
  c.save();
  c.translate(x, y); c.rotate(ang);
  c.fillStyle = color; c.strokeStyle = OUTLINE; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(tip, 0); c.lineTo(back, half); c.lineTo(notch, 0); c.lineTo(back, -half); c.closePath();
  c.fill(); c.stroke();
  c.restore();
}

/** 로컬 플레이어 화살표 (호박색). 시야 원추는 `drawPlayerCone` 이 따로 — 범례 견본에는 원추가 들어갈 자리가 없다. */
export function drawPlayerArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color = MAP_COL.accent): void {
  const k = MARKER_SCALE;
  notchedArrow(c, x, y, ang, color, 9 * k, -6 * k, 5.5 * k, -3 * k);
}

/** 로컬 플레이어의 시야 원추 (화살표 밑에 먼저 그린다). */
export function drawPlayerCone(c: CanvasRenderingContext2D, x: number, y: number, ang: number): void {
  const r = 40 * MARKER_SCALE;
  c.save();
  c.translate(x, y); c.rotate(ang);
  const cone = c.createRadialGradient(0, 0, 0, 0, 0, r);
  cone.addColorStop(0, 'rgba(255,179,71,0.30)');
  cone.addColorStop(1, 'rgba(255,179,71,0)');
  c.fillStyle = cone;
  c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, r, -0.55, 0.55); c.closePath(); c.fill();
  c.restore();
}

/** 분대원 화살표 (슬롯 색). 플레이어보다 한 치수 작다. */
export function drawSquadArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color: string): void {
  const k = MARKER_SCALE;
  notchedArrow(c, x, y, ang, color, 7 * k, -5 * k, 4.5 * k, -2.5 * k);
}

/**
 * 2026-09-15 (안드로이드 분대원): 안드로이드 화살표 — 분대원 화살표와 **같은 크기, 다른 실루엣**이다. 속이 빈
 * 삼각형에 가운데 점 하나: 한눈에 「사람이 아닌 분대원」으로 읽히면서 슬롯 색은 그대로 쓴다.
 */
export function drawAllyArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color: string): void {
  const k = MARKER_SCALE;
  c.save();
  c.translate(x, y); c.rotate(ang);
  c.strokeStyle = OUTLINE; c.lineWidth = 2.6;
  c.beginPath(); c.moveTo(7 * k, 0); c.lineTo(-5 * k, 4.5 * k); c.lineTo(-2.5 * k, 0); c.lineTo(-5 * k, -4.5 * k); c.closePath();
  c.stroke();
  c.strokeStyle = color; c.lineWidth = 1.4;
  c.stroke();
  c.fillStyle = color;
  c.beginPath(); c.arc(0, 0, 1.3 * k, 0, Math.PI * 2); c.fill();
  c.restore();
}

/** 2026-09-15: 쓰러진 · 파괴된 안드로이드 — 빈 사각형 + X. */
export function drawAllyDown(c: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const k = MARKER_SCALE;
  c.strokeStyle = color; c.lineWidth = 1.6;
  c.strokeRect(x - 4 * k, y - 4 * k, 8 * k, 8 * k);
  c.beginPath();
  c.moveTo(x - 2.5 * k, y - 2.5 * k); c.lineTo(x + 2.5 * k, y + 2.5 * k);
  c.moveTo(x + 2.5 * k, y - 2.5 * k); c.lineTo(x - 2.5 * k, y + 2.5 * k);
  c.stroke();
}

/** 전사한 분대원: 빈 원 + X (배율 적용). */
export function drawSquadDead(c: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const k = MARKER_SCALE;
  c.strokeStyle = color; c.lineWidth = 1.6;
  c.beginPath(); c.arc(x, y, 5 * k, 0, Math.PI * 2); c.stroke();
  c.beginPath();
  c.moveTo(x - 3 * k, y - 3 * k); c.lineTo(x + 3 * k, y + 3 * k);
  c.moveTo(x + 3 * k, y - 3 * k); c.lineTo(x - 3 * k, y + 3 * k);
  c.stroke();
}

/** 마름모 (탈출 지점 · 핑). */
export function drawDiamond(c: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, fill = 'rgba(0,0,0,0.5)'): void {
  c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath();
  c.fillStyle = fill; c.fill();
  c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
}

/** 탈출 지점 마름모. `active` 는 호박색 · 조금 크게 (펄스 링은 지도가 따로 그린다 — 범례는 한 줄뿐이다). */
export function drawPad(c: CanvasRenderingContext2D, x: number, y: number, active = false): void {
  drawDiamond(c, x, y, active ? 8 : 6, active ? MAP_COL.accent : MAP_COL.pad, active ? 'rgba(255,179,71,0.45)' : 'rgba(0,0,0,0.5)');
}

/** 착륙한 탈출 함선: 초록 원 + 어두운 삼각. */
export function drawShip(c: CanvasRenderingContext2D, x: number, y: number): void {
  c.fillStyle = MAP_COL.success;
  c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill();
  c.fillStyle = MAP_COL.bg;
  c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x + 3.5, y + 3); c.lineTo(x - 3.5, y + 3); c.closePath(); c.fill();
}

/** 약초 채집물: 작은 십자. */
export function drawGatherCross(c: CanvasRenderingContext2D, x: number, y: number, color = MAP_COL.gather): void {
  c.strokeStyle = color; c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(x - 3, y); c.lineTo(x + 3, y);
  c.moveTo(x, y - 3); c.lineTo(x, y + 3);
  c.stroke();
}

/** 선로 중심선 스타일 (점선 · 파랑회색). 경로를 만든 뒤 부른다 — `stroke` 까지 한다. */
export function strokeRail(c: CanvasRenderingContext2D): void {
  c.strokeStyle = MAP_COL.rail; c.lineWidth = 1.4;
  c.setLineDash([5, 3]);
  c.stroke();
  c.setLineDash([]);
}

/** 선로 플랫폼: 작은 사각 테두리. */
export function drawPlatform(c: CanvasRenderingContext2D, x: number, y: number): void {
  c.strokeStyle = MAP_COL.rail; c.lineWidth = 1.4;
  c.strokeRect(x - 4, y - 2.5, 8, 5);
}

/**
 * 전차: `yaw` 로 돈 12×6 사각. 서 있으면 흐리다.
 *
 * 2026-09-18 — **부호는 `+yaw` 다** (`-yaw` 였다). 지도는 `toX(x)` · `toY(z)` 라 **캔버스 y = 월드 +Z** 이고
 * (`MapScreen.toX/toY`, 뒤집지 않는다), 전차 · 탐사 차량의 `yaw` 는 수학 규약(로컬 +X → 월드 `(cos, sin)`,
 * `rails/model` 의 축 규약)이다. 그래서 화면 각도가 곧 `yaw` 다 — `c.rotate(-yaw)` 는 진행 방향을 z 축으로
 * 뒤집어 비춘다. 전차 사각은 대칭이라 눈에 안 띄었고 `drawRover` 에서 드러났다 (사용자 보고).
 * 3인칭 몸(플레이어 · 분대원)은 전방이 `(-sin, -cos)` 인 **다른 규약**이라 호출 쪽에서 각도로 바꿔 넘긴다
 * (`MapScreen` 의 `Math.atan2(-Math.cos(yaw), -Math.sin(yaw))`) — 이 함수들과 섞지 않는다.
 */
export function drawTram(c: CanvasRenderingContext2D, x: number, y: number, yaw: number, moving: boolean): void {
  c.save();
  c.translate(x, y); c.rotate(yaw);
  c.fillStyle = moving ? MAP_COL.tram : 'rgba(255,210,127,0.5)';
  c.strokeStyle = OUTLINE; c.lineWidth = 1;
  c.beginPath(); c.rect(-6, -3, 12, 6); c.fill(); c.stroke();
  c.restore();
}

/**
 * 탐사 차량 흙길 스타일 (황갈색 **둥근 점선** + 어두운 밑선) — 선로의 긴 점선과 한눈에 갈린다. 경로를 만든 뒤 부른다.
 */
export function strokeRoute(c: CanvasRenderingContext2D): void {
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = 'rgba(12,8,4,0.7)'; c.lineWidth = 3.6;
  c.stroke();
  c.strokeStyle = MAP_COL.route; c.lineWidth = 2;
  c.setLineDash([0.1, 4.2]);
  c.stroke();
  c.restore();
}

export interface StationDrawOpts {
  /** 재해에 잡아먹혔다 — 붉은 빛깔. */
  swallowed?: boolean;
  /** 목적지로 고를 수 없다 (선택 모드) — 흐리게. */
  disabled?: boolean;
  /** 선택 모드의 강조 링: `hover` 흰색 · `selected` 호박색 · `current` 초록. */
  ring?: 'hover' | 'selected' | 'current' | null;
}

/** 탐사 차량 정류장: 표지 기둥을 닮은 원판 + 가운데 기둥 점. */
export function drawStation(c: CanvasRenderingContext2D, x: number, y: number, o: StationDrawOpts = {}): void {
  const col = o.swallowed ? MAP_COL.danger : MAP_COL.station;
  c.save();
  if (o.disabled) c.globalAlpha *= 0.45;
  if (o.ring) {
    c.strokeStyle = o.ring === 'selected' ? MAP_COL.accent : o.ring === 'current' ? MAP_COL.success : 'rgba(232,230,225,0.85)';
    c.lineWidth = 2;
    c.beginPath(); c.arc(x, y, 10, 0, Math.PI * 2); c.stroke();
  }
  c.fillStyle = o.swallowed ? 'rgba(255,77,77,0.35)' : 'rgba(20,14,6,0.75)';
  c.strokeStyle = col; c.lineWidth = 1.6;
  c.beginPath(); c.arc(x, y, 5.5, 0, Math.PI * 2); c.fill(); c.stroke();
  c.fillStyle = col;
  c.fillRect(x - 1, y - 3.5, 2, 7);
  c.restore();
}

/**
 * 탐사 차량: `yaw` 로 돈 장갑차 윤곽 (각진 차체 + 포탑 원 + 앞으로 뻗은 포신). 전차의 납작한 사각과 다르게 읽힌다.
 * `destroyed` 면 흐리고 붉은 X.
 *
 * 2026-09-18 — 부호가 `+yaw` 인 이유는 `drawTram` 머리 주석에 있다 (캔버스 y = 월드 +Z, `yaw` 는 수학 규약).
 * 이 아이콘은 앞이 깎인 비대칭 윤곽이라 뒤집힌 부호가 「지도에서 이동 방향으로 안 돈다」로 보였다 (사용자 보고).
 */
export function drawRover(c: CanvasRenderingContext2D, x: number, y: number, yaw: number, destroyed = false): void {
  c.save();
  c.translate(x, y); c.rotate(yaw);
  if (destroyed) c.globalAlpha *= 0.5;
  c.fillStyle = MAP_COL.rover; c.strokeStyle = OUTLINE; c.lineWidth = 1.2;
  // 앞(+x)이 깎인 차체
  c.beginPath();
  c.moveTo(8, -3); c.lineTo(9.5, 0); c.lineTo(8, 3); c.lineTo(8, 4.5); c.lineTo(-8, 4.5); c.lineTo(-8, -4.5); c.lineTo(8, -4.5); c.closePath();
  c.fill(); c.stroke();
  // 포신 + 포탑
  c.strokeStyle = 'rgba(20,24,12,0.95)'; c.lineWidth = 1.6;
  c.beginPath(); c.moveTo(0, 0); c.lineTo(12, 0); c.stroke();
  c.fillStyle = 'rgba(40,48,24,0.95)';
  c.beginPath(); c.arc(-0.5, 0, 2.6, 0, Math.PI * 2); c.fill();
  c.restore();
  if (destroyed) {
    c.strokeStyle = MAP_COL.danger; c.lineWidth = 1.8;
    c.beginPath(); c.moveTo(x - 5, y - 5); c.lineTo(x + 5, y + 5); c.moveTo(x + 5, y - 5); c.lineTo(x - 5, y + 5); c.stroke();
  }
}

/** 위험 구역 견본 (지도의 채움 + 경계선과 같은 색). */
export function drawHazardSwatch(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  c.fillStyle = 'rgba(255, 77, 77, 0.26)';
  c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(255, 122, 70, 0.95)'; c.lineWidth = 1.4;
  c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** 라벨 한 줄을 어두운 윤곽과 함께 그린다 (밝은 지형 위에서도 읽힌다). */
export function drawLabel(c: CanvasRenderingContext2D, text: string, x: number, y: number, color: string,
  baseline: CanvasTextBaseline = 'top', align: CanvasTextAlign = 'center'): void {
  c.font = FONT_LABEL;
  c.textAlign = align; c.textBaseline = baseline;
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(4,6,8,0.88)'; c.lineWidth = 3;
  c.strokeText(text, x, y);
  c.fillStyle = color;
  c.fillText(text, x, y);
}

interface LabelEntry { text: string; x: number; y: number; color: string; prio: number }
const byPrio = (a: LabelEntry, b: LabelEntry): number => a.prio - b.prio;

/**
 * 지형지물 라벨 층. 프레임마다 `add` 로 모으고 `flush` 가 우선순위(작을수록 먼저) 순으로 그리되 **이미 그린 라벨과 겹치는 것은
 * 버린다** — 줌을 뺀 지도의 라벨 겹침 방지. 항목 객체는 풀에서 재사용한다.
 */
export class MapLabels {
  private pool: LabelEntry[] = [];
  private live: LabelEntry[] = [];
  private rects: number[] = [];

  add(text: string, x: number, y: number, color: string, prio: number): void {
    const e = this.pool.pop() ?? { text: '', x: 0, y: 0, color: '', prio: 0 };
    e.text = text; e.x = x; e.y = y; e.color = color; e.prio = prio;
    this.live.push(e);
  }

  /** `y` 는 라벨 **윗변**(baseline top) 기준이다. */
  flush(c: CanvasRenderingContext2D): void {
    const live = this.live;
    live.sort(byPrio);
    const rects = this.rects;
    rects.length = 0;
    c.font = FONT_LABEL;
    for (const e of live) {
      const w = c.measureText(e.text).width + 4;
      const h = 13;
      const x0 = e.x - w / 2, y0 = e.y - 1;
      let hit = false;
      for (let i = 0; i < rects.length && !hit; i += 4) {
        if (x0 < rects[i + 2] && x0 + w > rects[i] && y0 < rects[i + 3] && y0 + h > rects[i + 1]) hit = true;
      }
      if (hit) continue;
      rects.push(x0, y0, x0 + w, y0 + h);
      drawLabel(c, e.text, e.x, e.y, e.color);
    }
    for (const e of live) this.pool.push(e);
    live.length = 0;
  }
}
