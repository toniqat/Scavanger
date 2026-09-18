/**
 * src/ui/map/mapIcons.ts — the **painter functions** for tactical map markers, plus the label layer (2026-09-13).
 *
 * The map (`MapScreen.draw`) and the sample canvases of the left legend call the **same functions** — the icon
 * drawn in the legend is the icon drawn on the map (user's decision: 「the legend icon must be exactly what the
 * player · squadmates look like on the world map」). The legend used to be a CSS triangle (`.sw.player`), so it
 * differed from the map's notched arrow · outline · size. To change a size, edit `MARKER_SCALE` in that one place.
 *
 * Every function works in canvas coordinates (CSS px) and holds no state. `MapLabels` collects the labels each
 * frame and, **dropping the lower-priority one where two overlap**, draws them with a dark outline — it keeps the
 * structure · nest · station names from overlapping into something unreadable on a zoomed-out map.
 */

/** Map colours (a canvas cannot read CSS variables, so the values of `base.css` are copied here). */
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
  /* appended (2026-09-09): raid play improvements — structure · rail · tram · environmental hazard */
  structure: '#d8c48a',
  rail: '#9fb4c7',
  tram: '#ffd27f',
  grove: '#b98cff',
  /* appended (2026-09-11, C-11): ruined outpost (POI) — a concrete colour less saturated than the structure sand */
  outpost: '#a9a59a',
  /* appended (2026-09-13): the rover — dirt road (tan dashes) · station · body (olive) */
  route: '#c9a06a',
  station: '#e6c48a',
  rover: '#a9c96c',
};

/** Canvas label font (the stack of base.css copied here). */
export const FONT_LABEL = "600 10px 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', sans-serif";

/**
 * Scale of the player · squadmate arrows (2026-09-13 user's decision: bigger — ×1.6). The arrow coordinates are
 * the old values × this scale.
 */
export const MARKER_SCALE = 1.6;

const OUTLINE = 'rgba(0,0,0,0.7)';

/** One notched arrow (`tip` front end, `back` rear x, `half` wing half-width, `notch` notch x). `ang` = canvas rotation (0 = right). */
function notchedArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color: string,
  tip: number, back: number, half: number, notch: number): void {
  c.save();
  c.translate(x, y); c.rotate(ang);
  c.fillStyle = color; c.strokeStyle = OUTLINE; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(tip, 0); c.lineTo(back, half); c.lineTo(notch, 0); c.lineTo(back, -half); c.closePath();
  c.fill(); c.stroke();
  c.restore();
}

/** The local player's arrow (amber). The view cone is separate in `drawPlayerCone` — a legend sample has no room for one. */
export function drawPlayerArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color = MAP_COL.accent): void {
  const k = MARKER_SCALE;
  notchedArrow(c, x, y, ang, color, 9 * k, -6 * k, 5.5 * k, -3 * k);
}

/** The local player's view cone (drawn first, under the arrow). */
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

/** Squadmate arrow (slot colour). One size smaller than the player's. */
export function drawSquadArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, color: string): void {
  const k = MARKER_SCALE;
  notchedArrow(c, x, y, ang, color, 7 * k, -5 * k, 4.5 * k, -2.5 * k);
}

/**
 * 2026-09-15 (android squadmates): the android arrow — **the same size as the squadmate arrow, a different
 * silhouette**. A hollow triangle with one dot in the middle: it reads at a glance as 「a squadmate who is not a
 * person」 while keeping the slot colour.
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

/** 2026-09-15: a downed · destroyed android — an empty square + X. */
export function drawAllyDown(c: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const k = MARKER_SCALE;
  c.strokeStyle = color; c.lineWidth = 1.6;
  c.strokeRect(x - 4 * k, y - 4 * k, 8 * k, 8 * k);
  c.beginPath();
  c.moveTo(x - 2.5 * k, y - 2.5 * k); c.lineTo(x + 2.5 * k, y + 2.5 * k);
  c.moveTo(x + 2.5 * k, y - 2.5 * k); c.lineTo(x - 2.5 * k, y + 2.5 * k);
  c.stroke();
}

/** A squadmate killed in action: an empty circle + X (scaled). */
export function drawSquadDead(c: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  const k = MARKER_SCALE;
  c.strokeStyle = color; c.lineWidth = 1.6;
  c.beginPath(); c.arc(x, y, 5 * k, 0, Math.PI * 2); c.stroke();
  c.beginPath();
  c.moveTo(x - 3 * k, y - 3 * k); c.lineTo(x + 3 * k, y + 3 * k);
  c.moveTo(x + 3 * k, y - 3 * k); c.lineTo(x - 3 * k, y + 3 * k);
  c.stroke();
}

/** Diamond (extraction point · ping). */
export function drawDiamond(c: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, fill = 'rgba(0,0,0,0.5)'): void {
  c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath();
  c.fillStyle = fill; c.fill();
  c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
}

