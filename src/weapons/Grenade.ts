import * as THREE from 'three';
import { GRAVITY, type GameContext } from '@/shared';
import type { WeaponFx } from './fx/WeaponFx';

export const GRENADE_FUSE = 2.5;
export const GRENADE_RADIUS = 6;
export const GRENADE_DAMAGE = 250;
const BODY_R = 0.08;
const MAX_GRENADES = 8;

interface GrenadeBody {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  fuse: number;
  active: boolean;
  light: THREE.PointLight;
  led: THREE.MeshStandardMaterial;
}

const _n = new THREE.Vector3(), _tmp = new THREE.Vector3();

/**
 * Pooled frag grenades: arc with gravity, bounce on terrain, fuse, radial damage (enemies + player),
 * explosion FX and events.
 */
export class GrenadeManager {
  readonly group = new THREE.Group();
  private readonly pool: GrenadeBody[] = [];
  private readonly bodyGeo = new THREE.SphereGeometry(BODY_R, 12, 10);
  private readonly bandGeo = new THREE.CylinderGeometry(BODY_R * 1.02, BODY_R * 1.02, 0.03, 12);
  private readonly capGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.05, 8);
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2a, metalness: 0.5, roughness: 0.6 });
  private readonly bandMat = new THREE.MeshStandardMaterial({ color: 0xf2b632, metalness: 0.4, roughness: 0.5 });
  private readonly capMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.8, roughness: 0.4 });

  constructor(private readonly ctx: GameContext, private readonly fx: WeaponFx) {
    this.group.name = 'Grenades';
    for (let i = 0; i < MAX_GRENADES; i++) {
      const mesh = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeo, this.bodyMat); body.castShadow = true;
      const band = new THREE.Mesh(this.bandGeo, this.bandMat);
      const cap = new THREE.Mesh(this.capGeo, this.capMat); cap.position.y = BODY_R + 0.02;
      const led = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2020, emissiveIntensity: 0 });
      const ledMesh = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), led); ledMesh.position.set(0, BODY_R + 0.05, 0);
      const light = new THREE.PointLight(0xff3020, 0, 3, 2);
      mesh.add(body, band, cap, ledMesh, light);
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), fuse: 0, active: false, light, led });
    }
    ctx.scene.add(this.group);
  }

  get activeCount(): number { let n = 0; for (const g of this.pool) if (g.active) n++; return n; }

  throw(origin: THREE.Vector3, velocity: THREE.Vector3): boolean {
    let g = this.pool.find((x) => !x.active);
    if (!g) { g = this.pool[0]; this.explode(g); }
    g.active = true;
    g.pos.copy(origin); g.vel.copy(velocity);
    g.spin.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
    g.fuse = GRENADE_FUSE;
    g.mesh.visible = true;
    g.mesh.position.copy(origin);
    g.light.intensity = 0;
    this.ctx.bus.emit('grenade:thrown', { position: origin.clone(), velocity: velocity.clone() });
    this.ctx.bus.emit('audio:play', { id: 'grenade_throw', position: origin, volume: 0.7 });
    return true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const world = this.ctx.world;
    for (const g of this.pool) {
      if (!g.active) continue;
      g.fuse -= dt;
      if (g.fuse <= 0) { this.explode(g); continue; }
      g.vel.y -= GRAVITY * dt;
      g.pos.addScaledVector(g.vel, dt);
      if (world && world.ready) {
        world.resolveCollision(g.pos, BODY_R);
        const ground = world.getHeightAt(g.pos.x, g.pos.z) + BODY_R;
        if (g.pos.y < ground) {
          g.pos.y = ground;
          world.getNormalAt(g.pos.x, g.pos.z, _n);
          const vn = g.vel.dot(_n);
          if (vn < 0) {
            // reflect with restitution, damp tangential (friction)
            g.vel.addScaledVector(_n, -vn * 1.4);
            g.vel.multiplyScalar(0.72);
            if (Math.abs(vn) > 2) this.ctx.bus.emit('audio:play', { id: 'grenade_bounce', position: g.pos, volume: Math.min(1, Math.abs(vn) / 12) });
          }
          if (g.vel.lengthSq() < 0.05) g.vel.set(0, 0, 0);
          g.spin.multiplyScalar(0.9);
        }
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += g.spin.x * dt; g.mesh.rotation.y += g.spin.y * dt; g.mesh.rotation.z += g.spin.z * dt;
      // beeping LED, faster as the fuse burns down
      const rate = 3 + (GRENADE_FUSE - g.fuse) * 5;
      const blink = Math.max(0, Math.sin(g.fuse * rate * Math.PI)) > 0.6 ? 1 : 0;
      g.led.emissiveIntensity = blink * 4;
      g.light.intensity = blink * 1.5;
    }
  }

  private explode(g: GrenadeBody): void {
    g.active = false; g.mesh.visible = false; g.light.intensity = 0;
    const ctx = this.ctx;
    const pos = g.pos;
    const kills = ctx.enemies ? ctx.enemies.applyExplosion(pos, GRENADE_RADIUS, GRENADE_DAMAGE) : 0;
    // self damage with linear falloff
    if (ctx.player && !ctx.player.isDead) {
      _tmp.copy(ctx.player.position); _tmp.y += 0.9;
      const d = _tmp.distanceTo(pos);
      if (d < GRENADE_RADIUS) {
        const dmg = GRENADE_DAMAGE * (1 - d / GRENADE_RADIUS) * 0.6;
        if (dmg > 1) ctx.player.takeDamage(dmg, pos.clone());
      }
      const shake = THREE.MathUtils.clamp(1 - d / 28, 0, 1);
      if (shake > 0) ctx.bus.emit('camera:shake', { intensity: 0.25 + shake * 0.75, duration: 0.45 });
    }
    this.fx.explosion(pos, GRENADE_RADIUS);
    ctx.bus.emit('grenade:exploded', { position: pos.clone(), radius: GRENADE_RADIUS });
    ctx.bus.emit('audio:play', { id: 'explosion', position: pos, volume: 1 });
    if (kills > 0) ctx.bus.emit('ui:hitmarker', { kill: true });
  }

  clear(): void {
    for (const g of this.pool) { g.active = false; g.mesh.visible = false; g.light.intensity = 0; }
  }

  dispose(): void {
    this.bodyGeo.dispose(); this.bandGeo.dispose(); this.capGeo.dispose();
    this.bodyMat.dispose(); this.bandMat.dispose(); this.capMat.dispose();
    for (const g of this.pool) g.led.dispose();
    this.group.removeFromParent();
  }
}
