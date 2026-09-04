import * as THREE from 'three';
import type { ParticlePool } from './ParticlePool';

/**
 * Preset particle bursts. All functions take the pool to spawn into so callers can pick
 * additive (sparks, fire) or alpha (dust, smoke) pools via FxManager.
 */
const _n = new THREE.Vector3();

function hex(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

export const ParticleBurst = {
  /** Hot metal sparks flying away from a surface normal. */
  sparks(pool: ParticlePool, pos: THREE.Vector3, normal: THREE.Vector3, count = 10, speed = 6, color = 0xffc866): void {
    const [r, g, b] = hex(color);
    for (let i = 0; i < count; i++) {
      _n.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      _n.addScaledVector(normal, 1.2).normalize();
      const s = speed * (0.4 + Math.random() * 0.9);
      pool.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: _n.x * s, vy: _n.y * s, vz: _n.z * s,
        life: 0.15 + Math.random() * 0.35, size: 0.05 + Math.random() * 0.05, sizeEnd: 0.2,
        r, g, b, rEnd: 1, gEnd: 0.25, bEnd: 0.05,
        gravity: 14, drag: 1.5, alpha: 1,
      });
    }
  },

  /** Dust/dirt puff (alpha pool). */
  dust(pool: ParticlePool, pos: THREE.Vector3, normal: THREE.Vector3, count = 8, scale = 1, color = 0x9a8a72): void {
    const [r, g, b] = hex(color);
    for (let i = 0; i < count; i++) {
      _n.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize();
      _n.addScaledVector(normal, 0.9).normalize();
      const s = (1.5 + Math.random() * 2.5) * scale;
      pool.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: _n.x * s, vy: _n.y * s, vz: _n.z * s,
        life: 0.5 + Math.random() * 0.6, size: (0.25 + Math.random() * 0.3) * scale, sizeEnd: 2.6,
        r, g, b, rEnd: r * 0.7, gEnd: g * 0.7, bEnd: b * 0.7,
        gravity: 1.2, drag: 3.5, alpha: 0.55,
      });
    }
  },

  /** Big ground impact ring (hellpod landing, explosions). */
  groundBlast(pool: ParticlePool, pos: THREE.Vector3, count = 60, radiusSpeed = 12, color = 0x8f7f66, height = 0.4): void {
    const [r, g, b] = hex(color);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = radiusSpeed * (0.5 + Math.random() * 0.7);
      pool.spawn({
        x: pos.x + Math.cos(a) * 0.5, y: pos.y + height * Math.random(), z: pos.z + Math.sin(a) * 0.5,
        vx: Math.cos(a) * s, vy: 1.5 + Math.random() * 4, vz: Math.sin(a) * s,
        life: 1.0 + Math.random() * 1.2, size: 0.45 + Math.random() * 0.45, sizeEnd: 2.6,
        r, g, b, rEnd: r * 0.8, gEnd: g * 0.8, bEnd: b * 0.8,
        gravity: 2.5, drag: 2.2, alpha: 0.6, groundY: pos.y,
      });
    }
  },

  /** Fireball core (additive) — expanding hot puffs. */
  fireball(pool: ParticlePool, pos: THREE.Vector3, count = 40, speed = 7, radius = 1): void {
    for (let i = 0; i < count; i++) {
      _n.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      const s = speed * (0.3 + Math.random());
      const hot = Math.random();
      pool.spawn({
        x: pos.x + _n.x * radius * 0.3, y: pos.y + _n.y * radius * 0.3, z: pos.z + _n.z * radius * 0.3,
        vx: _n.x * s, vy: _n.y * s + 2, vz: _n.z * s,
        life: 0.25 + Math.random() * 0.45, size: (0.6 + Math.random() * 0.9) * radius, sizeEnd: 2.2,
        r: 1, g: 0.85 + hot * 0.15, b: 0.5 + hot * 0.4, rEnd: 1, gEnd: 0.3, bEnd: 0.02,
        gravity: -3, drag: 3, alpha: 0.9,
      });
    }
  },

  /** Dark smoke column (alpha). */
  smoke(pool: ParticlePool, pos: THREE.Vector3, count = 20, radius = 1, color = 0x2a2622): void {
    const [r, g, b] = hex(color);
    for (let i = 0; i < count; i++) {
      _n.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize();
      const s = 2 + Math.random() * 4;
      pool.spawn({
        x: pos.x + _n.x * radius * 0.4, y: pos.y + Math.random() * 0.5, z: pos.z + _n.z * radius * 0.4,
        vx: _n.x * s, vy: _n.y * s + 1.5, vz: _n.z * s,
        life: 1.2 + Math.random() * 1.6, size: (0.8 + Math.random()) * radius, sizeEnd: 3,
        r, g, b, rEnd: r * 1.6, gEnd: g * 1.6, bEnd: b * 1.6,
        gravity: -0.8, drag: 1.6, alpha: 0.55,
      });
    }
  },

  /** Flesh/ichor hit (bugs): greenish-yellow droplets. */
  ichor(pool: ParticlePool, pos: THREE.Vector3, dir: THREE.Vector3, count = 12, color = 0xb8d43a): void {
    const [r, g, b] = hex(color);
    for (let i = 0; i < count; i++) {
      _n.set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize();
      _n.addScaledVector(dir, 0.8).normalize();
      const s = 3 + Math.random() * 5;
      pool.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: _n.x * s, vy: _n.y * s + 1, vz: _n.z * s,
        life: 0.3 + Math.random() * 0.4, size: 0.08 + Math.random() * 0.12, sizeEnd: 0.6,
        r, g, b, rEnd: r * 0.5, gEnd: g * 0.5, bEnd: b * 0.4,
        gravity: 16, drag: 0.8, alpha: 0.95,
      });
    }
  },

  /** Rocket/thruster trail sample (call every frame while falling). */
  thruster(pool: ParticlePool, pos: THREE.Vector3, vel: THREE.Vector3, count = 3, size = 1.2): void {
    for (let i = 0; i < count; i++) {
      _n.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2.5);
      pool.spawn({
        x: pos.x + _n.x * 0.15, y: pos.y, z: pos.z + _n.z * 0.15,
        vx: _n.x - vel.x * 0.05, vy: -vel.y * 0.15 + _n.y, vz: _n.z - vel.z * 0.05,
        life: 0.25 + Math.random() * 0.3, size: size * (0.6 + Math.random() * 0.6), sizeEnd: 2.5,
        r: 1, g: 0.75, b: 0.35, rEnd: 1, gEnd: 0.2, bEnd: 0.02,
        gravity: -6, drag: 2, alpha: 0.85,
      });
    }
  },

  /** Shell casing-ish tiny brass glints ejected sideways (additive). */
  casing(pool: ParticlePool, pos: THREE.Vector3, right: THREE.Vector3, groundY: number): void {
    pool.spawn({
      x: pos.x, y: pos.y, z: pos.z,
      vx: right.x * (1.5 + Math.random()) + (Math.random() - 0.5), vy: 2.2 + Math.random() * 1.2, vz: right.z * (1.5 + Math.random()) + (Math.random() - 0.5),
      life: 0.9, size: 0.035, sizeEnd: 1,
      r: 0.9, g: 0.7, b: 0.3, gravity: 18, drag: 0.2, alpha: 1, groundY,
    });
  },
};
