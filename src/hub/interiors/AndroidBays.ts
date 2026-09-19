import * as THREE from 'three';
import type { HubAndroidBay } from '@/shared';
import { ANDROID_BAY_COUNT, androidNameOf } from '@/shared';
import type { GeoBatch } from './GeoBatch';
import { HUB_MATS as M, yawFromForward } from './GeoBatch';
import type { BoxInteriorCollider } from './InteriorCollider';
import { TextPlane } from '../Labels';

/**
 * src/hub/interiors/AndroidBays.ts — **the cockpit's three android bays** (2026-09-15, user's decision
 * 「매칭 후, 공용 함선 조종실 내부 한켠에 안드로이드 슬롯이 3칸」 — docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원」).
 *
 * Three capsules stand in the **port corner of the shared ship's bridge**, between the helm console (x ≈ −12.4) and
 * the aft armoury (z ≈ 6.3), one row along Z facing **+X (toward the deck)**. Why the spot is here:
 *  - bridge side, yet clear of every collider — terminal (−9.8, 0) · pilot seats (±2.2) · ship computer
 *    (−11, −6.65) · launch pods (−Z) · hangar door (+Z centre) — and clear of the airlock (+X) → deck → pod route.
 *  - **the port line x ≈ −8 is left empty** — it is the line `smoke-hangar` walks to check 「the rear wall blocks a body
 *    beside the doorway」, so the empty corner in front of the armoury is used instead of moving its gun rack out of the way.
 *
 * **No light is ever created** (CLAUDE.md §4.5): the status is one self-lit (`emissive`) material strip, and only
 * that strip and the name tag own a mesh — the rest of the shell merges into the ship's `GeoBatch` and adds no draw call.
 * The geometry is identical on every client — the ship's position snapshots and allies/'s dormant body positions rely on it.
 */

/** Outer size of one capsule bay (m): X = depth, Y = height, Z = width. */
const CAP_D = 0.9;
const CAP_H = 2.25;
const CAP_W = 0.95;
/** x of the capsule floor plate (where the body stands), the pitch between bays and the first bay's z. */
const BAY_X = -11.45;
const BAY_Z0 = 3.2;
const BAY_PITCH = 1.05;
/** One step outside the capsule (m) — where the step-out staging ends · how far the interaction spot sits. */
const EXIT_STEP = 1.1;

/** Status strip colours: dormant (the android is inside) · out (it is a squadmate) · waiting on a request. */
export type AndroidBayState = 'dormant' | 'out' | 'pending';
const STATE_COLOR: Readonly<Record<AndroidBayState, number>> = {
  dormant: 0x3ac8ff,
  out: 0x3a4550,
  pending: 0xffa640,
};
const STATE_KO: Readonly<Record<AndroidBayState, string>> = {
  dormant: '대기',
  out: '분대원',
  pending: '처리 중',
};

/**
 * The three-bay capsule rack. The shell merges into the given `GeoBatch`, and **only the status strip and the name tag**
 * stay own meshes (each bay needs its own colour, so they cannot merge). `bays` is a reused array — the coordinates never move once built.
 */
