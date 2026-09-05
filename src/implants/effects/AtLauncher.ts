import * as THREE from 'three';
import { IMPLANT_AT_SPEED, Layers, type GameContext } from '@/shared';
import type { ImplantFx } from '../fx/ImplantFx';

export interface RocketImpact {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Enemy struck by a direct hit, or null for a surface hit. */
  enemyId: number | null;
}

interface Rocket {
  active: boolean;
  visualOnly: boolean;
  life: number;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  dir: THREE.Vector3;
  mesh: THREE.Group;
}

const MAX_ROCKETS = 8;
/** Rockets die after this long even if they never hit anything. */
const LIFETIME = 4;
/** Seconds between trail streak segments. */
const TRAIL_INTERVAL = 0.02;

/** The rocket model is built pointing along -Z (the weapon-socket convention). */
const FWD = new THREE.Vector3(0, 0, -1);
const _d = new THREE.Vector3(), _nrm = new THREE.Vector3(), _pt = new THREE.Vector3();

/**
 * Pooled anti-tank rockets. Every step is swept against the world (or the ship interior) and enemy
 * hitboxes so a fast rocket never tunnels. Local rockets report their impact through `onImpact`;
 * `visualOnly` replicas of a peer's shot fizzle silently — the caster broadcasts `imp rocketHit`.
 */
export class RocketPool {
  private readonly pool: Rocket[] = [];
  private readonly bodyGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.42, 10);
  private readonly noseGeo = new THREE.ConeGeometry(0.075, 0.18, 10);
  private readonly finGeo = new THREE.BoxGeometry(0.02, 0.12, 0.14);
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly noseMat: THREE.MeshStandardMaterial;
  private readonly impact: RocketImpact = { point: new THREE.Vector3(), normal: new THREE.Vector3(), enemyId: null };
  private trailAcc = 0;

  constructor(
    scene: THREE.Scene,
    private readonly fx: ImplantFx,
    private readonly color: number,
    private readonly onImpact: (hit: RocketImpact) => void,
  ) {
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a4149, roughness: 0.6, metalness: 0.5 });
    this.noseMat = new THREE.MeshStandardMaterial({ color: 0x1c2126, emissive: color, emissiveIntensity: 0.9, roughness: 0.5, metalness: 0.4 });
    this.bodyGeo.rotateX(Math.PI / 2);     // cylinder along Z
    this.noseGeo.rotateX(-Math.PI / 2);    // cone tip toward -Z
    for (let i = 0; i < MAX_ROCKETS; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
      const nose = new THREE.Mesh(this.noseGeo, this.noseMat);
      nose.position.z = -0.3;
      g.add(body, nose);
      for (let f = 0; f < 3; f++) {
        const fin = new THREE.Mesh(this.finGeo, this.bodyMat);
        const a = (f / 3) * Math.PI * 2;
        fin.position.set(Math.cos(a) * 0.07, Math.sin(a) * 0.07, 0.18);
        fin.rotation.z = a;
        g.add(fin);
      }
      g.visible = false;
      g.traverse((o) => o.layers.enable(Layers.NO_RAYCAST));
      scene.add(g);
      this.pool.push({
        active: false, visualOnly: false, life: 0,
        pos: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), mesh: g,
      });
    }
  }

  fire(origin: THREE.Vector3, dir: THREE.Vector3, visualOnly: boolean): void {
    const r = this.pool.find((x) => !x.active) ?? this.pool[0];
    r.active = true;
    r.visualOnly = visualOnly;
    r.life = LIFETIME;
    r.pos.copy(origin);
    r.prev.copy(origin);
    r.dir.copy(dir).normalize();
    r.mesh.position.copy(origin);
    r.mesh.quaternion.setFromUnitVectors(FWD, r.dir);
    r.mesh.visible = true;
  }

  update(dt: number, ctx: GameContext): void {
    if (dt <= 0) return;
    this.trailAcc += dt;
    const trail = this.trailAcc >= TRAIL_INTERVAL;
    const step = IMPLANT_AT_SPEED * dt;
    const interior = ctx.player?.interior ?? null;
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    for (const r of this.pool) {
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) { this.kill(r); continue; }
      r.prev.copy(r.pos);
      r.pos.addScaledVector(r.dir, step);
      _d.subVectors(r.pos, r.prev);
      const len = _d.length();
      if (len > 1e-5) {
        _d.divideScalar(len);
        const eh = ctx.enemies ? ctx.enemies.raycast(r.prev, _d, len) : null;
        const wh = interior ? interior.raycast(r.prev, _d, len) : world ? world.raycast(r.prev, _d, len) : null;
        let hit = false;
        if (eh && (!wh || eh.distance <= wh.distance)) {
          this.impact.point.copy(eh.point); this.impact.normal.copy(eh.normal); this.impact.enemyId = eh.enemy.id;
          hit = true;
        } else if (wh) {
          this.impact.point.copy(wh.point); this.impact.normal.copy(wh.normal); this.impact.enemyId = null;
          hit = true;
        } else if (!interior && world && r.pos.y < world.getHeightAt(r.pos.x, r.pos.z)) {
          this.impact.point.copy(r.pos);
          this.impact.normal.copy(world.getNormalAt(r.pos.x, r.pos.z, _nrm));
          this.impact.enemyId = null;
          hit = true;
        }
        if (hit) {
          if (r.visualOnly) this.fx.spark(this.impact.point, this.color, 0.5);
          else this.onImpact(this.impact);
          this.kill(r);
          continue;
        }
      }
      r.mesh.position.copy(r.pos);
      if (trail) {
        _pt.copy(r.pos).addScaledVector(r.dir, -0.28);
        this.fx.streak(r.prev, _pt, this.color, 0.22, 0.07 + Math.random() * 0.03);
      }
    }
    if (trail) this.trailAcc = 0;
  }

  clear(): void { for (const r of this.pool) this.kill(r); }

  dispose(): void {
    this.clear();
    for (const r of this.pool) r.mesh.removeFromParent();
    this.pool.length = 0;
    this.bodyGeo.dispose(); this.noseGeo.dispose(); this.finGeo.dispose();
    this.bodyMat.dispose(); this.noseMat.dispose();
  }

  private kill(r: Rocket): void { r.active = false; r.mesh.visible = false; }
}
