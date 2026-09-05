import * as THREE from 'three';
import { GRAVITY, type GameContext, type EnemyRef } from '@/shared';
import { FxManager } from '@/core/fx';
import { raycastBlockers } from './Blocking';

export interface ProjectileHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  enemy: EnemyRef | null;
  part?: 'head' | 'body' | 'rear' | 'front';
  obstacle: boolean;
  dir: THREE.Vector3;
  /** Distance travelled from the muzzle to the hit point (meters) — for damage falloff. */
  distance: number;
}

interface Slug {
  active: boolean;
  pos: THREE.Vector3; vel: THREE.Vector3; prev: THREE.Vector3;
  life: number; damage: number; color: number; weaponId: string;
  travelled: number;
  /** Replica of a remote player's shot: impact FX only, never damage (routed to `onVisualHit`). */
  visualOnly: boolean;
  mesh: THREE.Mesh;
}

const MAX = 48;
const _dir = new THREE.Vector3(), _block = new THREE.Vector3();

/**
 * Pooled travelling projectiles for weapons with `projectileSpeed`. Each step is swept with
 * world + enemy raycasts so fast projectiles never tunnel.
 */
export class ProjectilePool {
  readonly group = new THREE.Group();
  private readonly pool: Slug[] = [];
  private readonly geo = new THREE.SphereGeometry(0.06, 8, 6);
  private readonly mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private readonly hit: ProjectileHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), enemy: null, part: undefined, obstacle: false, dir: new THREE.Vector3(), distance: 0 };

  /**
   * @param onHit       damage-dealing hit (local shots)
   * @param onVisualHit impact FX only, for `visualOnly` replicas of remote shots (optional)
   */
  constructor(
    private readonly ctx: GameContext,
    private readonly onHit: (h: ProjectileHit, damage: number, weaponId: string) => void,
    private readonly onVisualHit?: (h: ProjectileHit, weaponId: string) => void,
  ) {
    this.group.name = 'Projectiles';
    for (let i = 0; i < MAX; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat.clone());
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), life: 0, damage: 0, color: 0xffffff, weaponId: '', travelled: 0, visualOnly: false, mesh });
    }
    ctx.scene.add(this.group);
  }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, damage: number, range: number, color: number, weaponId: string, visualOnly = false): void {
    let s = this.pool.find((x) => !x.active);
    if (!s) s = this.pool[0];
    s.active = true;
    s.pos.copy(origin); s.prev.copy(origin);
    s.vel.copy(dir).multiplyScalar(speed);
    s.life = range / speed + 0.2;
    s.damage = damage; s.color = color; s.weaponId = weaponId; s.travelled = 0; s.visualOnly = visualOnly;
    (s.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    s.mesh.visible = true;
    s.mesh.position.copy(origin);
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const ctx = this.ctx;
    const fx = FxManager.get();
    for (const s of this.pool) {
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) { this.kill(s); continue; }
      s.prev.copy(s.pos);
      s.vel.y -= GRAVITY * 0.15 * dt; // slight drop
      s.pos.addScaledVector(s.vel, dt);
      _dir.subVectors(s.pos, s.prev);
      const segLen = _dir.length();
      if (segLen > 1e-5) {
        _dir.divideScalar(segLen);
        const eh = ctx.enemies ? ctx.enemies.raycast(s.prev, _dir, segLen) : null;
        const wh = ctx.world && ctx.world.ready ? ctx.world.raycast(s.prev, _dir, segLen) : null;
        let hitAny = false;
        const h = this.hit;
        // shields / solid deployables on the way (allied barriers ignore allied slugs — see Blocking.ts)
        const bd = raycastBlockers(ctx, s.prev, _dir, segLen, _block, false);
        if (bd >= 0 && bd <= (eh ? eh.distance : Infinity) && bd <= (wh ? wh.distance : Infinity)) {
          h.point.copy(_block); h.normal.copy(_dir).negate(); h.enemy = null; h.part = undefined; h.obstacle = true; hitAny = true;
        } else if (eh && (!wh || eh.distance <= wh.distance)) {
          h.point.copy(eh.point); h.normal.copy(eh.normal); h.enemy = eh.enemy; h.part = eh.part; h.obstacle = false; hitAny = true;
        } else if (wh) {
          h.point.copy(wh.point); h.normal.copy(wh.normal); h.enemy = null; h.part = undefined; h.obstacle = !!wh.obstacle; hitAny = true;
        } else if (ctx.world && ctx.world.ready && s.pos.y < ctx.world.getHeightAt(s.pos.x, s.pos.z)) {
          h.point.copy(s.pos); ctx.world.getNormalAt(s.pos.x, s.pos.z, h.normal); h.enemy = null; h.part = undefined; h.obstacle = false; hitAny = true;
        }
        if (hitAny) {
          h.dir.copy(_dir);
          h.distance = s.travelled + h.point.distanceTo(s.prev);
          if (s.visualOnly) this.onVisualHit?.(h, s.weaponId);
          else this.onHit(h, s.damage, s.weaponId);
          this.kill(s);
          continue;
        }
        if (fx) fx.tracers.add(s.prev, s.pos, s.color, 0.06, 0.08, 0);
        s.travelled += segLen;
      }
      s.mesh.position.copy(s.pos);
    }
  }

  private kill(s: Slug): void { s.active = false; s.mesh.visible = false; }

  clear(): void { for (const s of this.pool) this.kill(s); }

  dispose(): void {
    this.geo.dispose(); this.mat.dispose();
    for (const s of this.pool) (s.mesh.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
