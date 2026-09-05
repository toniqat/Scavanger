import * as THREE from 'three';
import {
  IMPLANT_BARRIER_HEIGHT, IMPLANT_BARRIER_HP, IMPLANT_BARRIER_WIDTH, Layers, type PeerId,
} from '@/shared';

/**
 * One deployed energy barrier (배리어 임플란트). Owned by the local player or replicated from a peer's
 * `imp barrier` message. Purely a projectile blocker — it has no physics collider, so players and bugs
 * walk through it; only `intersect()` (via `ImplantsRef.raycastBarrier`) stops hostile fire.
 *
 * The hex surface texture is a shared procedural CanvasTexture (built once, reused by every barrier).
 */

let HEX_TEX: THREE.CanvasTexture | null = null;

function hexTexture(): THREE.CanvasTexture {
  if (HEX_TEX) return HEX_TEX;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const g = c.getContext('2d');
  if (g) {
    g.clearRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 2.5;
    const r = s / 4;
    const drawHex = (cx: number, cy: number): void => {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const x = cx + Math.cos(a) * r * 0.95;
        const y = cy + Math.sin(a) * r * 0.95;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
    };
    const dx = r * 1.7, dy = r * 1.48;
    for (let iy = -1; iy <= 3; iy++) {
      for (let ix = -1; ix <= 3; ix++) drawHex(ix * dx + (iy % 2 ? dx / 2 : 0), iy * dy);
    }
  }
  HEX_TEX = new THREE.CanvasTexture(c);
  HEX_TEX.wrapS = HEX_TEX.wrapT = THREE.RepeatWrapping;
  HEX_TEX.repeat.set(IMPLANT_BARRIER_WIDTH / 2.4, IMPLANT_BARRIER_HEIGHT / 2.4);
  return HEX_TEX;
}

const _n = new THREE.Vector3(), _r = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3();

export class BarrierField {
  /** Feet-level centre of the shield (the panel rises from here). */
  readonly position = new THREE.Vector3();
  yaw = 0;
  hp = IMPLANT_BARRIER_HP;
  readonly maxHp = IMPLANT_BARRIER_HP;
  active = false;

  readonly root = new THREE.Group();
  private readonly surfaceMat: THREE.MeshBasicMaterial;
  private readonly frameMat: THREE.MeshStandardMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];
  private flash = 0;
  private phase = Math.random() * 10;

  constructor(scene: THREE.Scene, color: number, readonly owner: PeerId | 'local') {
    const w = IMPLANT_BARRIER_WIDTH, h = IMPLANT_BARRIER_HEIGHT;
    const surf = new THREE.PlaneGeometry(w, h, 12, 6);
    // gentle forward curve so the shield hugs the deployer
    const pos = surf.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, -((x / (w / 2)) ** 2) * 0.55);
    }
    surf.computeVertexNormals();
    this.geos.push(surf);
    this.surfaceMat = new THREE.MeshBasicMaterial({
      color, map: hexTexture(), transparent: true, opacity: 0.34, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const panel = new THREE.Mesh(surf, this.surfaceMat);
    panel.position.y = h / 2;
    panel.frustumCulled = false;
    this.root.add(panel);

    this.frameMat = new THREE.MeshStandardMaterial({
      color: 0x2a333c, emissive: color, emissiveIntensity: 0.6, roughness: 0.45, metalness: 0.6,
    });
    const post = new THREE.BoxGeometry(0.12, h, 0.12);
    const rail = new THREE.BoxGeometry(w + 0.12, 0.09, 0.12);
    const base = new THREE.CylinderGeometry(0.22, 0.3, 0.16, 10);
    this.geos.push(post, rail, base);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(post, this.frameMat);
      m.position.set(sx * (w / 2), h / 2, -0.55);
      this.root.add(m);
      const b = new THREE.Mesh(base, this.frameMat);
      b.position.set(sx * (w / 2), 0.08, -0.55);
      this.root.add(b);
    }
    const top = new THREE.Mesh(rail, this.frameMat);
    top.position.set(0, h, -0.3);
    this.root.add(top);

    this.root.visible = false;
    this.root.traverse((o) => o.layers.enable(Layers.NO_RAYCAST));
    scene.add(this.root);
  }

  deploy(position: THREE.Vector3, yaw: number, hp = this.hp): void {
    this.position.copy(position);
    this.yaw = yaw;
    this.hp = Math.max(1, Math.min(this.maxHp, hp));
    this.active = true;
    this.root.position.copy(position);
    this.root.rotation.y = yaw;
    this.root.visible = true;
    this.root.scale.set(1, 0.05, 1);   // unfolds in update()
  }

  stow(): void {
    this.active = false;
    this.root.visible = false;
  }

  /** Absorb damage; returns true when the shield collapsed on this hit. */
  damage(amount: number): boolean {
    if (!this.active) return false;
    this.hp -= amount;
    this.flash = 1;
    if (this.hp <= 0) { this.hp = 0; this.stow(); return true; }
    return false;
  }

  /** Replicated durability update from the owner (no visual reset). */
  setHp(hp: number): void {
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    this.flash = 1;
    if (this.hp <= 0) this.stow();
  }

  regen(perSecond: number, dt: number): void {
    if (this.active) return;
    this.hp = Math.min(this.maxHp, this.hp + perSecond * dt);
  }

  update(dt: number): void {
    if (!this.root.visible) return;
    this.phase += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3.5);
    // unfold
    const s = this.root.scale;
    s.y += (1 - s.y) * Math.min(1, dt * 9);
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 0;
    this.surfaceMat.opacity = (0.14 + 0.24 * ratio) * (1 + this.flash * 1.6) + Math.sin(this.phase * 2.2) * 0.02;
    this.frameMat.emissiveIntensity = 0.35 + ratio * 0.7 + this.flash;
    const tex = this.surfaceMat.map;
    if (tex) tex.offset.y = (this.phase * 0.06) % 1;
  }

  /**
   * Segment vs shield panel. Writes the impact point into `out` and returns true when the segment
   * origin→origin+dir*maxDist crosses the panel. Double-sided: a shield stops hostile fire from behind too.
   */
  intersect(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: THREE.Vector3): boolean {
    if (!this.active) return false;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    _n.set(-sy, 0, -cy);          // panel normal (deployer's forward)
    _r.set(cy, 0, -sy);           // panel right
    _c.copy(this.position);       // any point on the panel plane (the normal is horizontal)
    const denom = dir.dot(_n);
    if (Math.abs(denom) < 1e-6) return false;
    _p.subVectors(_c, origin);
    const t = _p.dot(_n) / denom;
    if (t < 0 || t > maxDist) return false;
    out.copy(origin).addScaledVector(dir, t);
    const dx = (out.x - _c.x) * _r.x + (out.z - _c.z) * _r.z;
    if (Math.abs(dx) > IMPLANT_BARRIER_WIDTH / 2) return false;
    const dy = out.y - this.position.y;
    if (dy < 0 || dy > IMPLANT_BARRIER_HEIGHT) return false;
    return true;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    this.surfaceMat.dispose();
    this.frameMat.dispose();
  }
}
