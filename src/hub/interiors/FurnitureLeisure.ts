import * as THREE from 'three';
import type { FurnitureModelKind, FurniturePoseKind, Rarity } from '@/shared';
import { RARITY_COLORS, SHELF_SLOTS } from '@/shared';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BuildExtra, FurnitureModel } from './Furniture';

/* ────────────────────────────────────────────────────────────────────────────
 * Library media (A-3e) · gym (A-3a) furniture, 11 kinds — 2026-09-12.
 *
 * Same contract as the other builders in `Furniture.ts`: footprint centre · floor y 0 · **front = −Z** · one `GeoBatch`
 * mesh per material. Two differences:
 *  1. The **moving parts** (barbell · plates · belt stripes · crank · flywheel · rocking chair · record) are separately
 *     merged **sub-groups** handed on as `FurnitureModel.rig` / `spin` for `FurnitureLayer.update` to turn. Their meshes
 *     land in `model.meshes` too, so disposing a piece and the ghost's material swap treat them exactly like the rest.
 *  2. The **pose geometry** (`FurnitureRig.anchor` · `forward` · `focus`) comes out too, in **furniture-local coordinates**,
 *     which hub turns into world space for `PlayerRef.setFurniturePose`; beside the model, a moved seat moves its sitting spot.
 *
 * Everything that glows (TV screen · gramophone horn · jukebox neon · turntable LED) is an emissive material and **not one
 * point light exists** (CLAUDE.md 「the scene's point-light count never changes during play」 · `smoke-lights`); on / off is a
 * material choice and a rebuild. Every material here is an opaque FrontSide `MeshStandardMaterial`, so it reuses an already
 * compiled program — a first-time placement compiles no shader (why the horn's inside is a mouth disc, not `DoubleSide`).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The furniture models this file builds. 2026-09-13 (library series · video games): game disc stand · sofa · low table ·
 * rug were added, and `chair` moved here from `Furniture.ts`'s `BUILDERS` because it too needs sitting pose geometry (`rig`).
 */
export type LeisureKind =
  | 'disc_stand' | 'record_rack' | 'rocking_chair' | 'tv' | 'gramophone' | 'jukebox' | 'turntable'
  | 'bench_rack' | 'smith_machine' | 'treadmill' | 'exercise_bike'
  | 'game_stand' | 'sofa' | 'low_table' | 'rug' | 'chair';

const LEISURE_KIND_SET: ReadonlySet<FurnitureModelKind> = new Set<FurnitureModelKind>([
  'disc_stand', 'record_rack', 'rocking_chair', 'tv', 'gramophone', 'jukebox', 'turntable',
  'bench_rack', 'smith_machine', 'treadmill', 'exercise_bike',
  'game_stand', 'sofa', 'low_table', 'rug', 'chair',
]);
export function isLeisureKind(kind: FurnitureModelKind): kind is LeisureKind { return LEISURE_KIND_SET.has(kind); }

/**
 * Pose and animation data (all of it furniture-local, front = −Z). The four gym machines and the rocking chair have one.
 */
export interface FurnitureRig {
  pose: FurniturePoseKind;
  /** The surface that carries the body — `FurniturePose.anchor` in local coordinates (seat top · the shoulder-blade spot on the bench pad top · belt top · saddle top). */
  anchor: THREE.Vector3;
  /** Facing direction (x, z) — `sit` · `run` · `cycle` = the way the body looks, `bench` = **hips → head**. */
  forward: { x: number; z: number };
  /** The point the fixed camera looks at (gym machines only). */
  focus?: THREE.Vector3;
  /** Distance · height of the side camera (relative to focus). */
  camDist?: number;
  camUp?: number;
  /* ── Bench press (bench rack · smith machine) ── */
  /** The barbell group (plates and collars included). `position` is the centre of the bar. */
  bar?: THREE.Group;
  /** The plates, visible only during a session (a child of `bar`). */
  plates?: THREE.Group;
  /** Where the racked bar rests (y, z). */
  barRest?: { y: number; z: number };
  /**
   * Where the bar sits while exercising — phase 0 (chest) · 1 (arms fully extended), **linear** in between (the same
   * contract as player's `FURN_BENCH` fist path). The smith machine's rails are vertical, so its two z are the same.
   */
  barPress?: { low: { y: number; z: number }; high: { y: number; z: number } };
  /* ── Treadmill ── */
  /** The belt stripe group — pushing `position.z` through `[0, beltSpacing)` makes it flow without a seam. */
  belt?: THREE.Group;
  beltSpacing?: number;
  /* ── Exercise bike ── */
  /** The crank group (turns about X). 0 = the left-foot (−X) pedal is up. */
  crank?: THREE.Group;
  /** The two pedal groups — turned against the crank so they stay level. */
  pedals?: THREE.Group[];
  /** The flywheel group (turns about X). */
  flywheel?: THREE.Group;
  /* ── Rocking chair ── */
  /** The whole chair (rocks about X while someone sits in it; the pivot is where the rockers meet the floor). */
  rock?: THREE.Group;
  /* ── Sofa (2026-09-13) ── */
  /**
   * Every spot that can be sat on (one point per cushion on the seat top, furniture-local). If present, `sitPoseOf` picks
   * the one closest to its `near` — the player's feet normally, the TV screen in a game session. Without it, only `anchor`.
   */
  seats?: THREE.Vector3[];
}

/**
 * The TV's game screen rig (2026-09-13, video games). A sub-group always built in front of the screen and kept hidden —
 * during a game session `GameStaging` shows it and changes only the emissive colour · intensity (uniforms) of the shared
 * materials `TV_GAME_SCREEN` · `TV_GAME_HUD`. No material is swapped, so there is no shader compile and no point light.
 */
export interface TvRig {
  /** The centre of the screen's front face (furniture-local) — what the game camera looks at, and the point seat picking measures against. */
  screen: THREE.Vector3;
  /** Screen width · height (m). */
  screenW: number;
  screenH: number;
  /** The game screen group (`tv-game`) — built visible when `BuildExtra.gameActive`. */
  overlay: THREE.Group;
  /** The marker moving inside the screen (`tv-game-marker`) — x travel · y ratio mimic the minigame. */
  marker: THREE.Group;
  /** The progress bar (`tv-game-progress`) — its left end is the origin, so `scale.x` is the progress itself. */
  progress: THREE.Group;
}

/** Seat top height — player `FURN_SIT` puts the soles this far below it (0.36 m), so chair · sofa · rocking chair share the value. */
export const SIT_SEAT_TOP = 0.36;

/* ── Materials (all shared · never disposed) ────────────────────────────────── */
function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}
const WOOD = std(0x7a5634, 0.78, 0.05);
const WOOD_DARK = std(0x4e3521, 0.82, 0.05);
const CHROME = std(0xc3cad2, 0.22, 0.92);
const RUBBER = std(0x17191c, 0.95, 0.05);
const VINYL = std(0x0f1012, 0.32, 0.25);
const DISC_FACE = std(0xd6dde6, 0.16, 0.9, 0x24303c, 0.3);
const BENCH_PAD = std(0x1d1f23, 0.72, 0.08);
const PLATE = std(0x202328, 0.58, 0.55);
const BELT = std(0x141619, 0.92, 0.05);
const BELT_STRIPE = std(0x3a4149, 0.85, 0.1);
const SLATE = std(0x353a41, 0.42, 0.4);
const JUKE_BODY = std(0x5b2630, 0.5, 0.25);
/** The TV screen — on (a bright blue-white glow). Off is `M.glassDark`. */
const TV_ON = std(0x9fd8ff, 0.3, 0.1, 0x4aa8f0, 1.5);
const TV_SKY = std(0x6fe0ff, 0.3, 0.1, 0x2fc4ff, 1.9);
const TV_GROUND = std(0x3a8a6a, 0.4, 0.1, 0x1f7a58, 1.4);
const TV_SUN = std(0xffd28a, 0.3, 0.1, 0xffa640, 2.2);
/** The warm light of the gramophone · jukebox (on). */
const WARM_GLOW = std(0xffe3a0, 0.3, 0, 0xffb050, 2.3);
/** The jukebox window (on) — the inside shines amber through it. */
const JUKE_WINDOW_ON = std(0xffd8a8, 0.25, 0.1, 0xff9a50, 1.3);

const caseCache = new Map<string, THREE.MeshStandardMaterial>();
/** Media case · sleeve material (rarity colour, a faint glow so it reads in a dark room too). */
function caseMat(rarity: Rarity): THREE.MeshStandardMaterial {
  const css = RARITY_COLORS[rarity];
  let m = caseCache.get(css);
  if (!m) {
    const c = new THREE.Color(css);
    m = std(c.getHex(), 0.55, 0.15, c.getHex(), 0.22);
    caseCache.set(css, m);
  }
  return m;
}
const neonCache = new Map<string, THREE.MeshStandardMaterial>();
/** A neon tube (on = a strong glow, off = the same colour darkened · no glow). */
function neon(css: string, on: boolean): THREE.MeshStandardMaterial {
  const key = `${css}|${on ? 1 : 0}`;
  let m = neonCache.get(key);
  if (!m) {
    const c = new THREE.Color(css);
    m = on ? std(c.getHex(), 0.3, 0.05, c.getHex(), 2.6) : std(c.clone().multiplyScalar(0.35).getHex(), 0.5, 0.2);
    neonCache.set(key, m);
  }
  return m;
}

/* ── 2026-09-13 video-game materials (shared · never disposed) ── */
/**
 * The TV game screen · the HUD inside it. **Only these two** change emissive colour · intensity during a game session
 * (`GameStaging`) — a local session runs one at a time, so no per-piece copy is needed. Both are opaque
 * `MeshStandardMaterial`, so showing them for the first time uses a program that already exists.
 */
export const TV_GAME_SCREEN = std(0x10202c, 0.35, 0.1, 0x3aa8ff, 1.2);
export const TV_GAME_HUD = std(0xe8f4ff, 0.3, 0.05, 0xdfefff, 1.6);
/** The game screen's judgement zone (a band that shows through darkly). */
const TV_GAME_ZONE = std(0x2a3440, 0.4, 0.1, 0x8fb0c8, 0.55);
const CONSOLE_BLACK = std(0x121418, 0.28, 0.45);
const CONSOLE_WHITE = std(0xd9dde2, 0.35, 0.2);
const CONSOLE_GREEN = std(0x6dff9a, 0.3, 0.05, 0x2cff6a, 2.0);
const CUP = std(0xd8d2c4, 0.6, 0.05);

