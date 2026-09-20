import * as THREE from 'three';
import {
  SHIP_BAY_FLOOR_LIFT, SHIP_BAY_HALF_W, SHIP_BAY_HEIGHT, SHIP_BAY_Z_MAX, SHIP_BAY_Z_MIN, SHIP_GROUND_DRAW_LIFT_MAX,
  buildShipModel, type ShipModelBuild, type ShipModelId,
} from '@/shared';
import { buildShipGreebles } from './ShipGreebles';

export type ShipState = 'hidden' | 'approach' | 'descend' | 'landed' | 'liftoff';

/*
 * 2026-09-21 (user's decision — one exterior model): the **mesh** of this ship lives in `shared/shipModel.ts`, so the
 * hangar's parked ships and the docking cutscene draw the very ship that lands here (CLAUDE.md §4.1). What stayed in
 * this file is everything that is not geometry: the flight path, the ramp / gear animation, the bay's walk box and
 * the three point lights. The bay dimensions below are **re-exports** of the shared ones — `Hull.ts`,
 * `ExtractionSystem` and `scripts/smoke-extraction.mjs` import them from here and never needed to know they moved.
 */
/** Bay floor rectangle in ship-local space (player walks in from local +Z through the ramp). */
export const BAY_HALF_W = SHIP_BAY_HALF_W;
export const BAY_Z_MIN = SHIP_BAY_Z_MIN;
export const BAY_Z_MAX = SHIP_BAY_Z_MAX;
export const BAY_HEIGHT = SHIP_BAY_HEIGHT;
/** Liftoff: seconds the ship stays put on the pad (ramp closing, engines spooling) before it starts to climb. */
export const LIFTOFF_SPOOL_S = 1.6;
/** Highest any world draws its walkable ground above the height `getSurfaceY` / the pad report (tutorial `TOP_LIFT`). */
export const GROUND_DRAW_LIFT_MAX = SHIP_GROUND_DRAW_LIFT_MAX;
/** How far the **drawn** bay floor sits above the deck plane — the clearance note lives with it in `shared/shipModel.ts`. */
export const BAY_FLOOR_LIFT = SHIP_BAY_FLOOR_LIFT;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Interior lamp intensity while the bay is lit (0 = ship hidden; see the light note on `body`). */
const INTERIOR_LIGHT = 8;

/**
 * Procedural "Pelican"-style dropship (~14 m). Local -Z is the nose; the rear ramp opens toward +Z.
 * The bay **deck plane** is local y = 0 (`floorYAt`) so that, once landed, the player walks straight in from the
 * ground; the drawn floor plate is `BAY_FLOOR_LIFT` above it (see the coplanar note near the constants).
 */
export class Dropship {
  readonly root = new THREE.Group();
  /**
   * Every mesh of the ship. **The visibility toggle lives here, not on `root`** (2026-09-10): three.js skips
   * invisible subtrees in `projectObject`, so lights parked under a hidden root are not counted — and the frame
   * the ship appears `numPointLights` jumps by 3 and **every material in the scene recompiles its shader**.
   * That was the freeze when the dropship arrived. `root` therefore stays visible forever and carries the three
   * point lights (intensity 0 while hidden) — the rule `core/fx/FlashPool` already states.
   */
  readonly body = new THREE.Group();
  readonly interiorSwitchWorld = new THREE.Vector3();
  state: ShipState = 'hidden';

  /** The shared mesh (`shared/shipModel.ts`) — every part this class animates hangs off it. */
  private readonly build: ShipModelBuild;
  private ramp: THREE.Group;
  private rampAngle = Math.PI / 2;     // 0 = open flat, PI/2 = closed
  private rampTarget = Math.PI / 2;
  private thrustMats: THREE.MeshBasicMaterial[];
  private thrustCones: THREE.Mesh[];
  private engineLights: THREE.PointLight[] = [];
  private landingLightMat: THREE.MeshStandardMaterial;
  private interiorLight: THREE.PointLight;
  private interiorLampMat: THREE.MeshStandardMaterial;
  private switchMat: THREE.MeshStandardMaterial;
  private gear: THREE.Group;

  // Flight
  private start = new THREE.Vector3();
  private hover = new THREE.Vector3();
  private landPos = new THREE.Vector3();
  private landYaw = 0;
  private t = 0;
  private duration = 1;
  private time = 0;
  thrust = 0;               // 0..1 visual engine intensity
  private bank = 0;
  private liftoffOrigin = new THREE.Vector3();
  private liftoffDir = new THREE.Vector3();

