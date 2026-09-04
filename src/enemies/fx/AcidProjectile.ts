import * as THREE from 'three';
import { GRAVITY, Layers, PLAYER_HEIGHT, PLAYER_RADIUS, type GameContext } from '@/shared';
import { SPEWER_SPIT } from '../EnemyTypes';
import type { BloodFX } from './BloodFX';

const POOL = 14;
const GLOB_RADIUS = 0.22;
const MAX_LIFE = 4;

interface Glob {
  mesh: THREE.Mesh;
  active: boolean;
  readonly vel: THREE.Vector3;
  readonly prev: THREE.Vector3;
  life: number;
  shooterId: number;
}

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _aim = new THREE.Vector3();

/** Pooled arcing acid globs fired by spewers. Tests against terrain/obstacles (world raycast) and the player capsule. */
export class AcidProjectiles {
  private readonly globs: Glob[] = [];
  private readonly geo = new THREE.SphereGeometry(GLOB_RADIUS, 10, 8);
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x9fe64a, emissive: 0x5ab81c, emissiveIntensity: 1.4, roughness: 0.3, transparent: true, opacity: 0.92 });

  constructor(private readonly scene: THREE.Scene, private readonly fx: BloodFX) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.visible = false;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.globs.push({ mesh, active: false, vel: new THREE.Vector3(), prev: new THREE.Vector3(), life: 0, shooterId: -1 });
    }
  }

  /** Launch a glob from `from` toward the player's predicted position with a ballistic arc. */
  fire(from: THREE.Vector3, ctx: GameContext, shooterId: number): boolean {
    const player = ctx.player;
    if (!player) return false;
    let g: Glob | null = null;
    for (const c of this.globs) if (!c.active) { g = c; break; }
    if (!g) return false;
    const dist = from.distanceTo(player.position);
    const T = THREE.MathUtils.clamp(dist / 15, 0.7, 1.5);
    _aim.copy(player.position).addScaledVector(player.velocity, T * 0.6);
    _aim.y += PLAYER_HEIGHT * 0.5;
    // a little inaccuracy so the player can dodge
    _aim.x += (Math.random() - 0.5) * 1.4;
    _aim.z += (Math.random() - 0.5) * 1.4;
    _d.subVectors(_aim, from);
    g.vel.set(_d.x / T, _d.y / T + 0.5 * GRAVITY * T, _d.z / T);
    g.mesh.position.copy(from);
    g.prev.copy(from);
    g.life = 0;
    g.shooterId = shooterId;
    g.active = true;
    g.mesh.visible = true;
    return true;
  }

  update(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    const player = ctx.player;
    for (const g of this.globs) {
      if (!g.active) continue;
      g.life += dt;
      g.prev.copy(g.mesh.position);
      g.vel.y -= GRAVITY * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      const s = 1 + Math.sin(g.life * 18) * 0.12;
      g.mesh.scale.set(s, 1 / s, s);

      let splashed = false;
      // player capsule: segment feet→head
      if (player && !player.isDead) {
        _p.copy(player.position);
        const py = THREE.MathUtils.clamp(g.mesh.position.y, _p.y + PLAYER_RADIUS, _p.y + PLAYER_HEIGHT - PLAYER_RADIUS);
        _p.y = py;
        if (_p.distanceToSquared(g.mesh.position) <= (PLAYER_RADIUS + GLOB_RADIUS) ** 2) {
          player.takeDamage(SPEWER_SPIT.damage, g.prev);
          ctx.bus.emit('player:applySlow', { duration: SPEWER_SPIT.slowDuration, factor: 0.55 });
          ctx.bus.emit('enemy:attacked', { id: g.shooterId, type: 'spewer', damage: SPEWER_SPIT.damage, position: g.mesh.position });
          splashed = true;
        }
      }
      if (!splashed && world) {
        _d.subVectors(g.mesh.position, g.prev);
        const len = _d.length();
        if (len > 1e-4) {
          _d.multiplyScalar(1 / len);
          const hit = world.raycast(g.prev, _d, len + GLOB_RADIUS);
          if (hit) { g.mesh.position.copy(hit.point); splashed = true; }
        }
        if (!splashed && g.mesh.position.y < world.getHeightAt(g.mesh.position.x, g.mesh.position.z) + GLOB_RADIUS * 0.5) splashed = true;
        if (!splashed && !world.isInsideBounds(g.mesh.position.x, g.mesh.position.z)) splashed = true;
      }
      if (!splashed && g.life > MAX_LIFE) splashed = true;

      if (splashed) {
        this.splash(g, ctx);
        g.active = false;
        g.mesh.visible = false;
      }
    }
  }

  private splash(g: Glob, ctx: GameContext): void {
    const p = g.mesh.position;
    this.fx.burst(p, 26, 'acid', 4.5);
    this.fx.splat(p, 1.1, 'acid', ctx.world);
    ctx.bus.emit('audio:play', { id: 'acid_splash', position: p, volume: 0.8 });
    const player = ctx.player;
    if (player && !player.isDead) {
      const d = player.position.distanceTo(p);
      if (d < 2.4 && d > 0.6) {
        player.takeDamage(SPEWER_SPIT.splashDamage, p);
        ctx.bus.emit('player:applySlow', { duration: SPEWER_SPIT.slowDuration * 0.6, factor: 0.7 });
        ctx.bus.emit('enemy:attacked', { id: g.shooterId, type: 'spewer', damage: SPEWER_SPIT.splashDamage, position: p });
      }
    }
  }

  clear(): void {
    for (const g of this.globs) { g.active = false; g.mesh.visible = false; }
  }

  dispose(): void {
    for (const g of this.globs) this.scene.remove(g.mesh);
    this.globs.length = 0;
    this.geo.dispose();
    this.mat.dispose();
  }
}
