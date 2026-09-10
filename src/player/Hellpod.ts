import * as THREE from 'three';
import { FxManager, ParticleBurst } from '@/core/fx';
import { easeOutCubic, easeOutBack } from '@/core/util/MathUtil';

export type HellpodState = 'idle' | 'falling' | 'impact' | 'opening' | 'exiting' | 'done';

export interface HellpodEvents {
  impact: boolean;    // this frame
  opened: boolean;    // doors fully open this frame (controls may be enabled)
  finished: boolean;  // sequence complete this frame
}

const FALL_TIME = 2.4;
const DROP_HEIGHT = 150;
const IMPACT_HOLD = 0.35;
const OPEN_TIME = 0.55;
const EXIT_TIME = 0.5;

const _v = new THREE.Vector3(), _vel = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Procedural hellpod capsule + drop-in choreography. Stays in the world as a prop after landing.
 */
export class Hellpod {
  readonly group = new THREE.Group();
  /**
   * Every mesh of the pod. **The visibility toggle lives here, not on `group`** (2026-09-10, same rule as
   * `extraction/Ship`): three.js skips invisible subtrees when it collects lights, so a light parked under a
   * hidden group is not counted — showing the group then changes `numPointLights` and **every material in the
   * scene recompiles its shader**. A rescue drop lands mid-raid, which is the worst possible moment for that.
   * `group` therefore stays visible forever and carries `thrusterLight` (intensity 0 while idle).
   */
  private readonly body = new THREE.Group();
  state: HellpodState = 'idle';
  private t = 0;
  private readonly landing = new THREE.Vector3();
  private readonly doors: THREE.Object3D[] = [];
  private readonly thrusterMat: THREE.MeshStandardMaterial;
  private readonly thrusterLight: THREE.PointLight;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private yaw = 0;
  private lastY = 0;
  private fallSpeed = 0;