  constructor(model?: ShipModelId) {
    /*
     * 2026-09-21: the mesh comes from `shared/shipModel.buildShipModel` at `'full'` detail — the bay interior, its own
     * material instances and every animated part as its own mesh, exactly what stood in this constructor before. The
     * greeble pass stays in this folder and is handed in, so `shared` never imports a feature folder.
     */
    const r = this.body;   // meshes only — the lights go straight on `root` (see the `body` note)
    this.build = buildShipModel(r, { model, detail: 'full', greebles: buildShipGreebles });
    this.ramp = this.build.ramp;
    this.gear = this.build.gear;
    this.thrustCones = this.build.thrustCones;
    this.thrustMats = this.build.thrustMats;
    this.landingLightMat = this.build.landingLightMat;
    this.interiorLampMat = this.build.interiorLampMat!;
    this.switchMat = this.build.switchMat!;
    this.ramp.rotation.x = -this.rampAngle;  // closed = rotated up

    // ── the three point lights ── they live on `root` (never on `body`), so the scene's point-light count is fixed
    // from the first frame and nothing recompiles when the ship appears (see the `body` note).
    this.interiorLight = new THREE.PointLight(0xfff2dc, 8, 9, 1.6);
    this.interiorLight.position.copy(this.build.interiorLightPoint!);
    this.interiorLight.intensity = 0;          // lit by `showBody()`; the light itself never leaves the scene
    this.root.add(this.interiorLight);
    for (const p of this.build.enginePoints) {
      const el = new THREE.PointLight(0x66c4ff, 0, 18, 1.5);
      el.position.copy(p);
      this.engineLights.push(el);
      this.root.add(el);   // stays in the scene with the other lights (see the `body` note)
    }

    r.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    for (const c of this.thrustCones) c.castShadow = false;
    // The bay lining is invisible from outside; keeping it out of the shadow pass halves the ship's caster count.
    for (const m of this.build.interiorParts) m.castShadow = false;
    r.visible = false;
    this.root.add(r);
  }

  /**
   * 2026-09-21 (the ship-purchase hook): draw this ship as `model`. Called **before the hull is ever revealed** —
   * `ExtractionSystem` sets it from the profile of whoever called the extraction. Today a model is a tint, which
   * costs nothing and recompiles nothing; a model that changed the silhouette would rebuild the mesh here, and that
   * is why the call site is the activation and not the landing.
   */
  setShipModel(model: unknown): void { this.build.setModel(model); }

  /** Reveal the hull and light the bay. The lights never leave the scene — only their intensity moves. */
  private showBody(): void {
    this.body.visible = true;
    this.interiorLampMat.emissive.set(0xfff2dc); this.interiorLampMat.emissiveIntensity = 2.2;
    this.interiorLight.color.set(0xfff2dc); this.interiorLight.intensity = INTERIOR_LIGHT;
  }

  /** Begin the flight-in. `landPos` is where the ship root will sit; `yaw` orients the ramp toward +dir(yaw). */
  startApproach(landPos: THREE.Vector3, yaw: number, approachDuration: number): void {
    this.landPos.copy(landPos);
    this.landYaw = yaw;
    // dir(yaw) = local +Z (rear) direction in world.
    const dir = _v1.set(Math.sin(yaw), 0, Math.cos(yaw));
    // Fly in from the rear side (over the console/player) toward −dir, so the ramp faces the console.
    this.start.copy(landPos).addScaledVector(dir, 300).add(_v2.set(0, 130, 0));
    this.hover.copy(landPos).add(_v2.set(0, 24, 0));
    this.root.position.copy(this.start);
    this.root.rotation.set(0, yaw, 0);
    this.showBody();
    this.state = 'approach';
    this.t = 0;
    this.duration = Math.max(2, approachDuration);
    this.rampTarget = Math.PI / 2;
    this.gear.scale.y = 0.05;
    this.gear.visible = true;
    this.thrust = 1;
  }

