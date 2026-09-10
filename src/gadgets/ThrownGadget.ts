import * as THREE from 'three';
import { GRAVITY, Layers, PROP_STEP_UP_MAX, breakFragileAlong, type GadgetId, type GameContext } from '@/shared';

const BODY_R = 0.1;
const MAX_BODIES = 8;
/** Deploy where it is if it never touched the ground (thrown off the map edge, etc.). */
const MAX_FLIGHT = 4;

interface Body {
  mesh: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  gadget: GadgetId;
  age: number;
  active: boolean;
}

const _n = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Pooled thrown gadget canisters (돔 실드 / 유인 / 연막 / 화염수류탄). Arc with gravity, push out of obstacles,
 * and fire `onImpact` the moment they touch the ground — that is where the deployable is placed.
 *
 * No lights (constant scene light count); the canister glow is emissive material only.
 */
export class ThrownGadgetManager {
  readonly group = new THREE.Group();
  private readonly pool: Body[] = [];
  private readonly bodyGeo = new THREE.CylinderGeometry(BODY_R, BODY_R, 0.24, 10);
  private readonly capGeo = new THREE.SphereGeometry(BODY_R * 1.02, 10, 6);
  private readonly finGeo = new THREE.BoxGeometry(0.02, 0.1, 0.14);

  constructor(private readonly ctx: GameContext, private readonly onImpact: (gadget: GadgetId, position: THREE.Vector3) => void) {
    this.group.name = 'ThrownGadgets';
    for (let i = 0; i < MAX_BODIES; i++) {
      const mesh = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, emissive: 0xffffff, emissiveIntensity: 0.6, metalness: 0.5, roughness: 0.45 });
      const shell = new THREE.Mesh(this.bodyGeo, mat); shell.castShadow = true;
      const cap = new THREE.Mesh(this.capGeo, mat); cap.position.y = 0.12;
      const fin = new THREE.Mesh(this.finGeo, mat); fin.position.set(0, -0.1, 0);
      mesh.add(shell, cap, fin);
      mesh.visible = false;
      mesh.traverse((o) => o.layers.enable(Layers.NO_RAYCAST));
      this.group.add(mesh);
      this.pool.push({ mesh, mat, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), gadget: 'smokeGrenade', age: 0, active: false });
    }
    ctx.scene.add(this.group);
  }

  get activeCount(): number { let n = 0; for (const b of this.pool) if (b.active) n++; return n; }

  throw(gadget: GadgetId, colorCss: string, origin: THREE.Vector3, velocity: THREE.Vector3): void {
    let b = this.pool.find((x) => !x.active);
    if (!b) { b = this.pool[0]; this.land(b); }
    b.active = true;
    b.gadget = gadget;
    b.age = 0;
    b.pos.copy(origin);
    b.vel.copy(velocity);
    b.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
    try { _c.setStyle(colorCss); } catch { _c.setHex(0xffffff); }
    b.mat.color.copy(_c).multiplyScalar(0.6).addScalar(0.15);
    b.mat.emissive.copy(_c);
    b.mesh.position.copy(origin);
    b.mesh.visible = true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const world = this.ctx.world;
    for (const b of this.pool) {
      if (!b.active) continue;
      b.age += dt;
      b.vel.y -= GRAVITY * dt;
      _prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      if (world && world.ready) {
        // 2026-09-11: 창문 유리는 깨고 지나간다
        breakFragileAlong(world, _prev, b.pos);
        world.resolveCollision(b.pos, BODY_R);
        // 2026-09-11: 바닥 = 그 자리의 표면 (건물 2층 · 옥상 · 계단)
        const terrain = world.getHeightAt(b.pos.x, b.pos.z);
        const surface = world.getSurfaceY(b.pos.x, b.pos.z, b.pos.y + BODY_R - PROP_STEP_UP_MAX);
        const ground = surface + BODY_R;
        if (b.pos.y <= ground) {
          b.pos.y = ground;
          if (surface > terrain + 0.02) _n.set(0, 1, 0); else world.getNormalAt(b.pos.x, b.pos.z, _n);
          this.land(b);
          continue;
        }
      }
      if (b.age >= MAX_FLIGHT) { this.land(b); continue; }
      b.mesh.position.copy(b.pos);
      b.mesh.rotation.x += b.spin.x * dt;
      b.mesh.rotation.y += b.spin.y * dt;
      b.mesh.rotation.z += b.spin.z * dt;
    }
  }

  private land(b: Body): void {
    if (!b.active) return;
    b.active = false;
    b.mesh.visible = false;
    this.onImpact(b.gadget, b.pos);
  }

  clear(): void {
    for (const b of this.pool) { b.active = false; b.mesh.visible = false; }
  }

  dispose(): void {
    this.bodyGeo.dispose(); this.capGeo.dispose(); this.finGeo.dispose();
    for (const b of this.pool) b.mat.dispose();
    this.pool.length = 0;
    this.group.removeFromParent();
  }
}
