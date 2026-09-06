import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Layers, Random, TRAINING_ARENA_SIZE, TRAINING_TARGET_COUNT, TRAINING_TARGET_HP, TRAINING_TARGET_RESPAWN_S,
  type DestructibleRef, type GameContext, type Interactable,
} from '@/shared';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';

/* ────────────────────────────────────────────────────────────────────────────
 * 시뮬레이션 훈련장 (Phase 7): a flat, walled, "indoor" arena that replaces the planet when `game:newMission` carries
 * `mode: 'training'`. Three lanes of pop-up targets (destructible obstacles in the world's spatial hash, so the
 * weapon folder's ordinary `raycast → obstacle.destructible.onDamage` path scores hits), an exit console
 * (`Interactable 'training_exit'` → `training:exitRequested`), no crates / nests / gather / extraction.
 * Everything is procedural: CanvasTextures for the floor grid, the target boards and the console screen; emissive
 * strips for the "indoor" lighting feel (no lights — the arena is rendered in the atmosphere's space mode).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Half side of the arena (inner wall face). */
export const ARENA_HALF = TRAINING_ARENA_SIZE / 2;
/** Ceiling height (m) — the raycast treats it as a plane so tracers / grenades stop there. */
export const ARENA_CEILING = 7;
const WALL_T = 0.6;
const WALL_H = ARENA_CEILING;
/** Lane centres (x) and the lane half width. */
const LANES_X: readonly number[] = [-10, 0, 10];
const LANE_HALF_W = 4;
/** The firing line (amber strip) and the spawn just behind it, both toward +Z ("south"); the player faces −Z. */
const FIRING_LINE_Z = ARENA_HALF - 12;
const SPAWN_Z = ARENA_HALF - 6;
/** Exit console against the south wall, west of the spawn. */
const EXIT_X = -8, EXIT_Z = ARENA_HALF - 2.4;
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