  /** Returns true on the frame the ship touches down. */
  update(dt: number): { touchdown: boolean; rampOpened: boolean; rampClosed: boolean } {
    const ev = { touchdown: false, rampOpened: false, rampClosed: false };
    if (this.state === 'hidden') return ev;
    this.time += dt;

    switch (this.state) {
      case 'approach': {
        this.t = Math.min(1, this.t + dt / this.duration);
        const e = 1 - Math.pow(1 - this.t, 3); // ease-out: decelerate into hover
        // Curved path: lerp start→hover with an upward bow and lateral swing.
        _v1.lerpVectors(this.start, this.hover, e);
        _v1.y += Math.sin(e * Math.PI) * 30;
        const sway = Math.sin(e * Math.PI) * 18;
        _v2.set(Math.cos(this.landYaw), 0, -Math.sin(this.landYaw)); // right vector
        _v1.addScaledVector(_v2, sway);
        this.root.position.copy(_v1);
        // Nose-down pitch while diving, level out; bank into the swing.
        const pitch = (1 - e) * 0.45;
        this.bank += ((Math.cos(e * Math.PI) * 0.35) - this.bank) * Math.min(1, dt * 3);
        this.root.rotation.set(pitch, this.landYaw, this.bank);
        this.thrust = 1;
        if (this.t >= 1) { this.state = 'descend'; this.t = 0; this.duration = 4.2; }
        break;
      }
      case 'descend': {
        this.t = Math.min(1, this.t + dt / this.duration);
        const e = this.t < 0.5 ? 2 * this.t * this.t : 1 - Math.pow(-2 * this.t + 2, 2) / 2; // ease-in-out
        this.root.position.lerpVectors(this.hover, this.landPos, e);
        this.root.position.y += (1 - e) * Math.sin(this.time * 2.1) * 0.35; // hover wobble
        this.bank += (0 - this.bank) * Math.min(1, dt * 4);
        this.root.rotation.set(0.04 * (1 - e), this.landYaw, this.bank + Math.sin(this.time * 1.7) * 0.02 * (1 - e));
        this.gear.scale.y = Math.min(1, 0.05 + e * 1.4);
        this.thrust = 1 - e * 0.35;
        if (this.t >= 1) {
          this.state = 'landed';
          this.root.position.copy(this.landPos);
          this.root.rotation.set(0, this.landYaw, 0);
          this.rampTarget = 0;
          this.landingLightMat.emissiveIntensity = 3;
          this.gear.scale.y = 1;
          ev.touchdown = true;
        }
        break;
      }
      case 'landed': {
        this.thrust += (0.18 - this.thrust) * Math.min(1, dt * 2);
        // 2026-09-15: no vertical bob on the pad — it dipped the drawn deck under the ground (clearance note at the top);
        // the hull colliders (`Hull.ts`) are static at `landPos.y` for the same reason.
        this.root.position.y = this.landPos.y;
        break;
      }
      case 'liftoff': {
        this.t += dt;
        const tt = this.t;
        if (tt < LIFTOFF_SPOOL_S) {
          // Ramp closing; engines spooling up.
          this.thrust += (0.6 - this.thrust) * Math.min(1, dt * 2);
          this.root.position.copy(this.liftoffOrigin);
          // one-sided shake (≥ 0): the drawn deck must not dip under the ground it sits on (clearance note at the top)
          this.root.position.y += Math.abs(Math.sin(this.time * 30)) * 0.01 * tt;
        } else {
          const a = tt - LIFTOFF_SPOOL_S;
          this.thrust = 1;
          const rise = 6 * a * a + 2 * a;            // accelerating climb
          const fwd = Math.max(0, a - 0.8);
          const fwdDist = 12 * fwd * fwd;
          this.root.position.copy(this.liftoffOrigin);
          this.root.position.y += rise;
          this.root.position.addScaledVector(this.liftoffDir, fwdDist);
          const pitch = -Math.min(0.35, fwd * 0.25);
          this.root.rotation.set(pitch, this.landYaw, Math.sin(a * 1.3) * 0.05);
          this.gear.scale.y = Math.max(0.05, 1 - a * 0.8);
          this.landingLightMat.emissiveIntensity = Math.max(0, 3 - a * 2);
        }
        break;
      }
    }

    // Ramp animation
    const prev = this.rampAngle;
    const speed = (Math.PI / 2) / 1.5;
    if (this.rampAngle < this.rampTarget) this.rampAngle = Math.min(this.rampTarget, this.rampAngle + speed * dt);
    else if (this.rampAngle > this.rampTarget) this.rampAngle = Math.max(this.rampTarget, this.rampAngle - speed * dt);
    if (prev !== this.rampAngle) {
      this.ramp.rotation.x = -this.rampAngle;
      if (this.rampAngle === 0) ev.rampOpened = true;
      if (this.rampAngle === Math.PI / 2) ev.rampClosed = true;
    }

    // Engine visuals: flicker + scale with thrust
    const flick = 0.85 + 0.15 * Math.sin(this.time * 41) * Math.sin(this.time * 17.3);
    const th = this.thrust * flick;
    for (let i = 0; i < this.thrustMats.length; i++) {
      this.thrustMats[i].opacity = 0.15 + th * 0.7;
      this.thrustCones[i].scale.set(0.6 + th * 0.5, 0.5 + th * 1.1, 0.6 + th * 0.5);
      this.engineLights[i].intensity = th * 40;
    }
    // Interior lamp: steady when landed, flicker during liftoff
    if (this.state === 'liftoff') {
      const f = Math.sin(this.time * 25) > 0.4 ? 1 : 0.45;
      this.interiorLampMat.emissiveIntensity = 1.2 * f;
      this.interiorLampMat.emissive.set(0xff8866);
      this.interiorLight.intensity = 5 * f;
      this.interiorLight.color.set(0xff8866);
    }
    // Switch pulse
    this.switchMat.emissiveIntensity = this.state === 'landed' ? 1.0 + 0.8 * Math.max(0, Math.sin(this.time * 4)) : 0.6;

    this.root.updateMatrixWorld(true);
    this.interiorSwitchWorld.set(0, 1.0, -4.6).applyMatrix4(this.root.matrixWorld);
    return ev;
  }