const gameCaseCache = new Map<string, THREE.MeshStandardMaterial>();
/** Game disc case material (`GameDiscDef.color`, a faint glow so it reads in a dark room too). A malformed colour becomes white. Cached forever. */
function gameCaseMat(css: string): THREE.MeshStandardMaterial {
  let m = gameCaseCache.get(css);
  if (!m) {
    const c = new THREE.Color(0xffffff);
    try { c.set(css); } catch { /* malformed colour → white */ }
    m = std(c.getHex(), 0.5, 0.15, c.getHex(), 0.35);
    gameCaseCache.set(css, m);
  }
  return m;
}
const fabricCache = new Map<string, THREE.MeshStandardMaterial>();
/** Fabric material — the catalogue colour darkened by `mul`, matte (sofa · rug). No glow. Cached forever. */
function fabricMat(css: string, mul: number): THREE.MeshStandardMaterial {
  const key = `${css}|${mul}`;
  let m = fabricCache.get(key);
  if (!m) {
    const c = new THREE.Color(css).multiplyScalar(mul);
    m = std(c.getHex(), 0.96, 0.02);
    fabricCache.set(key, m);
  }
  return m;
}

/** The original CSS colour of the accent material (`Furniture.tint`) — so the neon tubes follow the catalogue colour. */
function accentCss(a: THREE.Material): string {
  const c = (a as THREE.MeshStandardMaterial).color;
  return c instanceof THREE.Color ? `#${c.getHexString()}` : '#ffffff';
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
/** Fills one sub-group through `fill` and merges it. Its meshes go into `model.meshes`. */
function rigGroup(model: FurnitureModel, parent: THREE.Object3D, name: string, x: number, y: number, z: number, fill: (b: GeoBatch) => void): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  const b = new GeoBatch();
  fill(b);
  b.build(g, model.meshes);
  parent.add(g);
  return g;
}

/** The YXZ Euler that stands a (Y-axis) cylinder along the direction (dx, dy, dz) (a unit vector) — `GeoBatch.cyl`'s rx, ry. */
function aim(dx: number, dy: number, dz: number): { rx: number; ry: number } {
  return { rx: Math.acos(THREE.MathUtils.clamp(dy, -1, 1)), ry: Math.atan2(dx, dz) };
}

/** Lays a Y-axis cylinder down along X (barbell · plates · crank shaft). */
const ALONG_X = Math.PI / 2;

/*
 * The pose measurements match player's `SoldierModel` (`FURN_SIT` · `FURN_BENCH` · `FURN_CYCLE`, metres from the anchor) —
 * IK drops hands and feet exactly onto those points, so the furniture is built to meet them:
 *   sit   soles (±0.17, −0.36, front 0.40)                           → seat top 0.36
 *   bench soles (±0.36, −0.40, foot side 0.78) · hips foot side 0.42 → pad top 0.40
 *         fists (= the bar) phase 0: up 0.50 · foot side 0.03 / phase 1: up 0.81 · head side 0.06, grip x ±0.42
 *   cycle crank axis (0, −0.60, front 0.25) · radius 0.16 · pedals x ±0.13 · grips (±0.22, +0.14, front 0.50)
 */
/** Bench pad top height — the bench rack and the smith machine use the same bench. */
const PAD_TOP = 0.4;
/** The bench's foot-end · head-end z. The head side is +Z (the rack side). The foot end is just past the hips (z 0.18) — the soles (z −0.18) reach the floor beside the pad. */
const PAD_Z0 = -0.2, PAD_Z1 = 0.78;
/** The z of the shoulder blades of a body lying on the bench (0.18 m in from the pad's head end). */
const BENCH_SHOULDER_Z = 0.6;
/** Phase 0 · 1 positions of the bench-press bar (the fist centre) — measured from the pad top · the shoulder blades (up, head side +). */
const PRESS_LOW_UP = 0.5, PRESS_LOW_Z = -0.03, PRESS_HIGH_UP = 0.81, PRESS_HIGH_Z = 0.06;
/** Where the bar sits while exercising on the bench rack · smith machine (furniture-local). */
const BENCH_BAR_LOW = { y: PAD_TOP + PRESS_LOW_UP, z: BENCH_SHOULDER_Z + PRESS_LOW_Z };
const BENCH_BAR_HIGH = { y: PAD_TOP + PRESS_HIGH_UP, z: BENCH_SHOULDER_Z + PRESS_HIGH_Z };

/** The flat bench (pad · base plate · two legs · foot bars · spine beam). */
function flatBench(b: GeoBatch, a: THREE.Material): void {
  const len = PAD_Z1 - PAD_Z0, cz = (PAD_Z0 + PAD_Z1) / 2;
  b.box(0.3, 0.07, len, 0, PAD_TOP - 0.035, cz, BENCH_PAD);                                    // pad
  b.box(0.306, 0.014, len + 0.006, 0, PAD_TOP - 0.064, cz, a);                                 // piping
  b.box(0.26, 0.03, len - 0.06, 0, PAD_TOP - 0.086, cz, M.gunmetal);                           // base plate
  for (const lz of [PAD_Z0 + 0.14, PAD_Z1 - 0.16]) {
    b.boxB(0.06, PAD_TOP - 0.1, 0.06, 0, 0, lz, M.hullLight);                                  // leg
    b.box(0.46, 0.04, 0.07, 0, 0.02, lz, M.hullLight);                                         // foot bar
    for (const sx of [-1, 1]) b.box(0.07, 0.022, 0.08, sx * 0.23, 0.011, lz, RUBBER);          // rubber foot
  }
  b.box(0.06, 0.05, len - 0.36, 0, 0.065, cz, M.hullLight);                                    // spine beam
}

/** The barbell (shaft · knurling · sleeves · collars) + the plate group. `half` = half the shaft length, `sleeveIn` = the |x| where a sleeve starts. */
function barbell(model: FurnitureModel, parent: THREE.Object3D, y: number, z: number, half: number, sleeveIn: number, a: THREE.Material, extra: (b: GeoBatch) => void, gymActive: boolean): { bar: THREE.Group; plates: THREE.Group } {
  const bar = rigGroup(model, parent, 'barbell', 0, y, z, (b) => {
    b.cyl(0.016, 0.016, half * 2, 12, 0, 0, 0, CHROME, 0, 0, ALONG_X);                         // shaft
    for (const sx of [-1, 1]) {
      b.cyl(0.019, 0.019, 0.22, 12, sx * 0.27, 0, 0, M.gunmetal, 0, 0, ALONG_X);               // knurling
      const sl = half - sleeveIn;
      b.cyl(0.026, 0.026, sl, 12, sx * (sleeveIn + sl / 2), 0, 0, CHROME, 0, 0, ALONG_X);      // sleeve
      b.cyl(0.042, 0.042, 0.026, 14, sx * (sleeveIn + 0.013), 0, 0, M.trim, 0, 0, ALONG_X);    // collar
    }
    extra(b);
  });
  const plates = rigGroup(model, bar, 'plates', 0, 0, 0, (b) => {
    for (const sx of [-1, 1]) {
      const x0 = sleeveIn + 0.03;
      b.cyl(0.22, 0.22, 0.04, 28, sx * (x0 + 0.02), 0, 0, PLATE, 0, 0, ALONG_X);               // large plate
      b.cyl(0.224, 0.224, 0.012, 28, sx * (x0 + 0.02), 0, 0, a, 0, 0, ALONG_X);                // plate rim (accent)
      b.cyl(0.16, 0.16, 0.034, 24, sx * (x0 + 0.058), 0, 0, PLATE, 0, 0, ALONG_X);             // small plate
      b.cyl(0.05, 0.05, 0.08, 14, sx * (x0 + 0.04), 0, 0, CHROME, 0, 0, ALONG_X);              // hub
      b.cyl(0.036, 0.036, 0.02, 12, sx * (x0 + 0.09), 0, 0, M.stripRed, 0, 0, ALONG_X);        // clip
    }
  });
  plates.visible = gymActive;
  return { bar, plates };
}

/* ── Builders ─────────────────────────────────────────────────────────────── */
type LeisureBuilder = (b: GeoBatch, model: FurnitureModel, w: number, d: number, h: number, a: THREE.Material, extra?: BuildExtra) => void;

/** Pads the media slot array to `n` slots (an empty slot = null). */
function slotsOf(extra: BuildExtra | undefined, n: number): (Rarity | null)[] {
  const out: (Rarity | null)[] = new Array(n).fill(null);
  const src = extra?.media ?? [];
  for (let i = 0; i < n && i < src.length; i++) out[i] = src[i] ?? null;
  return out;
}

/* ── 2026-09-13 video-game helpers ──────────────────────────────────────── */

/** How many console looks there are (`BuildExtra.consoleLook` 0 … 2); 3 = the generic box of an unknown console. */
export const TV_CONSOLE_LOOKS = 3;

/** One controller pad (body · two grips · buttons) — it sits on the top face `topY`. */
function controllerPad(b: GeoBatch, x: number, topY: number, z: number, body: THREE.Material, accent: THREE.Material, ry: number): void {
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
  { const [px, pz] = at(0, 0); b.box(0.12, 0.024, 0.06, px, topY + 0.012, pz, body, ry); }
  for (const sx of [-1, 1]) { const [px, pz] = at(sx * 0.055, 0.02); b.cyl(0.022, 0.022, 0.024, 10, px, topY + 0.012, pz, body); }
  { const [px, pz] = at(0.03, -0.01); b.box(0.022, 0.006, 0.022, px, topY + 0.027, pz, accent, ry); }
  { const [px, pz] = at(-0.03, -0.01); b.box(0.026, 0.006, 0.008, px, topY + 0.027, pz, M.hullLight, ry); }
}

/**
 * Console kind (`GameConsoleDef.console`, `data/game_consoles.csv`) → look. For a kind that is not in the table,
 * `FurnitureLayer.consoleLookOf` picks one of the three by its index in the catalogue's kind list (every client holds
 * the same catalogue, so every client draws the same look).
 */
export const TV_CONSOLE_LOOK_BY_KIND: Readonly<Record<string, number>> = { pulse: 0, retro: 1, holo: 2 };

/**
 * The console on the TV's top plate (`look` = `BuildExtra.consoleLook`). It stands on the left of the top plate at
 * x −0.56 (clear of the sound bar ±0.4 · the stand ±0.21), the pad on the right.
 *  0 pulse station — a low wide black slab · a cyan strip on top · a disc slot at the front
 *  1 retro cube    — a white cube · a cartridge slot on top · a green power light at the front · a purple stripe
 *  2 holo deck     — a wide low black deck · a cyan holo column rising off an emitter disc on top (opaque glow — no new shader)
 *  3 generic       — an unknown console: a gunmetal box + a green LED
 */
