import { BEHEMOTH_SCALE } from '@/shared';
import type { BugType } from '../EnemyTypes';

/** Visual construction parameters for the procedural bug rig (all lengths in meters, root at feet). */
export interface BugParams {
  type: BugType;
  /** thorax ellipsoid radii [x width, y height, z length] and center height */
  thorax: [number, number, number];
  thoraxY: number;
  /** abdomen ellipsoid radii, z offset (negative = behind) and center height */
  abdomen: [number, number, number];
  abdomenZ: number;
  abdomenY: number;
  /** spewer: abdomen is its own animated mesh with acid material */
  separateAbdomen: boolean;
  /** number of accent rings around the abdomen */
  rings: number;
  /** carapace plates on top of the thorax */
  plates: number;
  head: { r: number; z: number; y: number };
  mandibleLen: number;
  mandibleR: number;
  eyeR: number;
  antennaLen: number;
  legs: {
    l1: number; l2: number; r: number;
    hipY: number; spreadX: number;
    zs: [number, number, number];
    /** femur elevation above horizontal (rad) */
    femurUp: number;
  };
  /** distance per full gait cycle */
  strideLength: number;
  bobAmp: number;
  base: number;
  accent: number;
  armor: number | null;
  eye: number;
  horns: boolean;
  spikes: boolean;
  /* ── Phase 4 ── */
  /** artillery: dorsal mortar tube (own mesh, recoils on fire). r/len = tube, y/z = pivot on the back, elev = elevation (rad). */
  mortar?: { r: number; len: number; y: number; z: number; elev: number };
  /** behemoth: thick dark plate in front of the head (separate armoured hitbox). */
  frontPlate?: { color: number };
  /** separateAbdomen sac swell factor at `anim.abdomen = 1` (spewer 0.18, toxic much more). */
  sacSwell?: number;
}

/** Scale every length of a param set (colours / counts / flags untouched). */
function scaled(src: BugParams, k: number, over: Partial<BugParams>): BugParams {
  const L = src.legs;
  return {
    ...src,
    thorax: [src.thorax[0] * k, src.thorax[1] * k, src.thorax[2] * k], thoraxY: src.thoraxY * k,
    abdomen: [src.abdomen[0] * k, src.abdomen[1] * k, src.abdomen[2] * k], abdomenZ: src.abdomenZ * k, abdomenY: src.abdomenY * k,
    head: { r: src.head.r * k, z: src.head.z * k, y: src.head.y * k },
    mandibleLen: src.mandibleLen * k, mandibleR: src.mandibleR * k, eyeR: src.eyeR * k, antennaLen: src.antennaLen * k,
    legs: { l1: L.l1 * k, l2: L.l2 * k, r: L.r * k, hipY: L.hipY * k, spreadX: L.spreadX * k, zs: [L.zs[0] * k, L.zs[1] * k, L.zs[2] * k], femurUp: L.femurUp },
    strideLength: src.strideLength * k, bobAmp: src.bobAmp * k,
    ...over,
  };
}

const WARRIOR: BugParams = {
  type: 'warrior',
  thorax: [0.56, 0.42, 0.76], thoraxY: 0.82,
  abdomen: [0.56, 0.46, 0.62], abdomenZ: -1.02, abdomenY: 0.86, separateAbdomen: false, rings: 3, plates: 3,
  head: { r: 0.34, z: 0.86, y: 0.76 }, mandibleLen: 0.48, mandibleR: 0.07, eyeR: 0.07, antennaLen: 0.55,
  legs: { l1: 0.72, l2: 0.92, r: 0.062, hipY: 0.76, spreadX: 0.46, zs: [0.5, 0.02, -0.46], femurUp: 0.56 },
  strideLength: 1.7, bobAmp: 0.035,
  base: 0x2a2422, accent: 0xd07a22, armor: 0x7a6d62, eye: 0xff4a1a, horns: false, spikes: false,
};

