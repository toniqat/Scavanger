import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Layers, Random, TRAINING_ARENA_SIZE, TRAINING_TARGET_COUNT, TRAINING_TARGET_HP, TRAINING_TARGET_RESPAWN_S,
  TRAINING_MOVING_SPAN, TRAINING_MOVING_SPEED, TRAINING_MOVING_PAUSE_S,
  TRAINING_COURSE_TARGETS, TRAINING_COURSE_TIME_S, TRAINING_COURSE_COOLDOWN_S, TRAINING_BEST_STORAGE_KEY, slotKey,
  TRAINING_MODES, TRAINING_MODE_LABEL_KO,
  type DestructibleRef, type GameContext, type TrainingMode, type TrainingRef,
} from '@/shared';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';

/* ────────────────────────────────────────────────────────────────────────────
 * 시뮬레이션 훈련장 (Phase 7): a flat, open-topped arena that replaces the planet when `game:newMission` carries
 * `mode: 'training'`. Three lanes of pop-up targets (destructible obstacles in the world's spatial hash, so the
 * weapon folder's ordinary `raycast → obstacle.destructible.onDamage` path scores hits), an exit console
 * (`Interactable 'training_exit'` → `training:exitRequested`), no crates / nests / gather / extraction.
 * Everything is procedural: CanvasTextures for the floor grid, the target boards, the console screens and the horizon;
 * emissive strips for the lighting feel (no lights — the arena is rendered in the atmosphere's space mode).
 *
 * 2026-09-15 (사용자 결정 — 천장이 로켓 점프를 막았다): **no ceiling and no wall meshes.** The four walls are invisible:
 * `clampInside` (through `WorldRef.resolveCollision`) clamps X/Z at any height, so walking, jumping, rocket jumps, dashes,
 * thrown grenades / gadgets, dropped items and drones all stay inside however high they go. Rays (bullets, the aim line,
 * the camera, the player's ceiling probe) do **not** see the walls: a shot through the boundary flies on and either lands
 * on the apron (the deck drawn past the boundary, which `raycastShell` still treats as floor) or expires silently at its
 * range — there is nothing in mid-air to spark on. The limit is drawn on the floor instead: a cyan boundary line with
 * corner brackets, the deck fading to black beyond it, and a faint simulation horizon ring far out.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Half side of the arena — where the invisible wall stands. */
export const ARENA_HALF = TRAINING_ARENA_SIZE / 2;
/** Deck drawn past the invisible wall (m); it fades to the void and still counts as floor for rays. */
const APRON = 40;
/** Floor-plane reach of `raycastShell` = the drawn deck including the apron. */
const FLOOR_REACH = ARENA_HALF + APRON;
/** Apron fade bands and the brightness of its inner edge (drawn unlit, tuned to sit just under the lit deck). */
const APRON_RINGS = 12;
const APRON_INNER = 0.5;
/** Simulation horizon: an additive open cylinder far outside the arena (radius, bottom, top — m). */
const HORIZON_R = 340, HORIZON_Y0 = -90, HORIZON_Y1 = 150;
/** Lane centres (x) and the lane half width. */
const LANES_X: readonly number[] = [-10, 0, 10];
const LANE_HALF_W = 4;
/** The firing line (amber strip) and the spawn just behind it, both toward +Z ("south"); the player faces −Z. */
const FIRING_LINE_Z = ARENA_HALF - 12;
const SPAWN_Z = ARENA_HALF - 6;
/** Exit console against the south wall, west of the spawn; the mode console and the weapon rack east of it (Phase 9). */
const EXIT_X = -8, EXIT_Z = ARENA_HALF - 2.4;
const MODE_X = 8, RACK_X = 14;
const TARGET_RADIUS = 0.42;
const TARGET_HEIGHT = 2.1;
const HINGE_Y = 0.95;
const BOARD_W = 0.72, BOARD_H = 1.15;
const KNOCK_TIME = 0.28;
const RAISE_TIME = 0.4;
const FLASH_DECAY = 6;
/** Resting emissive of a target board (readable at 40 m); a hit flashes on top of it. */
const BOARD_GLOW = 0.35;
const FX_POOL = 10;
const OBJECTIVE_TEXT = '시뮬레이션 훈련장 · 출구 콘솔로 종료';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

interface Target {
  index: number;
  lane: number;
  entry: ObstacleEntry;
  destructible: DestructibleRef & { hp: number };
  root: THREE.Group;
  board: THREE.Group;
  boardMat: THREE.MeshStandardMaterial;
  /** 0 = standing, 1 = flat on the floor. */
  pose: number;
  down: boolean;
  respawnAt: number;
  flash: number;
  inHash: boolean;
  /** Resting x (static / timed modes). 이동 표적 sweeps about the lane centre instead so it never leaves the lane. */
  baseX: number;
  /** 이동 표적 state: offset from the lane centre, direction and the end-of-sweep pause. */
  mvOffset: number;
  mvDir: number;
  mvPauseUntil: number;
}

/** Persisted best timed-course time (`TRAINING_BEST_STORAGE_KEY`). */
interface BestRecord { best: number }

function loadBest(): number | null {
  try {
    const raw = localStorage.getItem(slotKey(TRAINING_BEST_STORAGE_KEY));
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<BestRecord>;
    return typeof rec.best === 'number' && Number.isFinite(rec.best) && rec.best > 0 ? rec.best : null;
  } catch { return null; }
}