function tvConsole(b: GeoBatch, look: number, topY: number, a: THREE.Material): void {
  const x = -0.56, z = -0.04;
  switch (look) {
    case 0:
      b.boxB(0.3, 0.06, 0.22, x, topY, z, CONSOLE_BLACK);
      b.box(0.24, 0.006, 0.02, x, topY + 0.063, z, M.stripCyan);
      b.box(0.14, 0.008, 0.004, x, topY + 0.03, z - 0.112, M.floorGrate);
      controllerPad(b, 0.56, topY, -0.08, CONSOLE_BLACK, M.stripCyan, 0.3);
      break;
    case 1:
      b.boxB(0.2, 0.2, 0.2, x, topY, z, CONSOLE_WHITE);
      b.box(0.12, 0.012, 0.03, x, topY + 0.2, z + 0.02, M.floorGrate);                              // cartridge slot
      b.box(0.204, 0.018, 0.204, x, topY + 0.14, z, neon('#b89aff', true));                         // purple stripe
      b.box(0.02, 0.02, 0.004, x + 0.06, topY + 0.05, z - 0.102, CONSOLE_GREEN);                    // power light
      controllerPad(b, 0.56, topY, -0.08, CONSOLE_WHITE, CONSOLE_GREEN, -0.25);
      break;
    case 2:
      b.boxB(0.3, 0.045, 0.22, x, topY, z, CONSOLE_BLACK);
      b.cyl(0.075, 0.085, 0.012, 20, x, topY + 0.051, z, M.gunmetal);                               // emitter base
      b.cyl(0.06, 0.06, 0.004, 20, x, topY + 0.059, z, M.stripCyan);                                // emitter disc
      b.cyl(0.008, 0.02, 0.16, 10, x, topY + 0.14, z, M.stripCyan);                                 // holo column
      b.box(0.24, 0.006, 0.004, x, topY + 0.022, z - 0.112, a);                                     // front strip
      controllerPad(b, 0.56, topY, -0.08, CONSOLE_BLACK, M.stripCyan, 0.15);
      break;
    default:
      b.boxB(0.26, 0.07, 0.2, x, topY, z, M.gunmetal);
      b.box(0.02, 0.012, 0.004, x + 0.09, topY + 0.035, z - 0.102, CONSOLE_GREEN);
      b.box(0.2, 0.008, 0.004, x - 0.02, topY + 0.035, z - 0.102, a);
      controllerPad(b, 0.56, topY, -0.08, M.gunmetal, a, 0.2);
      break;
  }
}

/**
 * The TV game screen (`model.tv`): a plate laid a few mm in front of the screen (−Z) · the judgement zone band · the
 * moving marker · the progress bar. The plate is `TV_GAME_SCREEN`, the marker and the bar are `TV_GAME_HUD` — both are
 * shared, so `GameStaging` changes only colour · intensity. The group is hidden unless `active` (an invisible branch is
 * neither drawn nor counted).
 */
function tvGameOverlay(model: FurnitureModel, cy: number, sw: number, sh: number, active: boolean): void {
  const overlay = rigGroup(model, model.group, 'tv-game', 0, cy, 0, (ob) => {
    ob.box(sw, sh, 0.003, 0, 0, 0.008, TV_GAME_SCREEN);                                            // plate (in front of the screen's front face at 0.0115)
    ob.box(sw * 0.16, sh * 0.62, 0.0015, 0, 0.03, 0.00525, TV_GAME_ZONE);                           // judgement zone
    ob.box(sw * 0.8, 0.026, 0.0015, 0, -sh / 2 + 0.06, 0.00525, M.hullDark);                        // progress bar backing
  });
  const marker = rigGroup(model, overlay, 'tv-game-marker', 0, 0.03, 0.0035, (mb) => {
    mb.box(0.035, sh * 0.5, 0.0015, 0, 0, 0, TV_GAME_HUD);
  });
  const progress = rigGroup(model, overlay, 'tv-game-progress', -sw * 0.4, -sh / 2 + 0.06, 0.0035, (pb) => {
    pb.box(sw * 0.8, 0.018, 0.0015, sw * 0.4, 0, 0, TV_GAME_HUD);
  });
  progress.scale.x = 0.001;
  overlay.visible = active;
  model.tv = { screen: new THREE.Vector3(0, cy, 0.0115), screenW: sw, screenH: sh, overlay, marker, progress };
}