/** Extraction point diamond. `active` is amber · a little bigger (the pulse ring is drawn by the map — the legend is one row). */
export function drawPad(c: CanvasRenderingContext2D, x: number, y: number, active = false): void {
  drawDiamond(c, x, y, active ? 8 : 6, active ? MAP_COL.accent : MAP_COL.pad, active ? 'rgba(255,179,71,0.45)' : 'rgba(0,0,0,0.5)');
}

/** The landed extraction ship: a green circle + a dark triangle. */
export function drawShip(c: CanvasRenderingContext2D, x: number, y: number): void {
  c.fillStyle = MAP_COL.success;
  c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2); c.fill();
  c.fillStyle = MAP_COL.bg;
  c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x + 3.5, y + 3); c.lineTo(x - 3.5, y + 3); c.closePath(); c.fill();
}

/** Herb gather node: a small cross. */
export function drawGatherCross(c: CanvasRenderingContext2D, x: number, y: number, color = MAP_COL.gather): void {
  c.strokeStyle = color; c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(x - 3, y); c.lineTo(x + 3, y);
  c.moveTo(x, y - 3); c.lineTo(x, y + 3);
  c.stroke();
}

/** Rail centre-line style (dashed · blue-grey). Called after the path is built — it does the `stroke` too. */
export function strokeRail(c: CanvasRenderingContext2D): void {
  c.strokeStyle = MAP_COL.rail; c.lineWidth = 1.4;
  c.setLineDash([5, 3]);
  c.stroke();
  c.setLineDash([]);
}

/** Rail platform: a small square outline. */
export function drawPlatform(c: CanvasRenderingContext2D, x: number, y: number): void {
  c.strokeStyle = MAP_COL.rail; c.lineWidth = 1.4;
  c.strokeRect(x - 4, y - 2.5, 8, 5);
}

/**
 * The tram: a 12×6 rectangle rotated by `yaw`. Dimmed while it stands still.
 *
 * 2026-09-18 — **the sign is `+yaw`** (it was `-yaw`). The map is `toX(x)` · `toY(z)`, so **canvas y = world +Z**
 * (`MapScreen.toX/toY`, never flipped), and the `yaw` of the tram · rover is the math convention (local +X → world
 * `(cos, sin)`, the axis convention of `rails/model`). The screen angle is therefore `yaw` itself — `c.rotate(-yaw)`
 * mirrors the travel direction across the z axis. The tram rectangle is symmetric, so it went unnoticed; it came
 * out in `drawRover` (user's report). A third-person body (the player · squadmates), whose forward is
 * `(-sin, -cos)`, is a **different convention** and is converted to an angle at the call site
 * (`Math.atan2(-Math.cos(yaw), -Math.sin(yaw))` in `MapScreen`) — never mixed with these functions.
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
 * Rover dirt-road style (tan **round dots** + a dark underline) — at a glance it differs from the rail's long
 * dashes. Called after the path is built.
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
  /** Swallowed by a hazard — a red tint. */
  swallowed?: boolean;
  /** Cannot be picked as a destination (selection mode) — dimmed. */
  disabled?: boolean;
  /** Highlight ring in selection mode: `hover` white · `selected` amber · `current` green. */
  ring?: 'hover' | 'selected' | 'current' | null;
}

/** Rover station: a disc shaped like a sign post + a post dot in the middle. */
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
 * The rover: an armoured-car outline rotated by `yaw` (an angular body + a turret circle + a gun barrel reaching
 * forward). It reads differently from the tram's flat rectangle. `destroyed` dims it and adds a red X.
 *
 * 2026-09-18 — why the sign is `+yaw` is in the head comment of `drawTram` (canvas y = world +Z, `yaw` is the math
 * convention). This icon is an asymmetric outline with a cut-off front, so the flipped sign read as 「it does not
 * turn toward the travel direction on the map」 (user's report).
 */
export function drawRover(c: CanvasRenderingContext2D, x: number, y: number, yaw: number, destroyed = false): void {
  c.save();
  c.translate(x, y); c.rotate(yaw);
  if (destroyed) c.globalAlpha *= 0.5;
  c.fillStyle = MAP_COL.rover; c.strokeStyle = OUTLINE; c.lineWidth = 1.2;
  // body with a cut-off front (+x)
  c.beginPath();
  c.moveTo(8, -3); c.lineTo(9.5, 0); c.lineTo(8, 3); c.lineTo(8, 4.5); c.lineTo(-8, 4.5); c.lineTo(-8, -4.5); c.lineTo(8, -4.5); c.closePath();
  c.fill(); c.stroke();
  // gun barrel + turret
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

/** Hazard zone sample (the same colours as the map's fill + border). */
export function drawHazardSwatch(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  c.fillStyle = 'rgba(255, 77, 77, 0.26)';
  c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(255, 122, 70, 0.95)'; c.lineWidth = 1.4;
  c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** Draws one label line with a dark outline (readable on bright terrain too). */
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
 * Landmark label layer. Labels are collected each frame with `add`, and `flush` draws them in priority order
 * (smaller first) but **drops any that overlaps a label already drawn** — it prevents label overlap on a
 * zoomed-out map. The entry objects are reused from a pool.
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

  /** `y` is measured from the label's **top edge** (baseline top). */
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