function screenTexture(lines: string[], accent: string): THREE.CanvasTexture {
  const W = 256, H = 160;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#06141a'; g.fillRect(0, 0, W, H);
  g.fillStyle = accent; g.fillRect(0, 0, W, 22);
  g.fillStyle = '#06141a'; g.font = 'bold 15px sans-serif'; g.textBaseline = 'middle'; g.fillText('SIM · 훈련장', 10, 11);
  g.fillStyle = accent; g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
  lines.forEach((l, i) => g.fillText(l, W / 2, 62 + i * 40));
  g.strokeStyle = 'rgba(159,232,255,0.35)'; g.lineWidth = 2; g.strokeRect(6, 30, W - 12, H - 36);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ── arena ────────────────────────────────────────────────────────────────── */

export class TrainingArena {
  readonly group = new THREE.Group();
  readonly spawn = new THREE.Vector3(0, 0, SPAWN_Z);
  /** Shot hits on a standing target / targets knocked down since the arena was built. */
  hits = 0;
  knockdowns = 0;

  private ctx: GameContext | null = null;
  private hash: SpatialHash | null = null;
  private built = false;
  private targets: Target[] = [];
  private fx: Fx[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  private strips: THREE.MeshStandardMaterial | null = null;
  private exitScreen: THREE.MeshStandardMaterial | null = null;
  private exitLastAt = -Infinity;
  private exitEntry: ObstacleEntry | null = null;
  private time = 0;

  constructor() { this.group.name = 'TrainingArena'; }

  get targetCount(): number { return this.targets.length; }
  /** Debug / smoke: state of one target. */
  getTargetState(i: number): { down: boolean; hp: number; position: THREE.Vector3 } | null {
    const t = this.targets[i];
    return t ? { down: t.down, hp: t.destructible.hp, position: t.entry.position } : null;
  }

  build(ctx: GameContext, rng: Random, root: THREE.Group, hash: SpatialHash): void {
    this.ctx = ctx;
    this.hash = hash;
    this.time = ctx.time;
    this.hits = 0; this.knockdowns = 0;
    root.add(this.group);
    this.buildShell();
    this.buildTargets(rng);
    this.buildExitConsole();
    this.buildFxPool();
    this.built = true;
  }

  /* ── shell: floor, walls, ceiling, strips ── */
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

    // walls + corner pillars + ceiling (dark hull)
    const hull = new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.8, metalness: 0.25, emissive: 0x10151b, emissiveIntensity: 0.7 });
    const hullDark = new THREE.MeshStandardMaterial({ color: 0x1c2229, roughness: 0.9, metalness: 0.2, emissive: 0x0a0d11, emissiveIntensity: 0.6 });
    this.disposables.push(hull, hullDark);
    const walls: THREE.BufferGeometry[] = [];
    const L = TRAINING_ARENA_SIZE + WALL_T * 2;
    walls.push(box(L, WALL_H, WALL_T, 0, WALL_H / 2, -H - WALL_T / 2));
    walls.push(box(L, WALL_H, WALL_T, 0, WALL_H / 2, H + WALL_T / 2));
    walls.push(box(WALL_T, WALL_H, L, -H - WALL_T / 2, WALL_H / 2, 0));
    walls.push(box(WALL_T, WALL_H, L, H + WALL_T / 2, WALL_H / 2, 0));
    // ribs every 8 m so the walls read as panels
    for (let i = -3; i <= 3; i++) {
      const p = i * 8;
      walls.push(box(0.5, WALL_H, 0.35, p, WALL_H / 2, -H + 0.15));
      walls.push(box(0.5, WALL_H, 0.35, p, WALL_H / 2, H - 0.15));
      walls.push(box(0.35, WALL_H, 0.5, -H + 0.15, WALL_H / 2, p));
      walls.push(box(0.35, WALL_H, 0.5, H - 0.15, WALL_H / 2, p));
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) walls.push(box(1.2, WALL_H, 1.2, sx * (H - 0.5), WALL_H / 2, sz * (H - 0.5)));
    const wallMesh = mergedMesh(walls, hull, 'arena-walls');
    if (wallMesh) { wallMesh.castShadow = true; wallMesh.receiveShadow = true; this.group.add(wallMesh); this.disposables.push(wallMesh.geometry); }

    const ceilParts: THREE.BufferGeometry[] = [box(L, 0.4, L, 0, ARENA_CEILING + 0.2, 0)];
    // ceiling beams
    for (let i = -3; i <= 3; i++) ceilParts.push(box(L, 0.35, 0.5, 0, ARENA_CEILING - 0.17, i * 8));
    const ceil = mergedMesh(ceilParts, hullDark, 'arena-ceiling');
    if (ceil) { this.group.add(ceil); this.disposables.push(ceil.geometry); }

    // emissive strips: cyan (walls, lane edges, wall band), amber (firing line, distance marks), white (ceiling panels)
    const cyan = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x4fc8ff, emissiveIntensity: 1.6, roughness: 0.4 });
    const amber = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xff9a2a, emissiveIntensity: 1.5, roughness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xdfe8ff, emissiveIntensity: 2.2, roughness: 0.3 });
    this.strips = cyan;
    this.disposables.push(cyan, amber, white);
    const cy: THREE.BufferGeometry[] = [], am: THREE.BufferGeometry[] = [], wh: THREE.BufferGeometry[] = [];
    // wall bands at 1.0 m and under the ceiling
    for (const y of [1.0, ARENA_CEILING - 0.6]) {
      cy.push(box(L - 2, 0.08, 0.08, 0, y, -H + 0.06));
      cy.push(box(L - 2, 0.08, 0.08, 0, y, H - 0.06));
      cy.push(box(0.08, 0.08, L - 2, -H + 0.06, y, 0));
      cy.push(box(0.08, 0.08, L - 2, H - 0.06, y, 0));
    }
    // lane edges on the floor + the firing line
    const laneEnd = -H + 4;
    for (const lx of LANES_X) {
      for (const s of [-1, 1]) cy.push(box(0.12, 0.03, FIRING_LINE_Z - laneEnd, lx + s * LANE_HALF_W, 0.015, (FIRING_LINE_Z + laneEnd) / 2));
    }
    am.push(box(LANES_X[LANES_X.length - 1] - LANES_X[0] + LANE_HALF_W * 2, 0.03, 0.3, 0, 0.015, FIRING_LINE_Z));
    // spawn ring (amber) behind the firing line
    am.push(placed(new THREE.RingGeometry(1.1, 1.3, 32), 0, 0.02, SPAWN_Z, -Math.PI / 2));
    // ceiling light panels
    for (let ix = -1; ix <= 1; ix++) for (let iz = -2; iz <= 2; iz++) wh.push(box(4, 0.08, 1.2, ix * 20, ARENA_CEILING - 0.04, iz * 12));
    const cyMesh = mergedMesh(cy, cyan, 'arena-strips-cyan');
    const amMesh = mergedMesh(am, amber, 'arena-strips-amber');
    const whMesh = mergedMesh(wh, white, 'arena-strips-white');
    for (const m of [cyMesh, amMesh, whMesh]) if (m) { this.group.add(m); this.disposables.push(m.geometry); }
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
    if (t.inHash) { this.hash?.remove(t.entry); t.inHash = false; }
    _v.set(t.entry.position.x, HINGE_Y + BOARD_H * 0.55, t.entry.position.z);
    this.spawnFx(_v, 0.35, 0.45, 0xffb347, 4.5);
    this.ctx?.bus.emit('audio:play', { id: 'hit_metal', position: _v.clone(), volume: 0.9, pitch: 0.7 });
  }

  private raise(t: Target): void {
    t.down = false;
    t.destructible.hp = TRAINING_TARGET_HP;
    if (!t.inHash && this.hash) { this.hash.insert(t.entry); t.inHash = true; }
    this.ctx?.bus.emit('audio:play', { id: 'ui_click', position: t.entry.position.clone(), volume: 0.4, pitch: 0.8 });
  }

  /* ── exit console ── */
  private buildExitConsole(): void {
    const ctx = this.ctx!, hash = this.hash!;
    const body = new THREE.MeshStandardMaterial({ color: 0x3a424c, roughness: 0.6, metalness: 0.4, emissive: 0x10151b, emissiveIntensity: 0.7 });
    const tex = screenTexture(['훈련 종료'], '#9fe8ff');
    const screen = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.1, roughness: 0.3 });
    this.exitScreen = screen;
    this.disposables.push(body, tex, screen);
    const g = new THREE.Group();
    g.name = 'training-exit';
    g.position.set(EXIT_X, 0, EXIT_Z);
    const parts: THREE.BufferGeometry[] = [
      box(0.9, 1.05, 0.5, 0, 0.525, 0),
      box(1.0, 0.06, 0.6, 0, 1.06, 0),
      box(0.8, 0.05, 0.05, 0, 0.35, -0.26),
    ];
    const pedestal = mergedMesh(parts, body, 'exit-pedestal');
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

    this.exitEntry = { position: new THREE.Vector3(EXIT_X, 0, EXIT_Z), radius: 0.6, height: 1.6, stamp: 0, kind: 'console' };
    hash.insert(this.exitEntry);

    const it: Interactable = {
      id: 'training_exit',
      position: new THREE.Vector3(EXIT_X, 0, EXIT_Z - 0.9),
      radius: 2.2,
      getPrompt: () => (this.built ? '훈련 종료' : null),
      canInteract: () => this.built,
      interact: () => this.requestExit(),
    };
    ctx.interactables.register(it);
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
    this.ctx?.bus.emit('ui:objective', { text: OBJECTIVE_TEXT, subText: `명중 ${this.hits} · 격추 ${this.knockdowns}` });
  }

  /* ── frame ── */
  update(dt: number, time: number): void {
    if (!this.built) return;
    this.time = time;
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

  /* ── queries (flat floor, analytic walls) ── */

  /** Ray vs floor / ceiling / the four walls. Returns t (or −1) and writes the normal into `n`. */
  raycastShell(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, n: THREE.Vector3): number {
    let best = -1;
    const consider = (t: number, nx: number, ny: number, nz: number): void => {
      if (t < 0 || t > maxDist || (best >= 0 && t >= best)) return;
      const px = ox + dx * t, pz = oz + dz * t, py = oy + dy * t;
      const H = ARENA_HALF + 0.01;
      if (px < -H || px > H || pz < -H || pz > H || py < -0.01 || py > ARENA_CEILING + 0.01) return;
      best = t; n.set(nx, ny, nz);
    };
    if (dy < -1e-6) consider(-oy / dy, 0, 1, 0);
    if (dy > 1e-6) consider((ARENA_CEILING - oy) / dy, 0, -1, 0);
    if (dx > 1e-6) consider((ARENA_HALF - ox) / dx, -1, 0, 0);
    if (dx < -1e-6) consider((-ARENA_HALF - ox) / dx, 1, 0, 0);
    if (dz > 1e-6) consider((ARENA_HALF - oz) / dz, 0, 0, -1);
    if (dz < -1e-6) consider((-ARENA_HALF - oz) / dz, 0, 0, 1);
    return best;
  }

  /** Hard clamp inside the walls. */
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
    for (const t of this.targets) { if (t.inHash) this.hash?.remove(t.entry); t.root.removeFromParent(); }
    this.targets.length = 0;
    if (this.exitEntry) { this.hash?.remove(this.exitEntry); this.exitEntry = null; }
    this.fx.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.strips = null; this.exitScreen = null;
    this.hash = null;
  }
}