export const BUG_PARAMS: Record<BugType, BugParams> = {
  scavenger: {
    type: 'scavenger',
    thorax: [0.3, 0.22, 0.4], thoraxY: 0.42,
    abdomen: [0.27, 0.23, 0.34], abdomenZ: -0.5, abdomenY: 0.44, separateAbdomen: false, rings: 2, plates: 1,
    head: { r: 0.17, z: 0.48, y: 0.42 }, mandibleLen: 0.2, mandibleR: 0.035, eyeR: 0.042, antennaLen: 0.32,
    legs: { l1: 0.4, l2: 0.5, r: 0.03, hipY: 0.4, spreadX: 0.24, zs: [0.28, 0.02, -0.26], femurUp: 0.62 },
    strideLength: 1.1, bobAmp: 0.02,
    base: 0x2b2623, accent: 0xd9822b, armor: null, eye: 0xff6a1a, horns: false, spikes: false,
  },
  hunter: {
    type: 'hunter',
    thorax: [0.38, 0.3, 0.62], thoraxY: 0.64,
    abdomen: [0.36, 0.32, 0.5], abdomenZ: -0.86, abdomenY: 0.68, separateAbdomen: false, rings: 3, plates: 2,
    head: { r: 0.24, z: 0.74, y: 0.62 }, mandibleLen: 0.32, mandibleR: 0.045, eyeR: 0.055, antennaLen: 0.5,
    legs: { l1: 0.64, l2: 0.86, r: 0.04, hipY: 0.62, spreadX: 0.3, zs: [0.42, 0.02, -0.4], femurUp: 0.78 },
    strideLength: 1.9, bobAmp: 0.03,
    base: 0x23201f, accent: 0xe0a030, armor: null, eye: 0xff5a2a, horns: false, spikes: true,
  },
  warrior: WARRIOR,
  spewer: {
    type: 'spewer',
    thorax: [0.5, 0.4, 0.6], thoraxY: 0.82,
    abdomen: [0.86, 0.76, 0.96], abdomenZ: -1.1, abdomenY: 0.96, separateAbdomen: true, rings: 0, plates: 2,
    head: { r: 0.3, z: 0.76, y: 0.72 }, mandibleLen: 0.3, mandibleR: 0.05, eyeR: 0.065, antennaLen: 0.45,
    legs: { l1: 0.66, l2: 0.86, r: 0.056, hipY: 0.76, spreadX: 0.42, zs: [0.46, 0.06, -0.34], femurUp: 0.56 },
    strideLength: 1.5, bobAmp: 0.04,
    base: 0x2d2a24, accent: 0x9fb542, armor: null, eye: 0xb9ff3a, horns: false, spikes: false,
  },
  charger: {
    type: 'charger',
    thorax: [0.96, 0.8, 1.3], thoraxY: 1.32,
    abdomen: [0.86, 0.76, 1.0], abdomenZ: -1.72, abdomenY: 1.36, separateAbdomen: false, rings: 3, plates: 4,
    head: { r: 0.56, z: 1.36, y: 1.16 }, mandibleLen: 0.5, mandibleR: 0.1, eyeR: 0.09, antennaLen: 0.4,
    legs: { l1: 1.02, l2: 1.32, r: 0.1, hipY: 1.16, spreadX: 0.82, zs: [0.82, 0.02, -0.8], femurUp: 0.46 },
    strideLength: 2.6, bobAmp: 0.05,
    base: 0x241f1d, accent: 0xc86a1e, armor: 0x8a8078, eye: 0xff3a1a, horns: true, spikes: false,
  },
  /* ── Phase 4 ── */
  artillery: {
    type: 'artillery',
    thorax: [0.72, 0.42, 0.9], thoraxY: 0.72,
    abdomen: [0.7, 0.5, 0.78], abdomenZ: -1.18, abdomenY: 0.74, separateAbdomen: false, rings: 4, plates: 2,
    head: { r: 0.3, z: 0.98, y: 0.6 }, mandibleLen: 0.26, mandibleR: 0.05, eyeR: 0.06, antennaLen: 0.4,
    legs: { l1: 0.6, l2: 0.72, r: 0.06, hipY: 0.62, spreadX: 0.6, zs: [0.62, 0.04, -0.54], femurUp: 0.42 },
    strideLength: 1.4, bobAmp: 0.03,
    base: 0x2a2620, accent: 0x9a8440, armor: 0x5a5148, eye: 0xffb12a, horns: false, spikes: false,
    mortar: { r: 0.16, len: 1.25, y: 1.0, z: -0.25, elev: 1.05 },
  },
  toxic: {
    type: 'toxic',
    thorax: [0.28, 0.2, 0.36], thoraxY: 0.42,
    abdomen: [0.4, 0.38, 0.42], abdomenZ: -0.5, abdomenY: 0.56, separateAbdomen: true, rings: 0, plates: 1,
    head: { r: 0.16, z: 0.44, y: 0.42 }, mandibleLen: 0.18, mandibleR: 0.03, eyeR: 0.045, antennaLen: 0.3,
    legs: { l1: 0.42, l2: 0.54, r: 0.03, hipY: 0.42, spreadX: 0.24, zs: [0.26, 0.02, -0.22], femurUp: 0.66 },
    strideLength: 1.15, bobAmp: 0.025,
    base: 0x2c2f22, accent: 0x9fb542, armor: null, eye: 0xb9ff3a, horns: false, spikes: false,
    sacSwell: 0.75,
  },
  behemoth: scaled(WARRIOR, BEHEMOTH_SCALE, {
    type: 'behemoth', plates: 4, rings: 4, horns: true,
    base: 0x1f1b19, accent: 0x9a4a16, armor: 0x3a3330, eye: 0xff2a10,
    frontPlate: { color: 0x2b2624 },
  }),
};