function saveBest(best: number): void {
  try { localStorage.setItem(slotKey(TRAINING_BEST_STORAGE_KEY), JSON.stringify({ best } satisfies BestRecord)); } catch { /* storage unavailable */ }
}

interface Fx { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; ttl: number; grow: number }

function placed(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  _q.setFromEuler(new THREE.Euler(rx, ry, rz));
  _v.set(x, y, z);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  return placed(new THREE.BoxGeometry(w, h, d), x, y, z, 0, ry, 0);
}

/** Merge a list of placed geometries into one mesh (inputs disposed). */
function mergedMesh(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): THREE.Mesh | null {
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/* ── procedural textures ──────────────────────────────────────────────────── */

function floorTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2e353d'; g.fillRect(0, 0, S, S);
  // panel seams
  g.strokeStyle = '#1a1f25'; g.lineWidth = 6;
  g.strokeRect(3, 3, S - 6, S - 6);
  g.strokeStyle = '#3c454f'; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(i * S / 4, 0); g.lineTo(i * S / 4, S); g.stroke(); g.beginPath(); g.moveTo(0, i * S / 4); g.lineTo(S, i * S / 4); g.stroke(); }
  // faint cyan grid dots
  g.fillStyle = 'rgba(120,200,230,0.4)';
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) g.fillRect(x * S / 4 + S / 8 - 1, y * S / 4 + S / 8 - 1, 3, 3);
  // wear
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let i = 0; i < 26; i++) g.fillRect((i * 97) % S, (i * 53) % S, 10 + (i * 7) % 24, 3 + (i * 5) % 9);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(TRAINING_ARENA_SIZE / 4, TRAINING_ARENA_SIZE / 4);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Humanoid silhouette + scoring rings on a pale board. */
function boardTexture(): THREE.CanvasTexture {
  const W = 128, H = 204;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e6e1cf'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#9a9483'; g.lineWidth = 3; g.strokeRect(2, 2, W - 4, H - 4);
  // silhouette
  g.fillStyle = '#2c3138';
  g.beginPath(); g.arc(W / 2, 34, 18, 0, Math.PI * 2); g.fill();                // head
  g.beginPath();                                                                 // torso
  g.moveTo(W / 2 - 34, 62); g.lineTo(W / 2 + 34, 62); g.lineTo(W / 2 + 30, 150); g.lineTo(W / 2 - 30, 150); g.closePath(); g.fill();
  g.fillRect(W / 2 - 44, 66, 12, 70); g.fillRect(W / 2 + 32, 66, 12, 70);        // arms
  g.fillRect(W / 2 - 26, 150, 20, 46); g.fillRect(W / 2 + 6, 150, 20, 46);       // legs
  // rings on the chest
  g.strokeStyle = '#d63a2a'; g.lineWidth = 3;
  for (const r of [22, 14, 6]) { g.beginPath(); g.arc(W / 2, 100, r, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = '#d63a2a'; g.beginPath(); g.arc(W / 2, 100, 3, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 2026-09-15: the deck past the invisible wall — a square annulus from `inner` to `outer` in `rings` bands. UVs continue the
 * main floor's (same texture, same 4 m tiles); vertex colours fade it quadratically to black. Drawn unlit so its far edge
 * meets the space-mode background with no seam (a lit albedo never quite reaches black).
 */
function apronGeometry(inner: number, outer: number, rings: number, innerBrightness: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const corners: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const s = inner + (outer - inner) * t;
    const b = innerBrightness * (1 - t) * (1 - t);
    for (const [cx, cz] of corners) {
      const x = cx * s, z = cz * s;
      pos.push(x, 0, z);
      // the floor PlaneGeometry (rotated −π/2 about X): u = (x + H) / size, v = (H − z) / size, repeat = size / 4
      uv.push((x + ARENA_HALF) / TRAINING_ARENA_SIZE, (ARENA_HALF - z) / TRAINING_ARENA_SIZE);
      col.push(b, b, b);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < 4; c++) {
      const a = r * 4 + c, b = r * 4 + ((c + 1) % 4);
      idx.push(a, b, a + 4, b, b + 4, a + 4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 2026-09-15: the simulation horizon — a thin cyan line at world y 0 with a haze above it and a faint grid, on black.
 * Drawn additive, so black texels add nothing. Canvas top = cylinder top (`HORIZON_Y1`).
 */
function horizonTexture(): THREE.CanvasTexture {
  const W = 512, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const hz = HORIZON_Y1 / (HORIZON_Y1 - HORIZON_Y0);   // canvas row fraction of world y 0
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#000000');
  grad.addColorStop(hz - 0.3, '#010407');
  grad.addColorStop(hz - 0.06, '#071b26');
  grad.addColorStop(hz - 0.008, '#1f5a74');
  grad.addColorStop(hz, '#4fa6c8');
  grad.addColorStop(hz + 0.02, '#081b24');
  grad.addColorStop(hz + 0.1, '#000000');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const row = Math.round(hz * H);
  // grid above the horizon: vertical lines fading upward, horizontal lines spreading out with height
  const vgrad = g.createLinearGradient(0, 0, 0, row);
  vgrad.addColorStop(0, 'rgba(70,160,200,0)');
  vgrad.addColorStop(1, 'rgba(70,160,200,0.22)');
  g.fillStyle = vgrad;
  for (let x = 0; x < W; x += 32) g.fillRect(x, 0, 1, row);
  for (const [dy, a] of [[5, 0.2], [12, 0.15], [22, 0.11], [36, 0.08], [56, 0.05], [84, 0.03]] as const) {
    g.fillStyle = `rgba(70,160,200,${a})`; g.fillRect(0, row - dy, W, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** (Re)draw a console screen; `screenTexture` wraps a fresh canvas, `redrawScreen` repaints an existing texture in place. */
function drawScreen(c: HTMLCanvasElement, lines: string[], accent: string): void {
  const W = c.width, H = c.height;
  const g = c.getContext('2d')!;
  g.textAlign = 'left';
  g.fillStyle = '#06141a'; g.fillRect(0, 0, W, H);
  g.fillStyle = accent; g.fillRect(0, 0, W, 22);
  g.fillStyle = '#06141a'; g.font = 'bold 15px sans-serif'; g.textBaseline = 'middle'; g.fillText('SIM · 훈련장', 10, 11);
  g.fillStyle = accent; g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
  lines.forEach((l, i) => g.fillText(l, W / 2, 62 + i * 40));
  g.strokeStyle = 'rgba(159,232,255,0.35)'; g.lineWidth = 2; g.strokeRect(6, 30, W - 12, H - 36);
}

function screenTexture(lines: string[], accent: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  drawScreen(c, lines, accent);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function redrawScreen(t: THREE.CanvasTexture, lines: string[], accent: string): void {
  drawScreen(t.image as HTMLCanvasElement, lines, accent);
  t.needsUpdate = true;
}

/* ── arena ────────────────────────────────────────────────────────────────── */

export class TrainingArena implements TrainingRef {
  readonly group = new THREE.Group();
  readonly spawn = new THREE.Vector3(0, 0, SPAWN_Z);
  /** Hits on a standing target in the current run (`TrainingRef.hits`; reset by `resetScore` / `startCourse`). */
  hits = 0;
  /** Targets knocked down since the arena was built (all modes, never reset — the HUD objective line). */
  knockdowns = 0;

  private ctx: GameContext | null = null;
  private hash: SpatialHash | null = null;
  private built = false;
  private targets: Target[] = [];
  private fx: Fx[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  private strips: THREE.MeshStandardMaterial | null = null;
  private exitScreen: THREE.MeshStandardMaterial | null = null;
  private modeScreen: THREE.MeshStandardMaterial | null = null;
  private exitLastAt = -Infinity;
  private consoleEntries: ObstacleEntry[] = [];
  private time = 0;

  /* ── Phase 9: target modes ── */
  private _mode: TrainingMode = 'static';
  /** Knock-downs in the current run. */
  private _score = 0;
  private _best: number | null = null;
  /** Timed course: start stamp and deadline (−1 = idle), cooldown after a finish, and whether E on the console starts one. */
  private courseStart = -1;
  private courseEndAt = -1;
  private courseCooldownUntil = -Infinity;
  private courseArmed = false;
  private lastShownRemaining = -1;

  constructor() { this.group.name = 'TrainingArena'; }

  get targetCount(): number { return this.targets.length; }
  /** Debug / smoke: state of one target (`position` is the live obstacle entry — it moves in 이동 표적 mode). */
  getTargetState(i: number): { down: boolean; hp: number; position: THREE.Vector3 } | null {
    const t = this.targets[i];
    return t ? { down: t.down, hp: t.destructible.hp, position: t.entry.position } : null;
  }

  /* ── TrainingRef ── */
  get mode(): TrainingMode { return this._mode; }
  get score(): number { return this._score; }
  get remaining(): number { return this.courseRunning ? Math.max(0, this.courseEndAt - this.time) : -1; }
  get bestTime(): number | null { return this._best; }
  private get courseRunning(): boolean { return this.courseEndAt >= 0; }

  setMode(mode: TrainingMode): boolean {
    if (!this.built || this.courseRunning) return false;
    if (!TRAINING_MODES.includes(mode)) return false;
    if (mode === this._mode) return true;
    this._mode = mode;
    this.courseArmed = mode === 'timed';
    this.resetScore();
    if (mode !== 'moving') for (const t of this.targets) { t.mvOffset = 0; t.mvDir = t.index % 2 ? 1 : -1; t.mvPauseUntil = -Infinity; this.setTargetX(t, t.baseX); }
    this.refreshModeScreen();
    this.ctx?.bus.emit('training:modeChanged', { mode });
    this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    this.announce();
    return true;
  }

  startCourse(): boolean {
    if (!this.built || this._mode !== 'timed' || this.courseRunning || this.time < this.courseCooldownUntil) return false;
    this.resetScore();
    for (const t of this.targets) if (t.down) this.raise(t);
    this.courseStart = this.time;
    this.courseEndAt = this.time + TRAINING_COURSE_TIME_S;
    this.courseArmed = false;
    this.lastShownRemaining = -1;
    this.refreshModeScreen();
    this.ctx?.bus.emit('audio:play', { id: 'countdown_beep' });
    this.announce();
    return true;
  }

  resetScore(): void {
    this._score = 0;
    this.hits = 0;
    if (this.built) this.announce();
  }

  private finishCourse(completed: boolean): void {
    if (!this.courseRunning) return;
    const elapsed = completed ? Math.max(0.01, this.time - this.courseStart) : TRAINING_COURSE_TIME_S;
    this.courseEndAt = -1;
    this.courseStart = -1;
    this.courseCooldownUntil = this.time + TRAINING_COURSE_COOLDOWN_S;
    this.courseArmed = false;              // the next E on the console cycles on (static); a new course = cycle back to 타임 코스
    if (completed && (this._best === null || elapsed < this._best)) { this._best = elapsed; saveBest(elapsed); }
    this.refreshModeScreen();
    this.ctx?.bus.emit('training:courseFinished', { time: elapsed, score: this._score, completed, best: this._best });
    this.ctx?.bus.emit('audio:play', { id: completed ? 'level_up' : 'ui_deny' });
    this.announce();
  }

  build(ctx: GameContext, rng: Random, root: THREE.Group, hash: SpatialHash): void {
    this.ctx = ctx;
    this.hash = hash;
    this.time = ctx.time;
    this.hits = 0; this.knockdowns = 0; this._score = 0;
    this._mode = 'static';
    this._best = loadBest();
    this.courseStart = -1; this.courseEndAt = -1; this.courseCooldownUntil = -Infinity; this.courseArmed = false;
    root.add(this.group);
    this.buildShell();
    this.buildTargets(rng);
    this.buildConsoles();
    this.buildFxPool();
    this.built = true;
  }

  /* ── shell (2026-09-15): floor + fading apron, boundary / lane strips, horizon ring — no walls, no ceiling ── */
  private buildShell(): void {
    const H = ARENA_HALF;
    const floorTex = floorTexture();
    // a touch of emissive so the deck reads under the dim space-mode key light (the arena has no lights of its own)
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.88, metalness: 0.12, emissive: 0x1a2129, emissiveIntensity: 0.55 });
    this.disposables.push(floorTex, floorMat);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(TRAINING_ARENA_SIZE, TRAINING_ARENA_SIZE), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'arena-floor';
    floor.layers.enable(Layers.TERRAIN);
    this.group.add(floor);
    this.disposables.push(floor.geometry);

    // 2026-09-15: the deck carries on past the invisible wall and fades into the void, so the boundary reads as a limit
    // rather than the edge of a platform. Unlit on purpose: its far edge must meet the black background exactly.
    const apronMat = new THREE.MeshBasicMaterial({ map: floorTex, vertexColors: true, side: THREE.DoubleSide, fog: false });
    const apron = new THREE.Mesh(apronGeometry(H, FLOOR_REACH, APRON_RINGS, APRON_INNER), apronMat);
    apron.name = 'arena-apron';
    apron.matrixAutoUpdate = false;
    this.group.add(apron);
    this.disposables.push(apronMat, apron.geometry);

    // 2026-09-15: simulation horizon far out — additive (black texels add nothing); the camera is always inside the
    // cylinder, so it is never frustum-culled. No light, no raycast (the world's rays are analytic, not three.js).
    const horizonTex = horizonTexture();
    const horizonMat = new THREE.MeshBasicMaterial({
      map: horizonTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, fog: false,
    });
    const horizon = new THREE.Mesh(new THREE.CylinderGeometry(HORIZON_R, HORIZON_R, HORIZON_Y1 - HORIZON_Y0, 72, 1, true), horizonMat);
    horizon.name = 'arena-horizon';
    horizon.position.y = (HORIZON_Y0 + HORIZON_Y1) / 2;
    horizon.renderOrder = -1;
    horizon.updateMatrix();
    horizon.matrixAutoUpdate = false;
    this.group.add(horizon);
    this.disposables.push(horizonTex, horizonMat, horizon.geometry);

    // emissive strips: cyan (boundary, lane edges), amber (firing line, spawn ring)
    const cyan = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x4fc8ff, emissiveIntensity: 1.6, roughness: 0.4 });
    const amber = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xff9a2a, emissiveIntensity: 1.5, roughness: 0.4 });
    this.strips = cyan;
    this.disposables.push(cyan, amber);
    const cy: THREE.BufferGeometry[] = [], am: THREE.BufferGeometry[] = [];
    // 2026-09-15: the boundary line exactly where the invisible wall stands, inward ticks every 8 m (where the wall ribs
    // were) and corner brackets — the only visible trace of the walls
    const L = TRAINING_ARENA_SIZE + 0.12;
    cy.push(box(L, 0.03, 0.12, 0, 0.016, -H));
    cy.push(box(L, 0.03, 0.12, 0, 0.016, H));
    cy.push(box(0.12, 0.03, L, -H, 0.016, 0));
    cy.push(box(0.12, 0.03, L, H, 0.016, 0));
    for (let i = -3; i <= 3; i++) {
      const p = i * 8;
      cy.push(box(0.08, 0.03, 0.7, p, 0.016, -H + 0.35));
      cy.push(box(0.08, 0.03, 0.7, p, 0.016, H - 0.35));
      cy.push(box(0.7, 0.03, 0.08, -H + 0.35, 0.016, p));
      cy.push(box(0.7, 0.03, 0.08, H - 0.35, 0.016, p));
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      cy.push(box(2.4, 0.03, 0.3, sx * (H - 1.2), 0.016, sz * (H - 0.15)));
      cy.push(box(0.3, 0.03, 2.4, sx * (H - 0.15), 0.016, sz * (H - 1.2)));
    }
    // lane edges on the floor + the firing line
    const laneEnd = -H + 4;
    for (const lx of LANES_X) {
      for (const s of [-1, 1]) cy.push(box(0.12, 0.03, FIRING_LINE_Z - laneEnd, lx + s * LANE_HALF_W, 0.015, (FIRING_LINE_Z + laneEnd) / 2));
    }
    am.push(box(LANES_X[LANES_X.length - 1] - LANES_X[0] + LANE_HALF_W * 2, 0.03, 0.3, 0, 0.015, FIRING_LINE_Z));
    // spawn ring (amber) behind the firing line
    am.push(placed(new THREE.RingGeometry(1.1, 1.3, 32), 0, 0.02, SPAWN_Z, -Math.PI / 2));
    const cyMesh = mergedMesh(cy, cyan, 'arena-strips-cyan');
    const amMesh = mergedMesh(am, amber, 'arena-strips-amber');
    for (const m of [cyMesh, amMesh]) if (m) { this.group.add(m); this.disposables.push(m.geometry); }
  }

  /* ── targets ── */
  private buildTargets(rng: Random): void {
    const hash = this.hash!;
    const boardTex = boardTexture();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3b424c, roughness: 0.7, metalness: 0.4 });
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x20252c, roughness: 0.85, metalness: 0.3 });
    this.disposables.push(boardTex, postMat, baseMat);
    const postGeo = new THREE.BoxGeometry(0.1, HINGE_Y, 0.1);
    const baseGeo = new THREE.BoxGeometry(0.9, 0.08, 0.5);
    const boardGeo = new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.05);
    const backGeo = new THREE.BoxGeometry(0.08, BOARD_H - 0.1, 0.06);
    this.disposables.push(postGeo, baseGeo, boardGeo, backGeo);

    const lanes = LANES_X.length;
    const rows = Math.max(1, Math.ceil(TRAINING_TARGET_COUNT / lanes));
    const firstZ = FIRING_LINE_Z - 10, lastZ = -ARENA_HALF + 8;
    const spacing = rows > 1 ? (firstZ - lastZ) / (rows - 1) : 0;
    const laneRng = rng.fork('targets');

    // distance marks (amber) per row, across every lane
    const marks: THREE.BufferGeometry[] = [];
    for (let r = 0; r < rows; r++) {
      const z = firstZ - r * spacing;
      for (const lx of LANES_X) marks.push(box(LANE_HALF_W * 2 - 0.6, 0.03, 0.08, lx, 0.016, z + 0.9));
    }
    const markMat = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xff9a2a, emissiveIntensity: 0.9, roughness: 0.5 });
    this.disposables.push(markMat);
    const markMesh = mergedMesh(marks, markMat, 'arena-marks');
    if (markMesh) { this.group.add(markMesh); this.disposables.push(markMesh.geometry); }

    for (let i = 0; i < TRAINING_TARGET_COUNT; i++) {
      const lane = i % lanes, row = Math.floor(i / lanes);
      const x = LANES_X[lane] + laneRng.range(-1.6, 1.6);
      const z = firstZ - row * spacing + laneRng.range(-0.6, 0.6);
      const root = new THREE.Group();
      root.name = `target-${i}`;
      root.position.set(x, 0, z);
      const base = new THREE.Mesh(baseGeo, baseMat); base.position.y = 0.04; base.receiveShadow = true; root.add(base);
      const post = new THREE.Mesh(postGeo, postMat); post.position.y = HINGE_Y / 2; post.castShadow = true; root.add(post);
      const board = new THREE.Group(); board.position.y = HINGE_Y; root.add(board);
      const boardMat = new THREE.MeshStandardMaterial({ map: boardTex, emissiveMap: boardTex, roughness: 0.8, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: BOARD_GLOW });
      this.disposables.push(boardMat);
      const face = new THREE.Mesh(boardGeo, boardMat); face.position.y = BOARD_H / 2; face.castShadow = true; board.add(face);
      const back = new THREE.Mesh(backGeo, postMat); back.position.set(0, BOARD_H / 2 - 0.05, 0.05); board.add(back);
      this.group.add(root);

      const target: Target = {
        index: i, lane, root, board, boardMat, pose: 0, down: false, respawnAt: 0, flash: 0, inHash: false,
        entry: null!, destructible: null!,
        baseX: x, mvOffset: 0, mvDir: i % 2 ? 1 : -1, mvPauseUntil: -Infinity,
      };
      const destructible = {
        id: `training_target_${i}`,
        hp: TRAINING_TARGET_HP,
        maxHp: TRAINING_TARGET_HP,
        onDamage: (amount: number, point?: THREE.Vector3) => this.damageTarget(target, amount, point),
      };
      target.destructible = destructible;
      target.entry = { position: new THREE.Vector3(x, 0, z), radius: TARGET_RADIUS, height: TARGET_HEIGHT, stamp: 0, kind: 'target', destructible };
      hash.insert(target.entry); target.inHash = true;
      this.targets.push(target);
    }
  }

  private damageTarget(t: Target, amount: number, point?: THREE.Vector3): void {
    if (!this.built || t.down || amount <= 0) return;
    t.destructible.hp = Math.max(0, t.destructible.hp - amount);
    t.flash = 1;
    this.hits++;
    const p = point ?? _v.set(t.entry.position.x, HINGE_Y + BOARD_H * 0.5, t.entry.position.z);
    this.spawnFx(p, 0.18, 0.22, 0x9fe8ff, 3.2);
    if (t.destructible.hp <= 0) this.knockDown(t);
    this.announce();
  }

  private knockDown(t: Target): void {
    t.down = true;
    t.respawnAt = this.time + TRAINING_TARGET_RESPAWN_S;
    this.knockdowns++;
    this._score++;
    if (t.inHash) { this.hash?.remove(t.entry); t.inHash = false; }
    _v.set(t.entry.position.x, HINGE_Y + BOARD_H * 0.55, t.entry.position.z);
    this.spawnFx(_v, 0.35, 0.45, 0xffb347, 4.5);
    this.ctx?.bus.emit('audio:play', { id: 'hit_metal', position: _v.clone(), volume: 0.9, pitch: 0.7 });
    this.ctx?.bus.emit('training:scored', { score: this._score, hits: this.hits, index: t.index });
    if (this.courseRunning && this._score >= TRAINING_COURSE_TARGETS) this.finishCourse(true);
  }

  /* ── 이동 표적 (Phase 9): sweep about the lane centre, re-bucketing the hash entry when its cells change ── */
  private setTargetX(t: Target, x: number): void {
    const hash = this.hash;
    const e = t.entry;
    if (e.position.x === x) return;
    let rebucket = false;
    if (t.inHash && hash) {
      const s = hash.cellSize, r = e.radius;
      rebucket = Math.floor((e.position.x - r) / s) !== Math.floor((x - r) / s) || Math.floor((e.position.x + r) / s) !== Math.floor((x + r) / s);
      if (rebucket) hash.remove(e);
    }
    e.position.x = x;
    t.root.position.x = x;
    if (rebucket && hash) hash.insert(e);
  }

  private updateMoving(dt: number): void {
    for (const t of this.targets) {
      if (this.time < t.mvPauseUntil) continue;
      let o = t.mvOffset + t.mvDir * TRAINING_MOVING_SPEED * dt;
      if (o >= TRAINING_MOVING_SPAN) { o = TRAINING_MOVING_SPAN; t.mvDir = -1; t.mvPauseUntil = this.time + TRAINING_MOVING_PAUSE_S; }
      else if (o <= -TRAINING_MOVING_SPAN) { o = -TRAINING_MOVING_SPAN; t.mvDir = 1; t.mvPauseUntil = this.time + TRAINING_MOVING_PAUSE_S; }
      t.mvOffset = o;
      this.setTargetX(t, LANES_X[t.lane] + o);
    }
  }

  private raise(t: Target): void {
    t.down = false;
    t.destructible.hp = TRAINING_TARGET_HP;
    if (!t.inHash && this.hash) { this.hash.insert(t.entry); t.inHash = true; }
    this.ctx?.bus.emit('audio:play', { id: 'ui_click', position: t.entry.position.clone(), volume: 0.4, pitch: 0.8 });
  }

  /* ── consoles: exit (−8), target mode (+8), weapon rack (+14) — one pedestal each against the south wall ── */
  private buildConsoles(): void {
    this.exitScreen = this.buildConsole('training-exit', EXIT_X, ['훈련 종료'], '#9fe8ff');
    this.modeScreen = this.buildConsole('training-mode', MODE_X, this.modeScreenLines(), '#ffd27a');
    this.buildConsole('training-rack', RACK_X, ['무기 거치대'], '#c8ffb0');
    this.buildRack();
    const ctx = this.ctx!;
    ctx.interactables.register({
      id: 'training_exit',
      position: new THREE.Vector3(EXIT_X, 0, EXIT_Z - 0.9),
      radius: 2.2,
      getPrompt: () => (this.built ? '훈련 종료' : null),
      canInteract: () => this.built,
      interact: () => this.requestExit(),
    });
    ctx.interactables.register({
      id: 'training_mode',
      position: new THREE.Vector3(MODE_X, 0, EXIT_Z - 0.9),
      radius: 2.2,
      getPrompt: () => this.modePrompt(),
      canInteract: () => this.built,
      interact: () => this.onModeConsole(),
    });
    ctx.interactables.register({
      id: 'training_rack',
      position: new THREE.Vector3(RACK_X, 0, EXIT_Z - 0.9),
      radius: 2.2,
      getPrompt: () => (this.built ? '무기 거치대' : null),
      canInteract: () => this.built,
      interact: () => this.openRack(),
    });
  }

  /** Pedestal + tilted emissive screen + floor halo at (x, EXIT_Z); returns the screen material (its `map` can be swapped). */
  private buildConsole(name: string, x: number, lines: string[], accent: string): THREE.MeshStandardMaterial {
    const hash = this.hash!;
    const body = new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.6, metalness: 0.4, emissive: 0x10151b, emissiveIntensity: 0.7 });
    const tex = screenTexture(lines, accent);
    const screen = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.1, roughness: 0.3 });
    this.disposables.push(body, tex, screen);
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, 0, EXIT_Z);
    const parts: THREE.BufferGeometry[] = [
      box(0.9, 1.05, 0.5, 0, 0.525, 0),
      box(1.0, 0.06, 0.6, 0, 1.06, 0),
      box(0.8, 0.05, 0.05, 0, 0.35, -0.26),
    ];
    const pedestal = mergedMesh(parts, body, `${name}-pedestal`);
    if (pedestal) { pedestal.castShadow = true; g.add(pedestal); this.disposables.push(pedestal.geometry); }
    // tilted screen facing −Z (toward the arena)
    const scr = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.04), screen);
    scr.position.set(0, 1.32, -0.12);
    scr.rotation.x = -0.35;
    g.add(scr); this.disposables.push(scr.geometry);
    const scrFrame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.05), body);
    scrFrame.position.set(0, 1.32, -0.11 + 0.03);
    scrFrame.rotation.x = -0.35;
    g.add(scrFrame); this.disposables.push(scrFrame.geometry);
    // cyan halo on the floor
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 32), this.strips ?? body);
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02;
    g.add(halo); this.disposables.push(halo.geometry);
    this.group.add(g);

    const entry: ObstacleEntry = { position: new THREE.Vector3(x, 0, EXIT_Z), radius: 0.6, height: 1.6, stamp: 0, kind: 'console' };
    hash.insert(entry);
    this.consoleEntries.push(entry);
    return screen;
  }

  /** 무기 거치대 dressing behind its console: a free-standing rack with a few silhouetted guns (no interaction of its own). */
  private buildRack(): void {
    const frame = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.7, metalness: 0.4, emissive: 0x0c1014, emissiveIntensity: 0.6 });
    const gun = new THREE.MeshStandardMaterial({ color: 0x4a525c, roughness: 0.5, metalness: 0.6 });
    this.disposables.push(frame, gun);
    const z = ARENA_HALF - 0.45;
    const parts: THREE.BufferGeometry[] = [
      box(2.6, 0.08, 0.3, RACK_X, 0.9, z), box(2.6, 0.08, 0.3, RACK_X, 1.9, z),
      // 2026-09-15: no wall behind it any more — full-height uprights on feet and a back panel, so it stands on its own
      box(0.08, 2.0, 0.3, RACK_X - 1.26, 1.0, z), box(0.08, 2.0, 0.3, RACK_X + 1.26, 1.0, z),
      box(0.3, 0.05, 0.7, RACK_X - 1.26, 0.025, z), box(0.3, 0.05, 0.7, RACK_X + 1.26, 0.025, z),
      box(2.6, 1.3, 0.04, RACK_X, 1.35, z + 0.14),
    ];
    const guns: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const gx = RACK_X - 0.9 + k * 0.6;
      guns.push(box(0.07, 0.95, 0.09, gx, 1.42, z - 0.12));          // body
      guns.push(box(0.05, 0.28, 0.06, gx, 2.0, z - 0.13));           // barrel
      guns.push(box(0.05, 0.22, 0.14, gx + 0.02, 1.2, z - 0.1, 0));  // magazine
    }
    const rack = mergedMesh(parts, frame, 'rack-frame');
    if (rack) { rack.castShadow = true; this.group.add(rack); this.disposables.push(rack.geometry); }
    const gunMesh = mergedMesh(guns, gun, 'rack-guns');
    if (gunMesh) { gunMesh.castShadow = true; this.group.add(gunMesh); this.disposables.push(gunMesh.geometry); }
  }

  private modeScreenLines(): string[] {
    if (this.courseRunning) return ['타임 코스', `${Math.ceil(this.remaining)}초`];
    const best = this._best !== null ? `최고 ${this._best.toFixed(1)}초` : '';
    return best && this._mode === 'timed' ? [TRAINING_MODE_LABEL_KO[this._mode], best] : [TRAINING_MODE_LABEL_KO[this._mode]];
  }

  private refreshModeScreen(): void {
    const tex = this.modeScreen?.map as THREE.CanvasTexture | null | undefined;
    if (tex) redrawScreen(tex, this.modeScreenLines(), this._mode === 'timed' ? '#ffb347' : '#ffd27a');
  }

  private modePrompt(): string | null {
    if (!this.built) return null;
    if (this.courseRunning) return `타임 코스 진행 중 · ${Math.ceil(this.remaining)}초`;
    if (this._mode === 'timed' && this.courseArmed) return this.time < this.courseCooldownUntil ? '타임 코스 준비 중' : '타임 코스 시작';
    return `표적 모드: ${TRAINING_MODE_LABEL_KO[this._mode]}`;
  }

  /** E on the mode console: cycle 고정 → 이동 → 타임 코스; in 타임 코스 (armed) start the course; nothing while one runs. */
  private onModeConsole(): void {
    if (!this.built || this.courseRunning) return;
    if (this._mode === 'timed' && this.courseArmed) {
      if (!this.startCourse()) this.ctx?.bus.emit('audio:play', { id: 'ui_deny' });
      return;
    }
    const next = TRAINING_MODES[(TRAINING_MODES.indexOf(this._mode) + 1) % TRAINING_MODES.length];
    this.setMode(next);
  }

  /** 무기 거치대: the 무한 상자 catalog on its 주무기 tab (game/'s training exit restores the loadout afterwards). */
  private openRack(): void {
    const ctx = this.ctx;
    if (!ctx || !this.built) return;
    const inv = ctx.inventory as { openCatalog?: (opts?: { category?: 'primary' }) => void } | null;
    if (inv && typeof inv.openCatalog === 'function') { inv.openCatalog({ category: 'primary' }); ctx.bus.emit('audio:play', { id: 'ui_click' }); }
    else ctx.bus.emit('ui:notify', { text: '무기 거치대를 사용할 수 없습니다', kind: 'warning' });
  }

  private requestExit(): void {
    const ctx = this.ctx;
    if (!ctx || !this.built) return;
    if (this.time - this.exitLastAt < 1) return;      // one request per press
    this.exitLastAt = this.time;
    ctx.bus.emit('audio:play', { id: 'ui_click' });
    ctx.bus.emit('training:exitRequested', {});
  }

  /* ── fx ── */
  private buildFxPool(): void {
    const geo = new THREE.RingGeometry(0.6, 1, 24);
    this.disposables.push(geo);
    for (let i = 0; i < FX_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.layers.set(Layers.NO_RAYCAST);
      this.group.add(mesh);
      this.disposables.push(mat);
      this.fx.push({ mesh, mat, life: 0, ttl: 1, grow: 1 });
    }
  }

  private spawnFx(at: THREE.Vector3, size: number, ttl: number, color: number, grow: number): void {
    let f = this.fx.find((x) => x.life <= 0);
    if (!f) f = this.fx[0];
    f.life = ttl; f.ttl = ttl; f.grow = grow;
    f.mesh.visible = true;
    f.mesh.position.copy(at);
    f.mesh.scale.setScalar(size);
    f.mesh.rotation.set(0, 0, 0);          // faces ±Z, i.e. the shooter behind the firing line
    f.mat.color.setHex(color);
    f.mat.opacity = 0.9;
  }

  /** Objective sub-text with the counters (`ui:objective`; the HUD folder owns the layout). */
  announce(): void {
    const label = TRAINING_MODE_LABEL_KO[this._mode];
    const run = this.courseRunning
      ? ` · ${this._score}/${TRAINING_COURSE_TARGETS} · 남은 ${Math.ceil(this.remaining)}초`
      : this._mode === 'timed' && this._best !== null ? ` · 최고 ${this._best.toFixed(1)}초` : '';
    this.ctx?.bus.emit('ui:objective', { text: OBJECTIVE_TEXT, subText: `${label}${run} · 명중 ${this.hits} · 격추 ${this.knockdowns}` });
  }

  /* ── frame ── */
  update(dt: number, time: number): void {
    if (!this.built) return;
    this.time = time;
    if (this._mode === 'moving') this.updateMoving(dt);
    if (this.courseRunning) {
      if (time >= this.courseEndAt) this.finishCourse(false);
      else {
        const shown = Math.ceil(this.remaining);
        if (shown !== this.lastShownRemaining) { this.lastShownRemaining = shown; this.refreshModeScreen(); this.announce(); }
      }
    }
    for (const t of this.targets) {
      if (t.down && time >= t.respawnAt) this.raise(t);
      const goal = t.down ? 1 : 0;
      const rate = t.down ? 1 / KNOCK_TIME : 1 / RAISE_TIME;
      if (t.pose !== goal) {
        t.pose += Math.sign(goal - t.pose) * rate * dt;
        t.pose = THREE.MathUtils.clamp(t.pose, 0, 1);
        // ease: falls fast with a little overshoot, rises smoothly
        const e = t.down ? 1 - (1 - t.pose) * (1 - t.pose) : t.pose * t.pose * (3 - 2 * t.pose);
        t.board.rotation.x = -e * (Math.PI / 2 - 0.05);
      }
      if (t.flash > 0) {
        t.flash = Math.max(0, t.flash - dt * FLASH_DECAY);
        t.boardMat.emissiveIntensity = BOARD_GLOW + t.flash * 0.9;
      }
    }
    for (const f of this.fx) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = 1 - Math.max(0, f.life) / f.ttl;
      f.mesh.scale.setScalar(f.mesh.scale.x * (1 + f.grow * dt));
      f.mat.opacity = 0.9 * (1 - k);
      if (f.life <= 0) f.mesh.visible = false;
    }
    if (this.strips) this.strips.emissiveIntensity = 1.5 + Math.sin(time * 1.7) * 0.2;
    if (this.exitScreen) this.exitScreen.emissiveIntensity = 1.0 + Math.sin(time * 3) * 0.15;
  }

  /* ── queries (flat floor, invisible walls) ── */

  /**
   * Ray vs the floor plane — the deck **and** its apron, out to `FLOOR_REACH`. Returns t (or −1) and writes the normal into `n`.
   * 2026-09-15: no ceiling plane and no wall planes any more. The walls are invisible and hold bodies only (`clampInside`),
   * so a shot through the boundary flies on and lands on the drawn apron or expires at its range (no sparks in mid-air),
   * the camera may swing past the boundary, and the player's ceiling probe finds nothing overhead.
   */
  raycastShell(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, n: THREE.Vector3): number {
    if (dy > -1e-6) return -1;
    const t = -oy / dy;
    if (t < 0 || t > maxDist) return -1;
    const px = ox + dx * t, pz = oz + dz * t;
    if (px < -FLOOR_REACH || px > FLOOR_REACH || pz < -FLOOR_REACH || pz > FLOOR_REACH) return -1;
    n.set(0, 1, 0);
    return t;
  }

  /** Hard clamp inside the invisible walls — X/Z only, so it holds at any height (jumps, rocket jumps, thrown things, drones). */
  clampInside(position: THREE.Vector3, radius: number): void {
    const lim = ARENA_HALF - radius - 0.05;
    if (position.x > lim) position.x = lim; else if (position.x < -lim) position.x = -lim;
    if (position.z > lim) position.z = lim; else if (position.z < -lim) position.z = -lim;
  }

  isInside(x: number, z: number): boolean { return Math.abs(x) <= ARENA_HALF && Math.abs(z) <= ARENA_HALF; }

  dispose(): void {
    if (!this.built) return;
    this.built = false;
    const ctx = this.ctx;
    ctx?.interactables.unregister('training_exit');
    ctx?.interactables.unregister('training_mode');
    ctx?.interactables.unregister('training_rack');
    this.courseEndAt = -1; this.courseStart = -1; this.courseArmed = false;
    for (const t of this.targets) { if (t.inHash) this.hash?.remove(t.entry); t.root.removeFromParent(); }
    this.targets.length = 0;
    for (const e of this.consoleEntries) this.hash?.remove(e);
    this.consoleEntries.length = 0;
    this.fx.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.strips = null; this.exitScreen = null; this.modeScreen = null;
    this.hash = null;
  }
}