  /**
   * Snap straight to the landed state (multiplayer client fallback when the host reports touchdown but the
   * local flight-in never happened / has not finished). Returns false if the ship is already landed or lifting.
   * The ramp still opens over its normal 1.5 s.
   */
  forceLand(landPos: THREE.Vector3, yaw: number): boolean {
    if (this.state === 'landed' || this.state === 'liftoff') return false;
    this.landPos.copy(landPos);
    this.landYaw = yaw;
    this.hover.copy(landPos).add(_v2.set(0, 24, 0));
    this.root.position.copy(landPos);
    this.root.rotation.set(0, yaw, 0);
    this.showBody();
    this.state = 'landed';
    this.t = 0;
    this.bank = 0;
    this.rampTarget = 0;
    this.landingLightMat.emissiveIntensity = 3;
    this.gear.scale.y = 1;
    this.gear.visible = true;
    this.thrust = 0.65;
    this.root.updateMatrixWorld(true);
    this.interiorSwitchWorld.set(0, 1.0, -4.6).applyMatrix4(this.root.matrixWorld);
    return true;
  }

  beginLiftoff(): void {
    if (this.state !== 'landed') return;
    this.state = 'liftoff';
    this.t = 0;
    this.rampTarget = Math.PI / 2;
    this.liftoffOrigin.copy(this.root.position);
    // Depart toward the nose (−dir).
    this.liftoffDir.set(-Math.sin(this.landYaw), 0, -Math.cos(this.landYaw));
  }

  /** Is a world position inside the bay footprint (XZ) and below the ceiling? */
  containsWorldPoint(p: THREE.Vector3): boolean {
    if (this.state !== 'landed' && this.state !== 'liftoff') return false;
    _v1.copy(p);
    this.root.worldToLocal(_v1);
    return Math.abs(_v1.x) <= BAY_HALF_W + 0.1 && _v1.z >= BAY_Z_MIN && _v1.z <= BAY_Z_MAX && _v1.y > -1 && _v1.y < BAY_HEIGHT;
  }

  /**
   * World y of the bay deck (local y = 0) directly under `(x, z)`. The deck **tilts** — the liftoff climb pitches
   * the nose up by 0.35 rad — so a single flat height for the whole box would sink a rider ~0.9 m through the
   * floor at the far end of the bay. Solving the deck plane instead is exact for any attitude.
   * `root` is a direct child of the scene, so its local transform is its world transform.
   */
  floorYAt(x: number, z: number): number {
    const o = this.root.position;                 // the root origin sits on the deck
    const up = _v2.set(0, 1, 0).applyQuaternion(this.root.quaternion);
    if (Math.abs(up.y) < 1e-3) return o.y;
    return o.y - (up.x * (x - o.x) + up.z * (z - o.z)) / up.y;
  }

