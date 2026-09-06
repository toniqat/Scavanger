import * as THREE from 'three';
import { GRAVITY, GRENADE_FUSE as SHARED_GRENADE_FUSE, type GameContext, type GrenadeView } from '@/shared';
import type { WeaponFx } from './fx/WeaponFx';

/** Alias of the shared contract value (3 s); kept for the barrel export. */
export const GRENADE_FUSE = SHARED_GRENADE_FUSE;
export const GRENADE_RADIUS = 6;
export const GRENADE_DAMAGE = 250;
const BODY_R = 0.08;
const MAX_GRENADES = 8;
/** Share of the blast damage a player takes (own grenade and, since Phase 7, squadmates' replicas alike). */
const PLAYER_DAMAGE_MUL = 0.6;

interface GrenadeBody {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  fuse: number;
  active: boolean;
  /** Replica of a remote player's grenade: arc/bounce/FX/audio only — no enemy or player damage, no gameplay events. */
  visualOnly: boolean;
  led: THREE.MeshStandardMaterial;
  ledMesh: THREE.Mesh;
  /** Last LED blink state (rising edge → one pooled light pulse). */
  blinkOn: boolean;
}

const _n = new THREE.Vector3(), _tmp = new THREE.Vector3();

/**
 * Pooled frag grenades: arc with gravity, bounce on terrain, fuse, radial damage (enemies + player),
 * explosion FX and events.
 *
 * Perf note: grenades carry NO light of their own. Toggling a `PointLight`'s visibility changes the scene's
 * light count, and three.js then recompiles every lit material (dozens of shader programs) — that was the
 * multi-hundred-ms hitch on every throw and every explosion. The LED pulse and the explosion flash both go
 * through the shared `FlashPool`, whose lights are permanently in the scene (constant light count).
 */