export class AndroidBayRack {
  readonly bays: HubAndroidBay[] = [];
  private readonly strips: THREE.Mesh[] = [];
  private readonly stripMats: THREE.MeshStandardMaterial[] = [];
  private readonly tags: TextPlane[] = [];
  private readonly states: AndroidBayState[] = [];
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  constructor(b: GeoBatch, col: BoxInteriorCollider, parent: THREE.Object3D) {
    // one heading for all three, facing the deck (+X) — body forward = (−sin yaw, 0, −cos yaw) convention (`yawFromForward`)
    const yaw = yawFromForward(1, 0);
    // the floor plate under the whole rack (it makes the three bays read as one thing)
    const zSpan = (ANDROID_BAY_COUNT - 1) * BAY_PITCH + CAP_W + 0.2;
    const zMid = BAY_Z0 + ((ANDROID_BAY_COUNT - 1) * BAY_PITCH) / 2;
    b.box(CAP_D + 0.2, 0.06, zSpan, BAY_X, 0.03, zMid, M.hullDark);
    b.box(0.06, 0.03, zSpan, BAY_X + CAP_D / 2 + 0.06, 0.07, zMid, M.stripAmber);

    for (let i = 0; i < ANDROID_BAY_COUNT; i++) {
      const cz = BAY_Z0 + i * BAY_PITCH;
      // back panel · side panels · top · plinth — only the front (+X) is open, and glass closes it
      b.boxB(0.18, CAP_H, CAP_W, BAY_X - CAP_D / 2 + 0.09, 0, cz, M.hullLight);
      for (const s of [-1, 1]) b.boxB(CAP_D, CAP_H, 0.1, BAY_X, 0, cz + s * (CAP_W / 2 - 0.05), M.hullDark);
      b.box(CAP_D + 0.12, 0.14, CAP_W + 0.12, BAY_X, CAP_H + 0.07, cz, M.trimDark);
      b.boxB(CAP_D + 0.1, 0.12, CAP_W + 0.1, BAY_X, 0, cz, M.hullDark);
      // front glass (the inside is visible from the deck)
      b.box(0.05, CAP_H - 0.35, CAP_W - 0.22, BAY_X + CAP_D / 2 - 0.03, 0.18 + (CAP_H - 0.35) / 2, cz, M.glassDark);

      /*
       * The collider is one solid capsule silhouette (CLAUDE.md §4.4 「colliders match the visible silhouette」). What stands
       * inside is only the body allies/ draws, not a physics object, so leaving the front open would let the player walk
       * into the capsule and overlap it — the whole box is blocked instead.
       */
      col.addBox(BAY_X, 0, cz, CAP_D + 0.1, CAP_H, CAP_W + 0.1);

      // status strip (self-lit only — no light is created)
      const mat = new THREE.MeshStandardMaterial({ color: 0x1a2028, emissive: STATE_COLOR.dormant, emissiveIntensity: 1.6, roughness: 0.5 });
      this.stripMats.push(mat);
      this.disposables.push(mat);
      const geo = new THREE.BoxGeometry(0.08, 0.06, CAP_W - 0.26);
      this.disposables.push(geo);
      const strip = new THREE.Mesh(geo, mat);
      strip.position.set(BAY_X + CAP_D / 2 + 0.02, CAP_H - 0.12, cz);
      parent.add(strip);
      this.strips.push(strip);

      // name tag — read from the deck (+X) (PlaneGeometry faces +Z, so y is turned by +π/2)
      const tag = new TextPlane(1.0, 0.3, 256);
      tag.mesh.position.set(BAY_X + CAP_D / 2 + 0.03, CAP_H + 0.34, cz);
      tag.mesh.rotation.y = Math.PI / 2;
      parent.add(tag.mesh);
      this.tags.push(tag);

      this.states.push('dormant');
      this.bays.push({
        bay: i,
        position: new THREE.Vector3(BAY_X, 0, cz),
        yaw,
        exit: new THREE.Vector3(BAY_X + EXIT_STEP, 0, cz),
      });
      this.paint(i);
    }
  }

  /** Change a bay's state (a no-op when it already holds that value). */
  setState(bay: number, state: AndroidBayState): void {
    if (bay < 0 || bay >= this.states.length || this.states[bay] === state) return;
    this.states[bay] = state;
    this.paint(bay);
  }

  stateOf(bay: number): AndroidBayState { return this.states[bay] ?? 'dormant'; }

  private paint(bay: number): void {
    const state = this.states[bay];
    const color = STATE_COLOR[state];
    const mat = this.stripMats[bay];
    mat.emissive.setHex(color);
    mat.emissiveIntensity = state === 'out' ? 0.4 : 1.8;
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    this.tags[bay].set([androidNameOf(bay), STATE_KO[state]], hex, 'rgba(6,8,10,0.85)');
  }

  /** Only a bay waiting on a request pulses (one material's `emissiveIntensity` — no light, no allocation). */
  update(_dt: number, time: number): void {
    for (let i = 0; i < this.states.length; i++) {
      if (this.states[i] !== 'pending') continue;
      this.stripMats[i].emissiveIntensity = 1.0 + 1.2 * (0.5 + 0.5 * Math.sin(time * 5.0));
    }
  }

  dispose(): void {
    for (const s of this.strips) s.removeFromParent();
    this.strips.length = 0;
    for (const t of this.tags) t.dispose();
    this.tags.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.bays.length = 0;
  }
}