  /**
   * Rewrite `out` with the world-space AABB of the rotated bay (lenient bounds for player clamping); `at` is the
   * world position the deck height is solved for (the rider — see `floorYAt`), defaulting to the bay centre.
   * **The caller keeps one object and refreshes it every frame** — `PlayerRef.setShipInterior` stores the
   * reference, and the box has to travel with the ship or a boarded player is left walking on a floor that is no
   * longer there (2026-09-10: that was the "the ship rises but the player alone falls" bug during liftoff).
   */
  writeInteriorBounds(out: { center: THREE.Vector3; halfExtents: THREE.Vector3 }, at?: THREE.Vector3): void {
    out.center.set(0, BAY_HEIGHT / 2, (BAY_Z_MIN + BAY_Z_MAX) / 2).applyMatrix4(this.root.matrixWorld);
    out.center.y = this.floorYAt(at ? at.x : out.center.x, at ? at.z : out.center.z) + BAY_HEIGHT / 2;
    const hw = BAY_HALF_W, hd = (BAY_Z_MAX - BAY_Z_MIN) / 2;
    const c = Math.abs(Math.cos(this.landYaw)), s = Math.abs(Math.sin(this.landYaw));
    out.halfExtents.set(hw * c + hd * s, BAY_HEIGHT / 2, hw * s + hd * c);
  }

  /** Fresh world-space AABB of the bay. Prefer `writeInteriorBounds` when the box is held across frames. */
  getInteriorBounds(): { center: THREE.Vector3; halfExtents: THREE.Vector3 } {
    const out = { center: new THREE.Vector3(), halfExtents: new THREE.Vector3() };
    this.writeInteriorBounds(out);
    return out;
  }

  getGroundY(): number { return this.landPos.y; }
  /** three.js `rotation.y` the ship landed with (the attitude it keeps apart from the climb pitch). */
  get yaw(): number { return this.landYaw; }
  /**
   * 2026-09-13: on the pad, or still within a bay height of it during the liftoff — the only time the bay is a place an
   * enemy could walk into (`ExtractionSystem.keepEnemyOut`).
   */
  get nearGround(): boolean {
    if (this.state === 'landed') return true;
    return this.state === 'liftoff' && this.root.position.y - this.landPos.y < BAY_HEIGHT;
  }
  /**
   * 2026-09-13: `p` in the ship's **yaw-only** frame around the root (x right, z toward the rear ramp, y above the deck
   * origin). The climb pitch is ignored on purpose — the callers (enemy exclusion, corpse-on-deck) care about the
   * footprint, and a corpse spawned from a wire during the climb has no trustworthy height anyway.
   */
  bayLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const o = this.root.position;
    const c = Math.cos(this.landYaw), s = Math.sin(this.landYaw);
    const dx = p.x - o.x, dz = p.z - o.z;
    // inverse of three.js rotation.y: local (x, z) → world (x·c + z·s, −x·s + z·c)
    return out.set(dx * c - dz * s, p.y - o.y, dx * s + dz * c);
  }
  /** Inverse of `bayLocal` for the XZ part: ship-local (x, z) → world, y copied from `worldY`. */
  bayToWorld(lx: number, lz: number, worldY: number, out: THREE.Vector3): THREE.Vector3 {
    const o = this.root.position;
    const c = Math.cos(this.landYaw), s = Math.sin(this.landYaw);
    return out.set(o.x + lx * c + lz * s, worldY, o.z - lx * s + lz * c);
  }
  get position(): THREE.Vector3 { return this.root.position; }
  get descending(): boolean { return this.state === 'descend'; }
  get liftingOff(): boolean { return this.state === 'liftoff'; }
  get liftoffTime(): number { return this.state === 'liftoff' ? this.t : 0; }

  reset(): void {
    this.state = 'hidden';
    this.body.visible = false;
    this.rampAngle = this.rampTarget = Math.PI / 2;
    this.ramp.rotation.x = -this.rampAngle;
    this.thrust = 0;
    this.landingLightMat.emissiveIntensity = 0;
    this.interiorLampMat.emissive.set(0xfff2dc); this.interiorLampMat.emissiveIntensity = 2.2;
    // `update` early-returns while hidden, so the lights are darkened here — they stay in the scene either way.
    this.interiorLight.color.set(0xfff2dc); this.interiorLight.intensity = 0;
    for (const el of this.engineLights) el.intensity = 0;
    this.root.rotation.set(0, 0, 0);
    _q.identity();
  }

  dispose(): void {
    this.build.dispose();
    this.root.removeFromParent();
  }
}