  constructor() {
    this.group.name = 'Hellpod';
    const body = this.mat(0x2a3140, 0.75, 0.4);
    const trim = this.mat(0xf2b632, 0.4, 0.5);
    const dark = this.mat(0x0f1218, 0.5, 0.7);
    this.thrusterMat = this.mat(0x331100, 0.2, 0.6);
    this.thrusterMat.emissive.setHex(0xff7a20);
    this.thrusterMat.emissiveIntensity = 0;

    // frame: 4 struts between the doors hold the nose (interior stays open for the trooper)
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const strut = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.1, 1.9, 0.1)), dark);
      strut.position.set(Math.cos(a) * 0.6, 1.1, Math.sin(a) * 0.6);
      strut.rotation.y = -a;
      this.body.add(strut);
    }
    const seatBack = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.5, 1.2, 0.08)), dark);
    seatBack.position.set(0, 1.1, 0.46);
    this.body.add(seatBack);
    const floor = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.66, 0.7, 0.16, 16)), body);
    floor.position.y = 0.08;
    this.body.add(floor);
    const floorTrim = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.72, 0.72, 0.05, 16)), trim);
    floorTrim.position.y = 0.16;
    this.body.add(floorTrim);
    // nose cone
    const nose = new THREE.Mesh(this.geo(new THREE.ConeGeometry(0.68, 0.9, 16)), body);
    nose.position.y = 2.45;
    this.body.add(nose);
    const noseTrim = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.66, 0.7, 0.12, 16)), trim);
    noseTrim.position.y = 2.02;
    this.body.add(noseTrim);
    // thrusters under the floor
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const th = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.12, 0.16, 0.22, 10)), this.thrusterMat);
      th.position.set(Math.cos(a) * 0.4, -0.08, Math.sin(a) * 0.4);
      this.body.add(th);
    }
    this.thrusterLight = new THREE.PointLight(0xff8a30, 0, 14, 2);
    this.thrusterLight.position.y = -0.4;
    this.group.add(this.thrusterLight);   // never hidden — see the `body` note

    // 4 petal doors hinged at the floor (one faces -Z: the exit direction)
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const pivot = new THREE.Object3D();
      pivot.position.set(Math.cos(a) * 0.62, 0.16, Math.sin(a) * 0.62);
      pivot.rotation.y = -a;                        // local +X radial outward
      const door = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.08, 1.86, 0.92)), body);
      door.position.set(0.04, 0.93, 0);
      pivot.add(door);
      const stripe = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.02, 1.4, 0.12)), trim);
      stripe.position.set(0.09, 0.95, 0);
      pivot.add(stripe);
      const window = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.02, 0.3, 0.4)), this.mat(0x0a1a2a, 0.9, 0.2));
      window.position.set(0.09, 1.5, 0);
      pivot.add(window);
      this.body.add(pivot);
      this.doors.push(pivot);
    }
    this.body.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.body.visible = false;
    this.group.add(this.body);
  }

  private mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(m);
    return m;
  }
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.geometries.push(g); return g; }

  /** Begin the drop: pod appears high above `landing` and falls. */
  start(landing: THREE.Vector3, yaw: number): void {
    this.landing.copy(landing);
    this.yaw = yaw;
    this.state = 'falling';
    this.t = 0;
    this.body.visible = true;
    this.group.position.set(landing.x, landing.y + DROP_HEIGHT, landing.z);
    this.group.rotation.set(0, yaw, 0);
    for (const d of this.doors) d.rotation.z = 0;
    this.thrusterMat.emissiveIntensity = 4;
    this.thrusterLight.intensity = 60;
    this.lastY = this.group.position.y;
  }

  /** Reset to hidden (mission abort). */
  hide(): void {
    this.state = 'idle';
    this.body.visible = false;
    this.thrusterLight.intensity = 0;
  }

  get position(): THREE.Vector3 { return this.group.position; }
  get isActive(): boolean { return this.state !== 'idle' && this.state !== 'done'; }
  get exitProgress(): number { return this.state === 'exiting' ? Math.min(1, this.t / EXIT_TIME) : this.state === 'done' ? 1 : 0; }
  get impactSpeed(): number { return this.fallSpeed; }

  /**
   * Cutscene camera pose for the current state; returns false once the rig should take over.
   */
  getCameraPose(pos: THREE.Vector3, look: THREE.Vector3): boolean {
    const p = this.group.position;
    if (this.state === 'falling') {
      const t = this.t / FALL_TIME;
      const a = this.yaw + Math.PI * 0.2 + t * 1.1;
      const r = 4.5 + t * 1.5;
      pos.set(p.x + Math.sin(a) * r, p.y + 6.5 - t * 3.0, p.z + Math.cos(a) * r);
      look.set(p.x, p.y - 4 + t * 3.5, p.z);
      return true;
    }
    if (this.state === 'impact') {
      const a = this.yaw + Math.PI * 0.2 + 1.1;
      pos.set(p.x + Math.sin(a) * 5.2, p.y + 3.2, p.z + Math.cos(a) * 5.2);
      look.set(p.x, p.y + 1.0, p.z);
      return true;
    }
    return false;
  }

  update(dt: number, ev: HellpodEvents): void {
    ev.impact = false; ev.opened = false; ev.finished = false;
    if (!this.isActive || dt <= 0) return;
    this.t += dt;
    const fx = FxManager.get();
    switch (this.state) {
      case 'falling': {
        const t = Math.min(1, this.t / FALL_TIME);
        const k = Math.pow(t, 1.35);
        const y = this.landing.y + DROP_HEIGHT * (1 - k);
        this.fallSpeed = Math.max(0, (this.lastY - y) / Math.max(dt, 1e-4));
        this.lastY = y;
        this.group.position.y = y;
        this.group.rotation.y = this.yaw + (1 - k) * 1.2; // spin settles to the exit heading
        this.group.rotation.z = Math.sin(this.t * 3) * 0.02;
        this.thrusterMat.emissiveIntensity = 3 + Math.random() * 2;
        this.thrusterLight.intensity = 40 + Math.random() * 30;
        if (fx) {
          _v.copy(this.group.position); _v.y -= 0.3;
          _vel.set(0, -this.fallSpeed, 0);
          ParticleBurst.thruster(fx.additive, _v, _vel, 4, 1.4);
          if (Math.random() < 0.5) ParticleBurst.smoke(fx.alpha, _v, 1, 0.8, 0x3a3630);
        }
        if (t >= 1) {
          this.group.position.y = this.landing.y;
          this.group.rotation.z = 0;
          this.state = 'impact'; this.t = 0;
          this.thrusterMat.emissiveIntensity = 0.5;
          this.thrusterLight.intensity = 0;
          ev.impact = true;
          if (fx) {
            ParticleBurst.groundBlast(fx.alpha, this.landing, 90, 16, 0x8a7a62, 0.6);
            ParticleBurst.fireball(fx.additive, this.landing, 30, 9, 1.6);
            ParticleBurst.smoke(fx.alpha, this.landing, 30, 2.2);
            _v.copy(this.landing); _v.y += 0.3;
            ParticleBurst.sparks(fx.additive, _v, _up, 40, 12);
            fx.flashes.flash(_v, 0xffb060, 120, 6, 0.25, 30);
          }
        }
        break;
      }
      case 'impact': {
        if (this.t >= IMPACT_HOLD) { this.state = 'opening'; this.t = 0; }
        break;
      }
      case 'opening': {
        const t = Math.min(1, this.t / OPEN_TIME);
        const ang = easeOutBack(t) * 1.55;
        for (const d of this.doors) d.rotation.z = -ang;
        if (fx && this.t < 0.1) {
          _v.copy(this.landing); _v.y += 0.4;
          ParticleBurst.dust(fx.alpha, _v, _up, 4, 1.5, 0xa09880);
        }
        if (t >= 1) { this.state = 'exiting'; this.t = 0; ev.opened = true; }
        break;
      }
      case 'exiting': {
        if (this.t >= EXIT_TIME) { this.state = 'done'; ev.finished = true; }
        break;
      }
    }
    this.thrusterMat.emissiveIntensity = Math.max(0, this.thrusterMat.emissiveIntensity - dt * 0.4);
  }

  /** Ease used by PlayerSystem for the step-out. */
  static exitEase(t: number): number { return easeOutCubic(t); }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}
