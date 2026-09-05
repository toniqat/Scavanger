import * as THREE from 'three';
import { FxManager, ParticleBurst } from '@/core/fx';

const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _qy = new THREE.Quaternion();
/** Lays the arc ring (XY plane) flat so its sweep runs horizontally in front of the swinger. */
const _qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

interface Ring { mesh: THREE.Mesh; life: number; maxLife: number; radius: number }
interface Arc { mesh: THREE.Mesh; life: number; maxLife: number; scale: number }

/**
 * Weapon-specific effect recipes layered on the shared FX pools: muzzle flash, casings, impacts,
 * explosions (fireball + smoke + ground ring + shockwave).
 */
export class WeaponFx {
  readonly group = new THREE.Group();
  private readonly rings: Ring[] = [];
  private readonly ringGeo = new THREE.RingGeometry(0.7, 1.0, 40);
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0xffd8a0, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  /** Melee swing arcs (pooled, no lights — see "Grenade hitch"). */
  private readonly arcs: Arc[] = [];
  private readonly arcGeo = new THREE.RingGeometry(0.48, 1.0, 26, 1, Math.PI / 2 - 0.95, 1.9);
  private readonly arcMat = new THREE.MeshBasicMaterial({ color: 0xdbe7ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });

  constructor(scene: THREE.Scene) {
    this.group.name = 'WeaponFX';
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(this.ringGeo, this.ringMat.clone());
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 22;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 0.45, radius: 6 });
    }
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(this.arcGeo, this.arcMat.clone());
      mesh.visible = false;
      mesh.renderOrder = 23;
      this.group.add(mesh);
      this.arcs.push({ mesh, life: 0, maxLife: 0.2, scale: 1 });
    }
    scene.add(this.group);
  }

  /**
   * Melee swing swoosh: a flat arc sweeping in front of the swinger. `pos` is the swing pivot (chest height),
   * `yaw` the body yaw. Pooled — never allocates, never adds a light.
   */
  meleeArc(pos: THREE.Vector3, yaw: number, scale = 1): void {
    const a = this.arcs.find((x) => x.life <= 0) ?? this.arcs[0];
    a.life = a.maxLife;
    a.scale = scale;
    a.mesh.position.copy(pos);
    _qy.setFromAxisAngle(_up, yaw);
    a.mesh.quaternion.copy(_qy).multiply(_qFlat);
    a.mesh.scale.setScalar(scale * 0.7);
    (a.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75;
    a.mesh.visible = true;
  }

  /** Melee contact: ichor on a bug, sparks + dust on a deployable / surface. */
  meleeImpact(point: THREE.Vector3, dir: THREE.Vector3, enemy: boolean): void {
    const fx = FxManager.get(); if (!fx) return;
    _n.copy(dir).negate();
    if (_n.lengthSq() < 0.01) _n.copy(_up);
    if (enemy) {
      ParticleBurst.ichor(fx.additive, point, _n, 16);
    } else {
      ParticleBurst.sparks(fx.additive, point, _n, 7, 6, 0xffd0a0);
      ParticleBurst.dust(fx.alpha, point, _n, 3, 0.4, 0x8a8a8a);
    }
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color: number, scale = 1): void {
    const fx = FxManager.get(); if (!fx) return;
    fx.flashes.flash(pos, color, 7 * scale, 0.45 * scale, 0.045, 7);
    _p.copy(pos).addScaledVector(dir, 0.1);
    ParticleBurst.sparks(fx.additive, _p, dir, Math.round(3 * scale), 9, color);
    // brief smoke wisp
    ParticleBurst.dust(fx.alpha, _p, dir, 1, 0.25, 0x8c8c8c);
  }

  /** Grenade LED pulse: a tiny short-lived pooled light + glint (the grenade itself carries no light). */
  ledBlink(pos: THREE.Vector3): void {
    const fx = FxManager.get(); if (!fx) return;
    fx.flashes.flash(pos, 0xff3a24, 1.1, 0.14, 0.09, 2.5);
  }

  /**
   * Pre-compile every shader the scene can need (hidden pooled meshes included: explosion rings, flash
   * sprites, grenade bodies, projectiles, gore decals …) so the first throw / shot / kill does not stall on a
   * shader compile. Uses `compileAsync` (KHR_parallel_shader_compile → no main-thread stall) when available.
   */
  warmUp(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    try {
      const r = renderer as THREE.WebGLRenderer & { compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown> };
      if (typeof r.compileAsync === 'function') r.compileAsync(scene, camera).catch(() => { /* context lost */ });
      else renderer.compile(scene, camera);
    } catch { /* never let a warm-up break the frame */ }
  }

  casing(pos: THREE.Vector3, right: THREE.Vector3, groundY: number): void {
    const fx = FxManager.get(); if (!fx) return;
    ParticleBurst.casing(fx.additive, pos, right, groundY);
  }

  impactSurface(point: THREE.Vector3, normal: THREE.Vector3, hard: boolean): void {
    const fx = FxManager.get(); if (!fx) return;
    _n.copy(normal); if (_n.lengthSq() < 0.01) _n.copy(_up);
    if (hard) {
      ParticleBurst.sparks(fx.additive, point, _n, 8, 7);
      ParticleBurst.dust(fx.alpha, point, _n, 3, 0.5, 0x777777);
    } else {
      ParticleBurst.dust(fx.alpha, point, _n, 6, 0.7);
      ParticleBurst.sparks(fx.additive, point, _n, 2, 4, 0xffb060);
    }
  }

  impactEnemy(point: THREE.Vector3, dir: THREE.Vector3, heavy = false): void {
    const fx = FxManager.get(); if (!fx) return;
    _n.copy(dir).negate();
    ParticleBurst.ichor(fx.additive, point, _n, heavy ? 22 : 10);
  }

  explosion(pos: THREE.Vector3, radius: number): void {
    const fx = FxManager.get(); if (!fx) return;
    _p.copy(pos); _p.y += 0.3;
    ParticleBurst.fireball(fx.additive, _p, 50, 9, radius * 0.35);
    ParticleBurst.sparks(fx.additive, _p, _up, 45, 16, 0xffc070);
    ParticleBurst.smoke(fx.alpha, _p, 40, radius * 0.4);
    ParticleBurst.groundBlast(fx.alpha, pos, 70, radius * 2.2, 0x7a6a52, 0.3);
    fx.flashes.flash(_p, 0xffa040, 160, radius * 1.3, 0.22, radius * 5);
    // shockwave ring
    const r = this.rings.find((x) => x.life <= 0) ?? this.rings[0];
    r.life = r.maxLife; r.radius = radius * 1.4;
    r.mesh.position.copy(pos); r.mesh.position.y += 0.15;
    r.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const t = 1 - Math.max(0, r.life) / r.maxLife;
      const e = 1 - (1 - t) * (1 - t);
      const s = 0.2 + e * r.radius;
      r.mesh.scale.set(s, s, 1);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.8;
      if (r.life <= 0) r.mesh.visible = false;
    }
    for (const a of this.arcs) {
      if (a.life <= 0) continue;
      a.life -= dt;
      const t = 1 - Math.max(0, a.life) / a.maxLife;
      const s = a.scale * (0.7 + t * 0.5);
      a.mesh.scale.set(s, s, 1);
      (a.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.75;
      if (a.life <= 0) a.mesh.visible = false;
    }
  }

  clear(): void {
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
    for (const a of this.arcs) { a.life = 0; a.mesh.visible = false; }
  }

  dispose(): void {
    this.ringGeo.dispose(); this.ringMat.dispose();
    this.arcGeo.dispose(); this.arcMat.dispose();
    for (const r of this.rings) (r.mesh.material as THREE.Material).dispose();
    for (const a of this.arcs) (a.mesh.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}