export class GrenadeManager {
  readonly group = new THREE.Group();
  private readonly pool: GrenadeBody[] = [];
  private readonly bodyGeo = new THREE.SphereGeometry(BODY_R, 12, 10);
  private readonly bandGeo = new THREE.CylinderGeometry(BODY_R * 1.02, BODY_R * 1.02, 0.03, 12);
  private readonly capGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.05, 8);
  private readonly ledGeo = new THREE.SphereGeometry(0.012, 6, 6);
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
      const ledMesh = new THREE.Mesh(this.ledGeo, led); ledMesh.position.set(0, BODY_R + 0.05, 0);
      mesh.add(body, band, cap, ledMesh);
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), fuse: 0, active: false, visualOnly: false, led, ledMesh, blinkOn: false });
    }
    ctx.scene.add(this.group);
  }

  get activeCount(): number { let n = 0; for (const g of this.pool) if (g.active) n++; return n; }

  /**
   * @param visualOnly replica of a remote player's grenade (multiplayer): same arc, bounce, fuse and
   *   explosion FX/audio and (Phase 7) the same radial damage to the local player, but no `applyExplosion`
   *   (enemy damage is the thrower's) and no `grenade:*` events.
   *   Prefers to evict another visual-only replica when the pool is full so a live local grenade never pops early.
   * @param fuse seconds until the explosion (`GRENADE_FUSE` − cook time for a cooked grenade; 0 → explodes on the next update).
   */
  throw(origin: THREE.Vector3, velocity: THREE.Vector3, visualOnly = false, fuse = GRENADE_FUSE): boolean {
    let g = this.pool.find((x) => !x.active);
    if (!g) { g = this.pool.find((x) => x.visualOnly) ?? this.pool[0]; this.explode(g); }
    g.active = true;
    g.visualOnly = visualOnly;
    g.pos.copy(origin); g.vel.copy(velocity);
    g.spin.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
    g.fuse = Math.max(0, fuse);
    g.mesh.visible = true;
    g.mesh.position.copy(origin);
    g.blinkOn = false; g.led.emissiveIntensity = 0;
    if (!visualOnly) this.ctx.bus.emit('grenade:thrown', { position: origin.clone(), velocity: velocity.clone() });
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
      const rate = 3 + Math.max(0, GRENADE_FUSE - g.fuse) * 5;
      const blink = Math.max(0, Math.sin(g.fuse * rate * Math.PI)) > 0.6;
      g.led.emissiveIntensity = blink ? 4 : 0;
      if (blink && !g.blinkOn) {
        // rising edge → one short pooled light pulse (no per-grenade light: keeps the scene light count constant)
        g.ledMesh.updateWorldMatrix(true, false);
        _tmp.setFromMatrixPosition(g.ledMesh.matrixWorld);
        this.fx.ledBlink(_tmp);
      }
      g.blinkOn = blink;
    }
  }

  private explode(g: GrenadeBody): void {
    g.active = false; g.mesh.visible = false; g.led.emissiveIntensity = 0; g.blinkOn = false;
    const ctx = this.ctx;
    const pos = g.pos;
    const visualOnly = g.visualOnly;
    g.visualOnly = false;
    // Visual-only replicas (remote players' grenades) never damage enemies here: the thrower's client resolves
    // that through the host. Phase 7: they DO hurt the local player — same radius / falloff / friendly-fire
    // rule as our own grenades (a squadmate's frag lands on you exactly like your own).
    const kills = !visualOnly && ctx.enemies ? ctx.enemies.applyExplosion(pos, GRENADE_RADIUS, GRENADE_DAMAGE) : 0;
    if (ctx.player && !ctx.player.isDead) {
      _tmp.copy(ctx.player.position); _tmp.y += 0.9;
      const d = _tmp.distanceTo(pos);
      // self / friendly damage with linear falloff
      if (d < GRENADE_RADIUS) {
        const dmg = GRENADE_DAMAGE * (1 - d / GRENADE_RADIUS) * PLAYER_DAMAGE_MUL;
        if (dmg > 1) ctx.player.takeDamage(dmg, pos.clone());
      }
      const shake = THREE.MathUtils.clamp(1 - d / 28, 0, 1);
      if (shake > 0) ctx.bus.emit('camera:shake', { intensity: 0.25 + shake * 0.75, duration: 0.45 });
    }
    this.fx.explosion(pos, GRENADE_RADIUS);
    if (!visualOnly) ctx.bus.emit('grenade:exploded', { position: pos.clone(), radius: GRENADE_RADIUS });
    ctx.bus.emit('audio:play', { id: 'explosion', position: pos, volume: 1 });
    if (kills > 0) ctx.bus.emit('ui:hitmarker', { kill: true });
  }

  /** Live grenades for the HUD's off-screen indicators (`ctx.weapons.getGrenades()`). Reuses one view object per pool body. */
  getViews(): readonly GrenadeView[] {
    this.viewList.length = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const g = this.pool[i];
      if (!g.active) continue;
      let v = this.views[i];
      if (!v) { v = { position: g.pos, fuse: 0, remote: false }; this.views[i] = v; }
      v.fuse = g.fuse; v.remote = g.visualOnly;
      this.viewList.push(v);
    }
    return this.viewList;
  }
  private readonly views: Array<{ position: THREE.Vector3; fuse: number; remote: boolean }> = [];
  private readonly viewList: GrenadeView[] = [];

  clear(): void {
    for (const g of this.pool) { g.active = false; g.visualOnly = false; g.mesh.visible = false; g.led.emissiveIntensity = 0; g.blinkOn = false; }
  }

  dispose(): void {
    this.bodyGeo.dispose(); this.bandGeo.dispose(); this.capGeo.dispose(); this.ledGeo.dispose();
    this.bodyMat.dispose(); this.bandMat.dispose(); this.capMat.dispose();
    for (const g of this.pool) g.led.dispose();
    this.group.removeFromParent();
  }
}