export const LEISURE_BUILDERS: Record<LeisureKind, LeisureBuilder> = {
  /**
   * Disc stand (`3 × 1 · 1.8`): a metal-framed display cabinet — three shelves with two slots each (`SHELF_SLOTS.disc`),
   * and in every slot a disc case standing tilted slightly forward. The case's back panel is the **rarity colour** and the
   * silvery disc face shows in front of it. An empty slot keeps only its base. Under the front edge of every shelf runs a
   * white LED strip (emissive), which is what makes it read as a display cabinet.
   */
  disc_stand: (b, _model, w, d, h, a, extra) => {
    const n = SHELF_SLOTS.disc;
    const slots = slotsOf(extra, n);
    b.boxB(w - 0.04, 0.1, d - 0.04, 0, 0, 0, M.gunmetal);                                        // base
    for (const sx of [-1, 1]) b.boxB(0.05, h, d, sx * (w / 2 - 0.025), 0, 0, M.hullLight);       // side plate
    b.box(w - 0.1, h - 0.1, 0.03, 0, h / 2, d / 2 - 0.02, M.hullDark);                           // back panel
    b.box(w, 0.06, d, 0, h - 0.03, 0, M.hullLight);                                              // ceiling
    b.box(w - 0.2, 0.035, 0.03, 0, h - 0.08, -(d / 2 - 0.015), a);                               // ceiling accent
    const rows = 3, perRow = Math.ceil(n / rows);
    const y0 = 0.14, rowH = (h - 0.26) / rows;
    const tilt = 0.14;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * rowH;
      b.box(w - 0.1, 0.035, d - 0.06, 0, y, 0.01, M.gunmetal);                                   // shelf
      b.box(w - 0.12, 0.045, 0.025, 0, y + 0.035, -(d / 2 - 0.06), M.trim);                      // display lip
      b.box(w - 0.18, 0.012, 0.03, 0, y + rowH - 0.04, -(d / 2 - 0.07), M.stripWhite);           // shelf light (under the shelf above)
      for (let k = 0; k < perRow; k++) {
        const slot = (rows - 1 - r) * perRow + k;                                               // 0 = top left
        if (slot >= n) continue;
        const cx = (k - (perRow - 1) / 2) * ((w - 0.2) / perRow);
        const rarity = slots[slot];
        b.box(0.22, 0.02, 0.1, cx, y + 0.028, -0.02, M.hullDark);                                // base
        if (!rarity) continue;
        const cm = caseMat(rarity);
        const cy = y + 0.2;
        b.box(0.3, 0.3, 0.035, cx, cy, 0, cm, 0, tilt);                                          // case (rarity colour)
        b.cyl(0.12, 0.12, 0.006, 28, cx, cy + 0.003, -0.024, DISC_FACE, ALONG_X + tilt);         // disc face
        b.cyl(0.03, 0.03, 0.008, 12, cx, cy + 0.003, -0.027, M.gunmetal, ALONG_X + tilt);        // hub
        b.box(0.12, 0.03, 0.008, cx, y + 0.04, -(d / 2 - 0.044), cm);                            // rarity tag
      }
    }
  },

  /**
   * Record rack (`3 × 2 · 1.2`): a short-legged wooden cabinet (two compartments of record spines across its front) with a
   * divided **record bin** on top. In every bin slot (`SHELF_SLOTS.record`) a filed record stands as a rarity-coloured
   * sleeve, the black disc rising halfway out of it. A headboard behind it, with an accent strip.
   */
  record_rack: (b, _model, w, d, h, a, extra) => {
    const n = SHELF_SLOTS.record;
    const slots = slotsOf(extra, n);
    const legH = 0.14;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(0.026, 0.017, legH, 8, sx * (w / 2 - 0.12), legH / 2, sz * (d / 2 - 0.12), M.gunmetal);
    const cabH = 0.46, cabTop = legH + cabH;
    b.boxB(w - 0.02, cabH, d - 0.04, 0, legH, 0, WOOD);                                          // cabinet
    b.box(w, 0.035, d, 0, cabTop + 0.0175, 0, WOOD_DARK);                                        // top plate
    const fz = -(d / 2 - 0.02);
    for (const sx of [-1, 1]) {
      const cx = sx * (w / 4);
      b.box(w / 2 - 0.12, cabH - 0.12, 0.012, cx, legH + cabH / 2, fz - 0.006, M.floorGrate);    // compartment (dark inside)
      for (let k = 0; k < 9; k++) {
        const sh = cabH - 0.2 - ((k * 5) % 3) * 0.025;
        b.boxB(0.028, sh, 0.012, cx - 0.2 + k * 0.05, legH + 0.07, fz - 0.014, k % 3 === 0 ? a : k % 2 ? M.padding : M.fabric);   // record spine
      }
    }
    b.box(w - 0.1, 0.03, 0.014, 0, legH + 0.03, fz - 0.008, a);                                  // front accent
    // ── record bin
    const binY = cabTop + 0.035, binH = 0.26, binD = d - 0.32, binZ = -0.03;
    b.box(w - 0.06, 0.02, binD, 0, binY + 0.01, binZ, WOOD_DARK);                                // bin floor
    b.box(w - 0.06, 0.1, 0.03, 0, binY + 0.05, binZ - binD / 2, WOOD);                           // front lip
    b.box(w - 0.06, binH, 0.03, 0, binY + binH / 2, binZ + binD / 2, WOOD);                      // back wall
    for (const sx of [-1, 1]) b.box(0.03, binH, binD, sx * (w / 2 - 0.045), binY + binH / 2, binZ, WOOD);
    const inner = w - 0.12, cell = inner / n;
    for (let i = 1; i < n; i++) b.box(0.014, binH * 0.72, binD - 0.06, -inner / 2 + i * cell, binY + binH * 0.36, binZ, M.gunmetal);   // dividers
    // headboard + accent light
    const headZ = d / 2 - 0.05;
    b.box(w - 0.06, h - binY, 0.03, 0, (binY + h) / 2, headZ, WOOD_DARK);
    b.box(w - 0.24, 0.03, 0.02, 0, h - 0.06, headZ - 0.025, a);
    const tilt = 0.18, sy = binY + 0.02 + 0.15;
    for (let k = 0; k < n; k++) {
      const cx = -inner / 2 + (k + 0.5) * cell;
      const rarity = slots[k];
      b.box(0.1, 0.022, 0.008, cx, binY + 0.07, binZ - binD / 2 - 0.018, rarity ? caseMat(rarity) : M.hullDark);   // slot tag
      if (!rarity) continue;
      const cm = caseMat(rarity);
      b.box(0.3, 0.3, 0.02, cx, sy, binZ, cm, 0, tilt);                                          // sleeve (rarity colour)
      b.cyl(0.05, 0.05, 0.004, 16, cx, sy - 0.02, binZ - 0.013, a, ALONG_X + tilt);               // sleeve label
      b.cyl(0.14, 0.14, 0.008, 28, cx, sy + 0.066, binZ + 0.028, VINYL, ALONG_X + tilt);         // the disc rising out
    }
  },

  /**
   * Rocking chair (`2 × 2 · 1.1`): two curved rockers (an arc built out of short boxes) · four legs · a cushioned seat ·
   * a backrest leaning back (two posts · a top rail · five slats) · armrests. **All of it inside the `rig.rock` group**, so
   * the whole chair rocks while someone sits in it (the pivot is the bottom of the arc = the group's origin).
   */
  rocking_chair: (_b, model, _w, _d, _h, a) => {
    const seatTop = SIT_SEAT_TOP;                                                                 // player FURN_SIT: the soles sit 0.36 m below the seat top
    const seatBoard = seatTop - 0.05;                                                             // seat board top (under the cushion)
    const armY = seatTop + 0.19;
    const rock = rigGroup(model, model.group, 'rock', 0, 0, 0, (b) => {
      const R = 1.35, span = 0.35, segs = 8;
      for (const sx of [-1, 1]) {
        for (let i = 0; i < segs; i++) {
          const am = -span + (2 * span) * (i + 0.5) / segs;
          const len = 2 * R * Math.sin(span / segs) + 0.012;
          b.box(0.045, 0.045, len, sx * 0.28, R * (1 - Math.cos(am)) + 0.0225, R * Math.sin(am), WOOD_DARK, 0, -am);   // rocker
        }
        b.boxB(0.042, seatBoard - 0.085, 0.042, sx * 0.28, 0.05, -0.2, WOOD);                    // front leg
        b.boxB(0.042, seatBoard - 0.09, 0.042, sx * 0.28, 0.055, 0.22, WOOD);                    // rear leg
        b.box(0.036, 0.03, 0.42, sx * 0.28, 0.16, 0.01, WOOD_DARK);                              // side beam
      }
      b.box(0.56, 0.03, 0.03, 0, 0.14, -0.2, WOOD_DARK);                                          // front beam
      b.box(0.62, 0.035, 0.52, 0, seatBoard - 0.0175, 0.01, WOOD);                               // seat board
      b.box(0.52, 0.05, 0.46, 0, seatTop - 0.025, 0.02, M.padding);                              // cushion
      b.box(0.53, 0.012, 0.012, 0, seatTop - 0.03, -0.215, a);                                   // cushion piping
      // backrest (along an axis leaning back by t)
      const t = 0.22, by = seatBoard, bz = 0.25;
      const along = (s: number): [number, number] => [by + s * Math.cos(t), bz + s * Math.sin(t)];
      for (const sx of [-1, 1]) { const [y, z] = along(0.4); b.box(0.046, 0.8, 0.046, sx * 0.27, y, z, WOOD, 0, t); }
      { const [y, z] = along(0.74); b.box(0.6, 0.09, 0.036, 0, y, z, WOOD, 0, t); b.box(0.42, 0.016, 0.01, 0, y + 0.022 * Math.sin(t), z - 0.022 * Math.cos(t), a, 0, t); }
      { const [y, z] = along(0.14); b.box(0.54, 0.04, 0.03, 0, y, z, WOOD, 0, t); }
      for (let k = 0; k < 5; k++) { const [y, z] = along(0.43); b.box(0.045, 0.54, 0.018, -0.2 + k * 0.1, y, z, WOOD_DARK, 0, t); }
      // armrests
      for (const sx of [-1, 1]) {
        b.box(0.07, 0.03, 0.56, sx * 0.31, armY, 0.0, WOOD);
        b.boxB(0.034, armY - seatBoard, 0.034, sx * 0.31, seatBoard, -0.2, WOOD);
        b.cyl(0.036, 0.036, 0.07, 10, sx * 0.31, armY, -0.28, WOOD_DARK, 0, 0, ALONG_X);
      }
    });
    model.rig = { pose: 'sit', anchor: new THREE.Vector3(0, seatTop, 0.02), forward: { x: 0, z: -1 }, rock };
  },

  /**
   * TV (`3 × 1 · 1.3`): a thin panel on a stand above a media console (two doors · a player in the middle compartment · a
   * front accent). With `extra.on` the screen glows and shows a sky · horizon · sun · UI bar inside it; off is dark glass
   * + a red standby light.
   *
   * 2026-09-13 (video games): the screen's **front** (−Z) is the TV's front — seats stand on that side and look at it. With
   * `extra.consoleLook` a console (three looks + the generic box) sits on the left of the top plate and a pad on the right.
   * A hidden game screen (`model.tv`) is always built in front of the screen and shows only during a game session.
   */
  tv: (b, model, w, d, _h, a, extra) => {
    const on = extra?.on === true;
    b.boxB(w - 0.04, 0.06, d - 0.06, 0, 0, 0, M.gunmetal);                                        // base
    b.boxB(w - 0.02, 0.4, d - 0.04, 0, 0.06, 0, M.hullDark);                                     // console
    b.box(w, 0.03, d, 0, 0.475, 0, M.hullLight);                                                 // top plate (top face 0.49)
    const fz = -(d - 0.04) / 2;
    for (const sx of [-1, 1]) {
      b.box(0.5, 0.32, 0.015, sx * 0.49, 0.27, fz - 0.0075, M.hullLight);                        // door
      b.box(0.012, 0.12, 0.02, sx * 0.27, 0.29, fz - 0.02, M.trim);                              // handle
    }
    b.box(0.38, 0.32, 0.01, 0, 0.27, fz - 0.005, M.floorGrate);                                  // middle compartment
    b.box(0.3, 0.07, 0.012, 0, 0.17, fz - 0.016, M.gunmetal);                                    // player front face
    b.box(0.2, 0.008, 0.004, -0.02, 0.19, fz - 0.024, M.hullDark);                               // disc slot
    b.box(0.04, 0.012, 0.004, 0.1, 0.155, fz - 0.024, on ? M.stripCyan : M.hullDark);            // playback light
    b.box(w - 0.12, 0.025, 0.014, 0, 0.09, fz - 0.012, a);                                       // front accent
    // stand + panel
    b.box(0.42, 0.02, 0.2, 0, 0.5, 0.04, M.gunmetal);
    b.boxB(0.07, 0.12, 0.04, 0, 0.51, 0.06, M.gunmetal);
    const cy = 0.94, sw = 1.28, sh = 0.6;
    b.box(1.34, 0.68, 0.045, 0, cy, 0.04, M.gunmetal);                                           // bezel (z 0.0175 … 0.0625)
    b.box(1.1, 0.4, 0.05, 0, cy, 0.085, M.hullDark);                                             // rear bulge
    b.box(sw, sh, 0.006, 0, cy, 0.0145, on ? TV_ON : M.glassDark);                               // screen
    if (on) {
      b.box(sw, 0.2, 0.004, 0, cy - sh / 2 + 0.1, 0.009, TV_GROUND);                             // below the horizon
      b.box(sw, 0.05, 0.004, 0, cy - sh / 2 + 0.225, 0.009, TV_SKY);                             // horizon band
      b.cyl(0.09, 0.09, 0.004, 24, 0.34, cy + 0.08, 0.009, TV_SUN, ALONG_X);                     // sun
      b.box(0.36, 0.028, 0.004, -0.4, cy + 0.22, 0.009, M.stripWhite);                           // UI bar
      b.box(0.22, 0.02, 0.004, -0.47, cy + 0.17, 0.009, a);
    }
    b.box(0.02, 0.012, 0.006, 0.6, cy - 0.325, 0.013, on ? M.stripWhite : M.stripRed);           // power light
    b.box(0.12, 0.01, 0.004, 0, cy - 0.325, 0.014, M.trim);                                      // logo
    // sound bar
    b.boxB(0.8, 0.06, 0.08, 0, 0.49, -0.16, M.hullDark);
    b.box(0.76, 0.03, 0.004, 0, 0.52, -0.2025, M.floorGrate);
    // 2026-09-13: the console (left of the top plate, clear of the sound bar · the stand) + the pad (right of the top plate)
    if (extra?.consoleLook !== undefined && extra.consoleLook !== null) tvConsole(b, extra.consoleLook, 0.49, a);
    // 2026-09-13: the game screen (built hidden — only a TV in session is `gameActive`)
    tvGameOverlay(model, cy, sw, sh, extra?.gameActive === true);
  },

  /**
   * Game disc stand (2026-09-13, `game_stand` — dimensions from csv): if the disc stand is 「a display cabinet」, this is
   * **a game shop's display unit**. A dark body with a neon rim in the catalogue colour, a pixel-patterned sign on its head,
   * and on every forward-tilted shelf a case standing **face out**. The case colour = that game disc's theme colour
   * (`extra.gameColors`, falling back to the rarity colour `extra.media`). Slot order is the disc stand's (0 = top left,
   * row first). No lights.
   */
  game_stand: (b, _model, w, d, h, a, extra) => {
    const n = SHELF_SLOTS.game;
    const colors = extra?.gameColors ?? [];
    const rarities = slotsOf(extra, n);
    const perRow = Math.max(1, Math.min(n, Math.floor((w - 0.16) / 0.3)));
    const rows = Math.ceil(n / perRow);
    const neonA = neon(accentCss(a), true);
    const signH = Math.min(0.24, h * 0.16), bodyTop = h - signH;
    b.boxB(w - 0.02, 0.12, d - 0.02, 0, 0, 0, M.gunmetal);                                        // base
    b.box(w - 0.1, 0.02, 0.012, 0, 0.06, -(d / 2) + 0.004, neonA);                                // base neon
    for (const sx of [-1, 1]) {
      b.boxB(0.06, bodyTop - 0.12, d - 0.04, sx * (w / 2 - 0.03), 0.12, 0, CONSOLE_BLACK);        // side plate
      b.box(0.012, bodyTop - 0.16, 0.012, sx * (w / 2 - 0.004), 0.14 + (bodyTop - 0.16) / 2, -(d / 2 - 0.03), neonA);   // side neon
    }
    b.box(w - 0.12, bodyTop - 0.12, 0.03, 0, 0.12 + (bodyTop - 0.12) / 2, d / 2 - 0.035, M.hullDark);   // back panel
    // sign: a plate above the body + a pixel pattern (accent · cyan · amber alternating)
    b.boxB(w, signH, d * 0.5, 0, bodyTop, d * 0.18, CONSOLE_BLACK);
    const px = Math.max(3, Math.floor((w - 0.2) / 0.07));
    for (let k = 0; k < px; k++) {
      const pm = k % 3 === 0 ? neonA : k % 3 === 1 ? M.stripCyan : M.stripAmber;
      const x = -(w - 0.2) / 2 + (k + 0.5) * ((w - 0.2) / px);
      const y = bodyTop + signH * (k % 2 ? 0.62 : 0.38);
      b.box(0.045, 0.045, 0.01, x, y, d * 0.18 - d * 0.25 - 0.004, pm);
    }
    // shelves + cases
    const y0 = 0.16, rowH = (bodyTop - 0.2) / rows, tilt = 0.22;
    const cw = Math.min(0.24, (w - 0.2) / perRow - 0.05), ch = Math.min(rowH - 0.1, cw * 1.3);
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * rowH;
      b.box(w - 0.12, 0.03, d - 0.08, 0, y, 0.0, M.gunmetal);                                     // shelf
      b.box(w - 0.14, 0.05, 0.02, 0, y + 0.035, -(d / 2 - 0.06), M.trim);                         // display lip
      b.box(w - 0.2, 0.01, 0.02, 0, y + rowH - 0.03, -(d / 2 - 0.07), M.stripWhite);              // shelf light (under the shelf above)
      for (let k = 0; k < perRow; k++) {
        const slot = (rows - 1 - r) * perRow + k;                                                 // 0 = top left
        if (slot >= n) continue;
        const cx = (k - (perRow - 1) / 2) * ((w - 0.2) / perRow);
        const color = colors[slot] ?? null;
        const rarity = rarities[slot];
        b.box(cw * 0.7, 0.02, 0.08, cx, y + 0.025, -0.04, M.hullDark);                            // base clip
        if (!color && !rarity) continue;
        const cm = color ? gameCaseMat(color) : caseMat(rarity ?? 'common');
        const cy = y + 0.02 + ch / 2;
        b.box(cw, ch, 0.03, cx, cy, 0.0, cm, 0, tilt);                                            // case (theme colour)
        b.box(cw * 0.78, ch * 0.5, 0.004, cx, cy + ch * 0.08, -0.018, M.screen, 0, tilt);         // cover art window
        b.box(cw * 0.78, ch * 0.1, 0.004, cx, cy + ch * 0.38, -0.018, M.stripWhite, 0, tilt);     // title band
      }
    }
  },

  /**
   * Sofa (2026-09-13, `sofa` — dimensions from csv): a base on short wooden legs · armrests on both sides · a backrest
   * leaning slightly back + 2–3 cushions (3 from 1.7 m wide on). **The sitting direction = the furniture's front (local
   * −Z)** — the backrest is +Z (the same contract as `access front`). Every cushion's seat top is one spot of `rig.seats`,
   * at height `SIT_SEAT_TOP` (player `FURN_SIT`'s feet reach the floor). The fabric is the catalogue colour darkened,
   * matte; only the piping is accent. No lights.
   */
  sofa: (b, model, w, d, h, a) => {
    const fabric = fabricMat(accentCss(a), 0.42), fabricDark = fabricMat(accentCss(a), 0.28);
    const legH = 0.06, baseTop = SIT_SEAT_TOP - 0.13;
    const armW = 0.15, inner = Math.max(0.6, w - armW * 2 - 0.04);
    const depth = Math.max(0.6, d - 0.04);
    const frontZ = -depth / 2, backZ = depth / 2;
    const backT = Math.min(0.22, depth * 0.3);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(0.03, 0.022, legH, 8, sx * (w / 2 - 0.1), legH / 2, sz * (depth / 2 - 0.08), WOOD_DARK);
    b.boxB(w - 0.04, baseTop - legH, depth, 0, legH, 0, fabricDark);                              // base
    b.box(w - 0.08, 0.016, 0.012, 0, legH + 0.03, frontZ - 0.004, a);                              // front piping
    for (const sx of [-1, 1]) {
      const armH = SIT_SEAT_TOP + 0.2;
      b.boxB(armW, armH - legH, depth, sx * (w / 2 - 0.02 - armW / 2), legH, 0, fabric);           // armrest
      b.box(armW + 0.01, 0.05, depth + 0.01, sx * (w / 2 - 0.02 - armW / 2), armH - 0.02, 0, fabricDark);   // armrest top
    }
    const backH = Math.max(SIT_SEAT_TOP + 0.3, h) - legH;
    b.box(w - 0.04, backH, backT, 0, legH + backH / 2, backZ - backT / 2, fabricDark, 0, 0.08);    // backrest frame (+rx = the top end leans back (+Z) — the same sign as the rocking chair)
    // cushions — the seat (top face = SIT_SEAT_TOP) · the back cushion (leaning back)
    const count = w >= 1.7 ? 3 : 2;
    const cw = inner / count;
    const seatFront = frontZ + 0.03, seatBack = backZ - backT - 0.02;
    const seatD = Math.max(0.3, seatBack - seatFront), seatZ = seatFront + seatD / 2;
    const seats: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const x = -inner / 2 + (i + 0.5) * cw;
      b.box(cw - 0.02, SIT_SEAT_TOP - baseTop + 0.01, seatD, x, (baseTop + SIT_SEAT_TOP) / 2 + 0.005, seatZ, fabric);   // seat cushion
      b.box(cw - 0.03, 0.012, 0.012, x, SIT_SEAT_TOP - 0.02, seatFront - 0.002, a);               // cushion piping
      const bh = Math.min(0.42, backH - (SIT_SEAT_TOP - legH) - 0.02);
      b.box(cw - 0.03, bh, 0.12, x, SIT_SEAT_TOP + bh / 2 + 0.01, seatBack - 0.02, fabric, 0, 0.16);    // back cushion (leaning back)
      seats.push(new THREE.Vector3(x, SIT_SEAT_TOP, seatZ + 0.04));
    }
    // the spot nearest the centre is the default anchor
    let mid = seats[0];
    for (const s of seats) if (Math.abs(s.x) < Math.abs(mid.x)) mid = s;
    model.rig = { pose: 'sit', anchor: mid.clone(), forward: { x: 0, z: -1 }, seats };
  },

  /**
   * Low table (2026-09-13, `low_table` — `FurnitureDef.low`, a low piece that never blocks the TV ↔ seat corridor): a thick
   * wooden top plate · four short legs · a lower shelf · an accent inlay along the top's edge, with two magazines · a cup ·
   * one pad on it. The height follows csv's `height`. No lights.
   */
  low_table: (b, _model, w, d, h, a) => {
    const top = Math.max(0.2, Math.min(h, 0.5));
    const tw = w - 0.08, td = d - 0.08;
    b.box(tw, 0.05, td, 0, top - 0.025, 0, WOOD);                                                 // top plate
    b.box(tw - 0.06, 0.004, 0.02, 0, top + 0.001, -(td / 2 - 0.05), a);                           // inlay (front)
    b.box(tw - 0.06, 0.004, 0.02, 0, top + 0.001, td / 2 - 0.05, a);                              // inlay (back)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.06, top - 0.05, 0.06, sx * (tw / 2 - 0.07), 0, sz * (td / 2 - 0.07), WOOD_DARK);   // legs
    b.box(tw - 0.2, 0.025, td - 0.2, 0, Math.max(0.05, top * 0.3), 0, WOOD_DARK);                  // lower shelf
    b.box(0.22, 0.012, 0.16, -tw * 0.22, top + 0.006, 0.02, M.padding, 0.2);                       // magazine
    b.box(0.22, 0.012, 0.16, -tw * 0.2, top + 0.018, 0.0, M.fabric, -0.1);
    b.cyl(0.035, 0.03, 0.09, 12, tw * 0.28, top + 0.045, -0.05, CUP);                              // cup
    controllerPad(b, tw * 0.05, top, 0.06, CONSOLE_BLACK, a, 0.5);                                 // pad
  },

  /**
   * Rug (2026-09-13, `rug` — `FurnitureDef.low`): a thin plate raised 1 cm off the floor (above the grid lines' top face at
   * 0.007 m, so there is no z-fighting) + a border band · inner rows of diamonds · fringes at both ends of the long side.
   * It never rises above 3 cm — a collider below `BODY_MIN` 0.12 m does not stop a step.
   */
  rug: (b, _model, w, d, _h, a) => {
    const base = fabricMat(accentCss(a), 0.5), border = fabricMat(accentCss(a), 0.26), light = fabricMat(accentCss(a), 0.85);
    const rw = w - 0.06, rd = d - 0.06;
    b.box(rw, 0.008, rd, 0, 0.014, 0, base);                                                      // plate (0.010 … 0.018)
    const bt = Math.min(0.12, Math.min(rw, rd) * 0.1);
    for (const sz of [-1, 1]) b.box(rw, 0.003, bt, 0, 0.0195, sz * (rd / 2 - bt / 2), border);    // border
    for (const sx of [-1, 1]) b.box(bt, 0.003, rd - bt * 2, sx * (rw / 2 - bt / 2), 0.0195, 0, border);
    const iw = rw - bt * 3, id = rd - bt * 3;
    b.box(iw, 0.002, 0.02, 0, 0.0195, -id / 2, light);                                             // inner border line
    b.box(iw, 0.002, 0.02, 0, 0.0195, id / 2, light);
    const long = rw >= rd;
    const diamonds = Math.max(2, Math.floor((long ? iw : id) / 0.4));
    for (let k = 0; k < diamonds; k++) {
      const t = -0.5 + (k + 0.5) / diamonds;
      const s = Math.min(0.22, Math.min(iw, id) * 0.3);
      b.box(s, 0.002, s, long ? t * iw : 0, 0.0198, long ? 0 : t * id, k % 2 ? light : a, Math.PI / 4);   // diamond
    }
    // fringes: both ends of the long side
    const fringeN = Math.max(4, Math.floor((long ? rd : rw) / 0.08));
    for (const s of [-1, 1]) {
      for (let k = 0; k < fringeN; k++) {
        const t = -0.5 + (k + 0.5) / fringeN;
        if (long) b.box(0.05, 0.004, 0.012, s * (rw / 2 + 0.022), 0.012, t * rd, light);
        else b.box(0.012, 0.004, 0.05, t * rw, 0.012, s * (rd / 2 + 0.022), light);
      }
    }
  },

  /**
   * Chair (`furn_chair` · `seat`, moved here from `Furniture.ts` on 2026-09-13): four steel legs · a cushioned seat · a
   * backrest leaning slightly back (+Z) — **front = −Z** is the sitting direction (the old model's backrest was +Z too —
   * the contract is unchanged). The seat top came down from the old `h × 0.5` to `SIT_SEAT_TOP` — a seated player's feet
   * reach the floor.
   */
  chair: (b, model, w, d, h) => {
    const seatY = SIT_SEAT_TOP - 0.025;
    b.box(w - 0.1, 0.05, d - 0.1, 0, seatY, 0, M.padding);
    b.box(w - 0.14, 0.03, d - 0.14, 0, seatY - 0.04, 0, M.hullDark);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxB(0.04, seatY - 0.05, 0.04, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), M.gunmetal);
    b.box(w - 0.12, h - seatY, 0.04, 0, seatY + (h - seatY) / 2, d / 2 - 0.07, M.padding, 0, -0.1);
    b.box(w - 0.16, 0.03, 0.03, 0, h - 0.02, d / 2 - 0.09, M.trim);
    model.rig = { pose: 'sit', anchor: new THREE.Vector3(0, SIT_SEAT_TOP, 0.0), forward: { x: 0, z: -1 } };
  },

  /**
   * Gramophone (`2 × 2 · 1.3`): a wooden box on a round wooden table · turntable · winding crank · tonearm, and a brass horn
   * rising behind it and flaring forward (five cylinders growing wider). With `extra.on` the **front nameplate · the record
   * label** glow warm and the record turns — the horn's mouth and throat, where the sound comes out, do not glow even when
   * it is on (2026-09-14, user's decision).
   */
  gramophone: (b, model, _w, _d, _h, a, extra) => {
    const on = extra?.on === true;
    const top = 0.62;
    b.cyl(0.42, 0.42, 0.04, 28, 0, top - 0.02, 0, WOOD);                                         // table top
    b.cyl(0.4, 0.4, 0.014, 28, 0, top - 0.047, 0, WOOD_DARK);
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI / 4 + k * Math.PI / 2;
      b.cyl(0.022, 0.016, top - 0.05, 8, Math.cos(ang) * 0.28, (top - 0.05) / 2, Math.sin(ang) * 0.28, WOOD_DARK);   // leg
    }
    b.cyl(0.3, 0.3, 0.025, 20, 0, 0.18, 0, WOOD_DARK);                                           // lower shelf
    for (let k = 0; k < 3; k++) b.cyl(0.15, 0.15, 0.008, 24, 0.02 * k, 0.197 + k * 0.009, -0.03, k === 1 ? a : VINYL);   // stack of discs
    // the box
    const bz = 0.06;
    b.boxB(0.42, 0.16, 0.42, 0, top, bz, WOOD);
    b.box(0.44, 0.022, 0.44, 0, top + 0.011, bz, M.trimDark);
    b.box(0.43, 0.012, 0.43, 0, top + 0.16, bz, M.trim);
    b.box(0.12, 0.05, 0.01, 0, top + 0.08, bz - 0.215, on ? WARM_GLOW : M.trimDark);             // front nameplate
    b.cyl(0.17, 0.17, 0.02, 28, -0.03, top + 0.176, 0.02, M.gunmetal);                           // turntable
    b.cyl(0.012, 0.012, 0.12, 8, 0.27, top + 0.09, 0.1, M.trim, 0, 0, ALONG_X);                  // winding crank
    b.cyl(0.02, 0.02, 0.05, 8, 0.33, top + 0.12, 0.1, WOOD_DARK);
    // tonearm · sound box
    b.box(0.022, 0.022, 0.2, 0.08, top + 0.21, 0.13, M.trim, -0.6);
    b.cyl(0.036, 0.036, 0.02, 12, 0.02, top + 0.205, 0.05, M.trim, ALONG_X);
    // horn: a neck rising from the box's rear corner → a bell flaring up and forward
    const ex = 0.14, ey = top + 0.34, ez = 0.22;
    b.cyl(0.03, 0.03, 0.18, 10, ex, top + 0.25, ez, M.trim);                                     // neck
    b.cyl(0.036, 0.036, 0.05, 10, ex, ey, ez, M.trimDark);                                       // elbow
    const dx = -0.2, dy = 0.45, dz = -0.87, dl = Math.hypot(dx, dy, dz);
    const ux = dx / dl, uy = dy / dl, uz = dz / dl;
    const { rx, ry } = aim(ux, uy, uz);
    const L = 0.26, ts = [0, 0.07, 0.13, 0.18, 0.22, L];
    const rad = (t: number): number => 0.03 + 0.22 * Math.pow(t / L, 2.2);
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1], tm = (t0 + t1) / 2;
      b.cyl(rad(t1), rad(t0), t1 - t0 + 0.004, 24, ex + ux * tm, ey + uy * tm, ez + uz * tm, M.trim, rx, ry);   // bell (wider at the far end)
    }
    // 2026-09-14 (user's decision): **no light comes out of where the sound comes out** — the horn's mouth and throat stay a
    // dark material whether it is on or off. What says it is on is the front nameplate · record label glow and the turning disc.
    const mt = L + 0.003;
    b.cyl(0.232, 0.232, 0.004, 28, ex + ux * mt, ey + uy * mt, ez + uz * mt, M.trimDark, rx, ry);   // horn mouth
    const tt = L + 0.006;
    b.cyl(0.06, 0.06, 0.004, 16, ex + ux * tt, ey + uy * tt, ez + uz * tt, M.hullDark, rx, ry);     // throat
    // the record (turns while on)
    const rec = rigGroup(model, model.group, 'record', -0.03, top + 0.19, 0.02, (rb) => {
      rb.cyl(0.16, 0.16, 0.006, 28, 0, 0, 0, VINYL);
      rb.cyl(0.05, 0.05, 0.008, 16, 0, 0.001, 0, on ? WARM_GLOW : a);
      rb.box(0.09, 0.002, 0.01, 0.1, 0.004, 0, M.hullLight);                                     // grain (so the turning is visible)
    });
    if (on) { model.spin = rec; model.spinRate = 3.5; }
  },

  /**
   * Jukebox (`2 × 2 · 1.8`): a burgundy body under a half-round arched roof. Across its front two neon tubes following the
   * arch · side neon posts · chrome trim · a disc window · a title card · a row of buttons · a chrome speaker grille. With
   * `extra.on` the neon · the windows · the title card glow (off = the same colour darkened).
   */
  jukebox: (b, _model, _w, _d, _h, a, extra) => {
    const on = extra?.on === true;
    const cabW = 0.9, cabD = 0.62, cz = 0.1, bodyTop = 1.27, R = cabW / 2;
    const fz = cz - cabD / 2;
    b.boxB(cabW + 0.06, 0.08, cabD + 0.06, 0, 0, cz, M.gunmetal);                                // base
    b.boxB(cabW, bodyTop - 0.08, cabD, 0, 0.08, cz, JUKE_BODY);                                  // body
    b.add(new THREE.CylinderGeometry(R, R, cabD, 28, 1, false, Math.PI / 2, Math.PI), JUKE_BODY, 0, bodyTop, cz, Math.PI / 2);   // arched roof
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.02, 24, 1, false, Math.PI / 2, Math.PI), on ? JUKE_WINDOW_ON : M.glassDark, 0, bodyTop - 0.05, fz - 0.005, Math.PI / 2);   // dome window
    const neonA = neon(accentCss(a), on);
    const neonB = neon('#8fe8ff', on);
    b.add(new THREE.TorusGeometry(0.425, 0.022, 8, 32, Math.PI), neonA, 0, bodyTop, fz - 0.022);  // outer neon arch
    b.add(new THREE.TorusGeometry(0.37, 0.015, 8, 28, Math.PI), neonB, 0, bodyTop, fz - 0.02);    // inner neon arch
    for (const sx of [-1, 1]) {
      b.box(0.045, bodyTop - 0.18, 0.045, sx * 0.425, 0.18 + (bodyTop - 0.18) / 2, fz - 0.022, neonA);   // side neon post
      b.box(0.02, bodyTop - 0.18, 0.03, sx * 0.37, 0.18 + (bodyTop - 0.18) / 2, fz - 0.012, CHROME);    // chrome trim
    }
    b.box(0.6, 0.3, 0.02, 0, 1.0, fz - 0.006, on ? JUKE_WINDOW_ON : M.glassDark);                // disc window
    b.cyl(0.12, 0.12, 0.006, 24, 0, 1.0, fz - 0.02, VINYL, ALONG_X);                             // the disc inside the window
    b.cyl(0.035, 0.035, 0.008, 12, 0, 1.0, fz - 0.024, a, ALONG_X);
    b.box(0.56, 0.1, 0.014, 0, 0.8, fz - 0.008, on ? M.stripWhite : M.hullLight);                // title card
    for (let k = 0; k < 8; k++) b.box(0.042, 0.026, 0.02, -0.2 + k * 0.057, 0.715, fz - 0.012, CHROME);   // buttons
    b.box(0.04, 0.06, 0.02, 0.3, 0.64, fz - 0.012, CHROME);                                      // coin slot
    b.box(0.62, 0.36, 0.01, 0, 0.4, fz - 0.006, M.floorGrate);                                   // speaker grille
    for (let k = 0; k < 5; k++) b.box(0.62, 0.012, 0.016, 0, 0.25 + k * 0.075, fz - 0.014, CHROME);
    b.box(cabW, 0.03, 0.02, 0, 0.1, fz - 0.01, CHROME);                                          // chrome foot
    b.box(0.14, 0.04, 0.1, 0, bodyTop + R + 0.01, cz - 0.16, CHROME);                            // top ornament
  },

  /**
   * Turntable (`3 × 2 · 1.0`): a turntable deck · amp · speaker on a floating slate cabinet (wooden top plate · grooves
   * across its front · a record compartment). With `extra.on` the base's LED strips · the strobe dots · the pitch slider ·
   * the amp's VU light up and the platter turns.
   */
  turntable: (b, model, w, d, _h, a, extra) => {
    const on = extra?.on === true;
    const led = on ? M.stripCyan : M.hullDark;
    b.boxB(w - 0.2, 0.08, d - 0.2, 0, 0, 0, M.floorGrate);                                       // recessed base
    for (const sz of [-1, 1]) b.box(w - 0.18, 0.02, 0.02, 0, 0.07, sz * (d / 2 - 0.1), led);       // LED strip
    for (const sx of [-1, 1]) b.box(0.02, 0.02, d - 0.18, sx * (w / 2 - 0.1), 0.07, 0, led);
    b.boxB(w, 0.46, d - 0.02, 0, 0.08, 0, SLATE);                                                // cabinet
    const top = 0.57;
    b.box(w, 0.03, d - 0.02, 0, top - 0.015, 0, WOOD);                                           // wooden top plate
    const fz = -(d - 0.02) / 2;
    for (const x of [-0.02, 0.36]) b.box(0.014, 0.4, 0.006, x, 0.31, fz - 0.003, M.floorGrate);   // groove
    b.box(0.46, 0.36, 0.008, -0.45, 0.31, fz - 0.004, M.floorGrate);                             // record compartment
    for (let k = 0; k < 11; k++) b.boxB(0.026, 0.3 - (k % 3) * 0.02, 0.008, -0.65 + k * 0.04, 0.15, fz - 0.01, k % 4 === 0 ? a : VINYL);
    b.box(w - 0.1, 0.014, 0.008, 0, top - 0.04, fz - 0.004, a);                                  // front accent
    // deck
    const dx = -0.28, dz = 0.02;
    b.boxB(0.52, 0.07, 0.42, dx, top, dz, M.gunmetal);
    b.box(0.5, 0.008, 0.4, dx, top + 0.074, dz, M.hullDark);
    const px = dx - 0.04, py = top + 0.085;
    b.cyl(0.168, 0.168, 0.015, 32, px, py, dz, CHROME);                                          // platter base
    b.cyl(0.03, 0.03, 0.03, 12, dx + 0.18, top + 0.09, dz + 0.12, CHROME);                       // tonearm pivot
    b.box(0.012, 0.012, 0.25, -0.15, top + 0.11, 0.025, CHROME, Math.atan2(-0.4, -0.92));        // tonearm
    b.box(0.03, 0.01, 0.05, -0.2, top + 0.105, -0.09, M.hullDark, Math.atan2(-0.4, -0.92));      // headshell
    b.box(0.012, 0.01, 0.1, dx + 0.22, top + 0.078, dz - 0.1, on ? M.stripCyan : M.hullDark);    // pitch slider
    b.cyl(0.02, 0.02, 0.01, 12, dx + 0.2, top + 0.079, dz - 0.16, on ? M.stripWhite : M.hullLight);   // start button
    // amp
    b.boxB(0.3, 0.1, 0.3, 0.15, top, 0.02, M.gunmetal);
    b.box(0.16, 0.03, 0.006, 0.15, top + 0.06, -0.133, on ? M.stripAmber : M.hullDark);           // VU
    for (const kx of [0.06, 0.24]) b.cyl(0.018, 0.018, 0.02, 10, kx, top + 0.04, -0.14, M.trim, ALONG_X);
    // speaker
    b.boxB(0.28, 0.4, 0.28, 0.55, top, 0.05, M.hullDark);
    b.cyl(0.09, 0.09, 0.012, 20, 0.55, top + 0.13, -0.096, M.floorGrate, ALONG_X);               // woofer
    b.cyl(0.05, 0.05, 0.016, 16, 0.55, top + 0.13, -0.098, M.gunmetal, ALONG_X);
    b.cyl(0.03, 0.03, 0.012, 12, 0.55, top + 0.3, -0.096, CHROME, ALONG_X);                      // tweeter
    b.box(0.2, 0.012, 0.004, 0.55, top + 0.37, -0.092, a);
    // the record on the platter (turns while on)
    const rec = rigGroup(model, model.group, 'platter', px, py + 0.011, dz, (rb) => {
      rb.cyl(0.155, 0.155, 0.006, 32, 0, 0, 0, VINYL);
      rb.cyl(0.05, 0.05, 0.008, 16, 0, 0.001, 0, a);
      rb.cyl(0.006, 0.006, 0.03, 6, 0, 0.012, 0, CHROME);                                        // spindle
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        rb.box(0.012, 0.004, 0.006, Math.cos(ang) * 0.162, -0.006, Math.sin(ang) * 0.162, on ? M.stripWhite : M.hullDark, -ang);   // strobe dot
      }
    });
    if (on) { model.spin = rec; model.spinRate = 3.5; }
  },

  /**
   * Bench rack (`3 × 5 · 1.6`): two uprights carrying J hooks at the head side (+Z) · a top crossbar · floor feet, a flat
   * bench between them, the barbell on the hooks. The plates show **only during a session** (`extra.gymActive` →
   * `rig.plates.visible`). The barbell is the `rig.bar` group, so while exercising it leaves the hooks for above the chest
   * (`barPress`) and travels up and down.
   */
  bench_rack: (b, model, _w, _d, _h, a, extra) => {
    // The bar on the J hooks sits a little below the arms-extended height (BENCH_BAR_HIGH 1.21) — it reads as being lifted up and out
    const upZ = 0.95, upX = 0.5, hookY = BENCH_BAR_HIGH.y - 0.07, restZ = 0.85;
    b.box(1.14, 0.05, 0.08, 0, 0.025, upZ + 0.05, M.gunmetal);                                   // floor crossbar
    for (const sx of [-1, 1]) {
      b.box(0.08, 0.05, 0.56, sx * upX, 0.025, upZ, M.gunmetal);                                 // foot
      for (const sz of [-1, 1]) b.box(0.1, 0.022, 0.08, sx * upX, 0.011, upZ + sz * 0.24, RUBBER);
      b.boxB(0.075, 1.52, 0.075, sx * upX, 0.05, upZ, M.hullLight);                              // upright
      for (let k = 0; k < 10; k++) b.box(0.026, 0.012, 0.004, sx * upX, 0.46 + k * 0.09, upZ - 0.0395, M.floorGrate);   // row of holes
      b.box(0.004, 0.9, 0.03, sx * (upX + 0.0395), 0.95, upZ, a);                                // outer accent
      b.box(0.09, 0.03, 0.09, sx * upX, 1.585, upZ, M.trim);                                     // upright cap
      b.box(0.05, 0.03, 0.15, sx * upX, hookY - 0.033, restZ + 0.03, M.trim);                    // J hook floor
      b.box(0.05, 0.07, 0.02, sx * upX, hookY - 0.012, restZ - 0.05, M.trim);                    // J hook lip
    }
    b.box(1.0, 0.05, 0.05, 0, 1.49, upZ, M.gunmetal);                                            // top crossbar
    flatBench(b, a);
    const { bar, plates } = barbell(model, model.group, hookY, restZ, 0.72, 0.545, a, () => { /* no extra */ }, extra?.gymActive === true);
    model.rig = {
      pose: 'bench',
      anchor: new THREE.Vector3(0, PAD_TOP, BENCH_SHOULDER_Z),
      forward: { x: 0, z: 1 },
      focus: new THREE.Vector3(0, 0.78, 0.3),
      camDist: 2.9, camUp: 0.55,
      bar, plates,
      barRest: { y: hookY, z: restZ },
      barPress: { low: { ...BENCH_BAR_LOW }, high: { ...BENCH_BAR_HIGH } },
    };
  },

  /**
   * Smith machine (`4 × 5 · 2.2`): two chrome rails stand through the middle of a cage of four uprights · a top frame · a
   * floor frame, and the barbell is caught on the rails' sliders so it moves **vertically only**. Safety stops · rest pins
   * on the rails, and below them the same flat bench as the bench rack. Plates only during a session.
   */
  smith_machine: (b, model, _w, _d, _h, a, extra) => {
    // The rails are vertical, so the bar's z is fixed — it stands at the middle of player's fist path (z 0.57 → 0.66), off by ±4.5 cm at either end
    const railZ = (BENCH_BAR_LOW.z + BENCH_BAR_HIGH.z) / 2, railX = 0.72, restY = BENCH_BAR_HIGH.y - 0.06, topY = 2.16;
    for (const sz of [-1, 1]) b.box(1.9, 0.06, 0.08, 0, 0.03, sz * 1.15, M.gunmetal);          // floor frame
    for (const sx of [-1, 1]) b.box(0.08, 0.06, 2.3, sx * 0.92, 0.03, 0, M.gunmetal);
    for (const pz of [-0.05, 1.05]) {
      for (const sx of [-1, 1]) {
        b.boxB(0.08, topY - 0.06, 0.08, sx * 0.92, 0.06, pz, M.hullLight);                       // upright
        if (pz < 0) b.box(0.004, 1.4, 0.03, sx * 0.9605, 1.1, pz, a);                            // front upright accent
      }
      b.box(1.92, 0.08, 0.08, 0, topY, pz, M.hullLight);                                         // top frame (across)
    }
    for (const sx of [-1, 1]) {
      b.box(0.08, 0.08, 1.18, sx * 0.92, topY, 0.5, M.hullLight);                                // top frame (lengthwise)
      b.cyl(0.02, 0.02, 2.0, 10, sx * railX, 1.1, railZ, CHROME);                                // rail
      b.box(0.12, 0.05, 0.12, sx * railX, 0.085, railZ, M.gunmetal);                             // rail foot
      b.box(0.2, 0.05, 0.06, sx * 0.82, 0.085, railZ, M.gunmetal);
      b.box(0.2, 0.05, 0.05, sx * 0.82, 2.1, railZ, M.gunmetal);                                 // rail top arm
      b.box(0.08, 0.04, 0.12, sx * railX, BENCH_BAR_LOW.y - 0.1, railZ, M.trim);                 // safety stop (just below chest height)
      b.box(0.05, 0.03, 0.1, sx * railX, restY - 0.075, railZ + 0.07, M.trim);                   // rest pin
    }
    b.box(1.6, 0.06, 0.06, 0, 2.1, railZ, M.gunmetal);                                           // rail top crossbar
    b.box(0.5, 0.06, 0.012, 0, topY, -0.096, a);                                                 // front nameplate
    flatBench(b, a);
    const { bar, plates } = barbell(model, model.group, restY, railZ, 0.9, 0.78, a, (bb) => {
      for (const sx of [-1, 1]) {
        bb.box(0.08, 0.12, 0.08, sx * railX, 0, 0, M.hullLight);                                 // slider
        bb.box(0.03, 0.03, 0.08, sx * railX, -0.03, 0.07, M.trim);                               // rest hook
      }
    }, extra?.gymActive === true);
    model.rig = {
      pose: 'bench',
      anchor: new THREE.Vector3(0, PAD_TOP, BENCH_SHOULDER_Z),
      forward: { x: 0, z: 1 },
      focus: new THREE.Vector3(0, 0.9, 0.3),
      camDist: 3.2, camUp: 0.6,
      bar, plates,
      barRest: { y: restY, z: railZ },
      barPress: { low: { y: BENCH_BAR_LOW.y, z: railZ }, high: { y: BENCH_BAR_HIGH.y, z: railZ } },
    };
  },

  /**
   * Treadmill (`2 × 4 · 1.4`): a motor cowl at the front (−Z) · two forward-leaning posts · a console (screen) tilted toward
   * the runner · handles, and on the long deck behind them the running belt · foot rails · rollers. The belt stripes are the
   * `rig.belt` group, so they flow backwards (+Z) while running.
   */
  treadmill: (b, model, _w, _d, _h, a) => {
    b.boxB(0.84, 0.14, 1.7, 0, 0.02, 0.1, M.hullDark);                                           // deck
    for (const sx of [-1, 1]) for (const sz of [-0.7, 0.9]) b.box(0.08, 0.022, 0.1, sx * 0.36, 0.011, sz, RUBBER);
    b.boxB(0.9, 0.2, 0.36, 0, 0, -0.78, M.hullLight);                                            // motor cowl
    b.box(0.8, 0.02, 0.01, 0, 0.13, -0.965, a);
    b.box(0.6, 0.006, 0.2, 0, 0.203, -0.78, M.floorGrate);
    for (const sx of [-1, 1]) {
      b.box(0.12, 0.05, 1.45, sx * 0.39, 0.185, 0.2, M.hullLight);                               // foot rail
      b.box(0.008, 0.016, 1.4, sx * 0.4535, 0.18, 0.2, a);
    }
    const beltTop = 0.19, zMin = -0.52, spacing = 0.18, n = 8;
    b.box(0.62, 0.02, n * spacing + 0.02, 0, beltTop - 0.01, zMin + n * spacing / 2, BELT);      // belt
    b.cyl(0.042, 0.042, 0.64, 12, 0, 0.15, zMin - 0.02, CHROME, 0, 0, ALONG_X);                  // front roller
    b.box(0.9, 0.09, 0.07, 0, 0.12, 0.965, M.hullLight);                                         // rear cap
    // posts · console · handles
    for (const sx of [-1, 1]) b.box(0.07, 1.12, 0.07, sx * 0.4, 0.76, -0.8, M.hullLight, 0, -0.12);
    const ct = 0.6;
    b.box(0.8, 0.08, 0.34, 0, 1.28, -0.83, M.hullDark, 0, ct);                                   // console
    b.box(0.46, 0.004, 0.2, 0, 1.28 + 0.042 * Math.cos(ct), -0.83 + 0.042 * Math.sin(ct), M.screen, 0, ct);   // screen
    b.box(0.76, 0.02, 0.012, 0, 1.28 + 0.17 * Math.sin(ct), -0.83 - 0.17 * Math.cos(ct), a, 0, ct);          // console front accent
    b.box(0.03, 0.03, 0.012, 0.26, 1.22, -0.7, M.stripRed);                                      // safety key
    for (const sx of [-1, 1]) {
      b.box(0.04, 0.04, 0.56, sx * 0.42, 1.08, -0.5, CHROME);                                    // handle
      b.box(0.05, 0.05, 0.2, sx * 0.42, 1.08, -0.34, RUBBER);
      b.box(0.04, 0.12, 0.04, sx * 0.42, 1.02, -0.22, CHROME);
    }
    const belt = rigGroup(model, model.group, 'belt', 0, beltTop + 0.0015, 0, (rb) => {
      for (let k = 0; k < n; k++) rb.box(0.6, 0.003, 0.035, 0, 0, zMin + k * spacing, BELT_STRIPE);
    });
    model.rig = {
      pose: 'run',
      anchor: new THREE.Vector3(0, beltTop, zMin + n * spacing / 2),                              // the centre of the belt top (the feet stand on the anchor)
      forward: { x: 0, z: -1 },
      focus: new THREE.Vector3(0, 0.85, 0.0),
      camDist: 2.7, camUp: 0.4,
      belt, beltSpacing: spacing,
    };
  },

  /**
   * Exercise bike (`2 × 3 · 1.2`): front and rear feet · a low beam · the saddle post · a rear diagonal · the front fork
   * (two plates with the flywheel between them) · a half-round cover · the resistance knob · handlebars · console · chain
   * cover · saddle. The crank (`rig.crank`, with the pedals a child group that stays level) and the flywheel
   * (`rig.flywheel`) turn about X.
   */
  exercise_bike: (b, model, _w, _d, _h, a) => {
    for (const sz of [-0.62, 0.6]) {
      b.box(0.62, 0.05, 0.08, 0, 0.025, sz, M.hullLight);                                        // front · rear foot
      for (const sx of [-1, 1]) b.box(0.08, 0.03, 0.09, sx * 0.3, 0.015, sz, RUBBER);
    }
    b.box(0.08, 0.06, 1.1, 0, 0.08, -0.02, M.hullDark);                                          // low beam
    // player FURN_CYCLE (from the saddle top, front = −Z): crank axis (0, −0.60, front 0.25) · radius 0.16 · pedals x ±0.13 · grips (±0.22, +0.14, front 0.50)
    const seatTop = 0.93, seatZ = 0.3;
    const crankY = seatTop - 0.6, crankZ = seatZ - 0.25;
    const gripY = seatTop + 0.14, gripZ = seatZ - 0.5;
    b.box(0.075, 0.62, 0.07, 0, (crankY + seatTop - 0.07) / 2, (crankZ + seatZ) / 2, M.hullLight, 0, Math.atan2(seatZ - crankZ, seatTop - 0.07 - crankY));   // saddle post
    b.box(0.07, 0.62, 0.07, 0, (0.05 + crankY) / 2, (0.6 + crankZ) / 2, M.hullLight, 0, Math.atan2(crankZ - 0.6, crankY - 0.05));   // rear diagonal
    // front fork: from the front foot (z −0.6) to the top of the handlebar post (y 1.02, z −0.38), two plates with the flywheel between them
    const forkLen = Math.hypot(1.02 - 0.05, -0.38 + 0.6), forkT = Math.atan2(-0.38 + 0.6, 1.02 - 0.05);
    for (const sx of [-1, 1]) b.box(0.03, forkLen, 0.07, sx * 0.065, (0.05 + 1.02) / 2, (-0.6 - 0.38) / 2, M.hullDark, 0, forkT);
    b.cyl(0.07, 0.07, 0.12, 16, 0, crankY, crankZ, M.hullDark, 0, 0, ALONG_X);                   // crank housing
    const fwY = 0.36, fwZ = -0.6 + (0.36 - 0.05) * Math.tan(forkT);
    b.box(0.02, 0.12, crankZ - fwZ, 0.05, (crankY + fwY) / 2, (crankZ + fwZ) / 2, M.hullLight);  // chain cover (inside the crank arm)
    b.box(0.004, 0.02, crankZ - fwZ - 0.06, 0.0615, (crankY + fwY) / 2, (crankZ + fwZ) / 2, a);
    b.add(new THREE.CylinderGeometry(0.235, 0.235, 0.09, 20, 1, true, 0, Math.PI), M.hullLight, 0, fwY, fwZ, 0, 0, Math.PI / 2);   // flywheel cover (upper half-round)
    b.cyl(0.03, 0.03, 0.06, 10, 0, 0.63, fwZ + 0.06, M.stripRed);                                // resistance knob
    // handlebars (two horns reaching from the post's top toward the rider — the rubber grips are where player's hands go) · console
    b.box(0.5, 0.036, 0.036, 0, 1.02, -0.38, M.gunmetal);
    for (const sx of [-1, 1]) {
      b.box(0.036, 0.036, 0.26, sx * 0.22, gripY - 0.02, -0.38 + 0.13, M.gunmetal, 0, Math.atan2(-(gripY - 1.02), 0.26));
      b.box(0.046, 0.046, 0.12, sx * 0.22, gripY, gripZ, RUBBER);
    }
    b.box(0.18, 0.11, 0.03, 0, 1.12, -0.42, M.hullDark, 0, 0.5);
    b.box(0.14, 0.07, 0.004, 0, 1.12 + 0.016 * Math.sin(0.5), -0.42 - 0.016 * Math.cos(0.5), M.screen, 0, 0.5);
    // saddle
    b.box(0.05, 0.05, 0.1, 0, seatTop - 0.07, seatZ, M.gunmetal);
    b.box(0.16, 0.06, 0.26, 0, seatTop - 0.03, seatZ, BENCH_PAD);
    b.box(0.08, 0.05, 0.14, 0, seatTop - 0.035, seatZ - 0.18, BENCH_PAD);
    b.box(0.164, 0.012, 0.24, 0, seatTop - 0.045, seatZ, a);
    // moving parts
    const flywheel = rigGroup(model, model.group, 'flywheel', 0, fwY, fwZ, (rb) => {
      rb.cyl(0.2, 0.2, 0.05, 28, 0, 0, 0, CHROME, 0, 0, ALONG_X);
      rb.cyl(0.14, 0.14, 0.054, 24, 0, 0, 0, M.gunmetal, 0, 0, ALONG_X);
      rb.box(0.058, 0.26, 0.02, 0, 0, 0, a);                                                     // a mark that makes the turning visible
      rb.cyl(0.03, 0.03, 0.07, 10, 0, 0, 0, M.trim, 0, 0, ALONG_X);
    });
    const crankR = 0.16, pedalX = 0.13;
    const pedals: THREE.Group[] = [];
    const crank = rigGroup(model, model.group, 'crank', 0, crankY, crankZ, (rb) => {
      rb.cyl(0.015, 0.015, 0.2, 8, 0, 0, 0, CHROME, 0, 0, ALONG_X);                              // shaft
      rb.box(0.022, crankR + 0.03, 0.035, -0.085, crankR / 2, 0, M.gunmetal);                    // left crank (up)
      rb.box(0.022, crankR + 0.03, 0.035, 0.085, -crankR / 2, 0, M.gunmetal);                    // right crank (down)
      rb.cyl(0.06, 0.06, 0.01, 16, 0.07, 0, 0, M.trim, 0, 0, ALONG_X);                           // chainring
    });
    for (const sx of [-1, 1]) {
      pedals.push(rigGroup(model, crank, sx < 0 ? 'pedal-l' : 'pedal-r', sx * pedalX, -sx * crankR, 0, (rb) => {
        rb.box(0.1, 0.025, 0.12, 0, 0, 0, RUBBER);
        rb.box(0.1, 0.03, 0.02, 0, 0.018, -0.05, a);                                             // toe strap
      }));
    }
    model.rig = {
      pose: 'cycle',
      anchor: new THREE.Vector3(0, seatTop, seatZ),
      forward: { x: 0, z: -1 },
      focus: new THREE.Vector3(0, 0.7, -0.1),
      camDist: 2.4, camUp: 0.4,
      crank, pedals, flywheel,
    };
  },
};
