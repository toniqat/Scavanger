import * as THREE from 'three';
import {
  IMPLANT_BARRIER_CARRY_ARC, IMPLANT_BARRIER_CARRY_BASE_Y, IMPLANT_BARRIER_CARRY_HEIGHT,
  IMPLANT_BARRIER_CARRY_OFFSET, IMPLANT_BARRIER_CARRY_WIDTH, IMPLANT_BARRIER_HP, Layers, type PeerId,
} from '@/shared';

/**
 * The 배리어 방패 (Phase 10): an energy shield **carried in the hand**, no longer a wall planted on the ground.
 * Owned by the local player or replicated from a peer (`imp shield` + that peer's snapshot transform).
 *
 * It is purely a projectile blocker — no physics collider, so players and bugs walk through it; only
 * `intersect()` (via `ImplantsRef.raycastBarrier`) stops hostile fire, and only inside the
 * `IMPLANT_BARRIER_CARRY_ARC` half-angle around the carrier's forward (a shot from behind passes by).
 *
 * `position` is the **panel-bottom centre** in world space (`intersect` measures dy from `position.y`), i.e.
 * `feet + forward * IMPLANT_BARRIER_CARRY_OFFSET` lifted by `IMPLANT_BARRIER_CARRY_BASE_Y`; `follow()` writes it
 * every frame. The hex surface texture is a shared procedural CanvasTexture built once for the carry dimensions.
 */

let HEX_TEX: THREE.CanvasTexture | null = null;
/** Metres of panel per hex tile (the shared texture's `repeat` is baked from this + the carry size). */
const HEX_TILE_M = 0.5;
/** Depth of the gentle forward curve at the panel edges (m). */
const CURVE_DEPTH = 0.12;

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
  // Phase 10: baked for the carried panel (every shield is carry-sized now, so one repeat serves them all).
  HEX_TEX.repeat.set(IMPLANT_BARRIER_CARRY_WIDTH / HEX_TILE_M, IMPLANT_BARRIER_CARRY_HEIGHT / HEX_TILE_M);
  return HEX_TEX;
}

const _n = new THREE.Vector3(), _r = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3();
/** cos of the blocking half-angle: a shot must travel into the front face within this cone. */
const ARC_COS = Math.cos(Math.max(0, IMPLANT_BARRIER_CARRY_ARC));

export class BarrierField {
  /** Panel-bottom centre in world space (the panel rises `IMPLANT_BARRIER_CARRY_HEIGHT` from here). */
  readonly position = new THREE.Vector3();
  yaw = 0;
  hp = IMPLANT_BARRIER_HP;
  readonly maxHp = IMPLANT_BARRIER_HP;
  /** true while the shield is **raised in hand** (was: deployed on the ground). */
  active = false;

  readonly root = new THREE.Group();
  private readonly surfaceMat: THREE.MeshBasicMaterial;
  private readonly frameMat: THREE.MeshStandardMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];
  private flash = 0;
  private phase = Math.random() * 10;

  constructor(scene: THREE.Scene, color: number, readonly owner: PeerId | 'local') {
    const w = IMPLANT_BARRIER_CARRY_WIDTH, h = IMPLANT_BARRIER_CARRY_HEIGHT;
    const surf = new THREE.PlaneGeometry(w, h, 10, 6);
    // gentle forward curve so the shield wraps around the carrier
    const pos = surf.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, -((x / (w / 2)) ** 2) * CURVE_DEPTH);
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
    // rim frame: two side posts + top / bottom rails, all hugging the panel (no ground base any more)
    const post = new THREE.BoxGeometry(0.05, h, 0.05);
    const rail = new THREE.BoxGeometry(w + 0.05, 0.05, 0.05);
    this.geos.push(post, rail);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(post, this.frameMat);
      m.position.set(sx * (w / 2), h / 2, -CURVE_DEPTH);
      this.root.add(m);
    }
    for (const sy of [0, 1]) {
      const m = new THREE.Mesh(rail, this.frameMat);
      m.position.set(0, sy * h, -CURVE_DEPTH * 0.5);
      this.root.add(m);
    }

    this.root.visible = false;
    this.root.traverse((o) => o.layers.enable(Layers.NO_RAYCAST));
    scene.add(this.root);
  }

  /** Raise the shield into the hands. `follow()` gives it its transform (same frame, from the carrier). */
  raise(hp = this.hp): void {
    this.hp = Math.max(1, Math.min(this.maxHp, hp));
    this.active = true;
    this.root.visible = true;
    this.root.scale.set(1, 0.15, 1);   // pops open in update()
  }

  /** Lower it (Q again, weapon key, death, phase change). */
  lower(): void {
    this.active = false;
    this.root.visible = false;
  }

  /**
   * Per-frame transform from the carrier: `feet` is their ground position, `yaw` their facing. The panel plane sits
   * `IMPLANT_BARRIER_CARRY_OFFSET` in front of the body axis with its bottom edge `IMPLANT_BARRIER_CARRY_BASE_Y`
   * above the feet.
   */
  follow(feet: THREE.Vector3, yaw: number): void {
    this.yaw = yaw;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    this.position.set(
      feet.x - sy * IMPLANT_BARRIER_CARRY_OFFSET,
      feet.y + IMPLANT_BARRIER_CARRY_BASE_Y,
      feet.z - cy * IMPLANT_BARRIER_CARRY_OFFSET,
    );
    if (!this.active) return;
    this.root.position.copy(this.position);
    this.root.rotation.y = yaw;
  }

  /** Absorb damage; returns true when the shield collapsed on this hit. */
  damage(amount: number): boolean {
    if (!this.active) return false;
    this.hp -= amount;
    this.flash = 1;
    if (this.hp <= 0) { this.hp = 0; this.lower(); return true; }
    return false;
  }

  /** Replicated durability update from the owner (no visual reset). */
  setHp(hp: number): void {
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    this.flash = 1;
    if (this.hp <= 0) this.lower();
  }

  /** Regenerate at `perSecond`. The caller decides *whether* to regenerate (raised / lowered / locked differ). */
  regen(perSecond: number, dt: number): void {
    this.hp = Math.min(this.maxHp, this.hp + perSecond * dt);
  }

  update(dt: number): void {
    if (!this.root.visible) return;
    this.phase += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3.5);
    // pop open
    const s = this.root.scale;
    s.y += (1 - s.y) * Math.min(1, dt * 14);
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 0;
    this.surfaceMat.opacity = (0.14 + 0.24 * ratio) * (1 + this.flash * 1.6) + Math.sin(this.phase * 2.2) * 0.02;
    this.frameMat.emissiveIntensity = 0.35 + ratio * 0.7 + this.flash;
    const tex = this.surfaceMat.map;
    if (tex) tex.offset.y = (this.phase * 0.06) % 1;
  }

  /**
   * Segment vs shield panel. Writes the impact point into `out` and returns true when the segment
   * origin→origin+dir*maxDist crosses the panel **from the front**: the shot must travel into the front face
   * within `IMPLANT_BARRIER_CARRY_ARC` of the carrier's forward, so fire from behind or from a steep flank
   * passes by (Phase 10 — the deployed wall used to be double-sided).
   */
  intersect(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: THREE.Vector3): boolean {
    if (!this.active) return false;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    _n.set(-sy, 0, -cy);          // panel normal (carrier's forward)
    _r.set(cy, 0, -sy);           // panel right
    _c.copy(this.position);       // any point on the panel plane (the normal is horizontal)
    const denom = dir.dot(_n);
    if (Math.abs(denom) < 1e-6) return false;
    // front-facing gate: -dir·n is the cosine between the incoming shot and the front face
    const len = dir.length();
    if (len > 1e-6 && -denom / len <= ARC_COS) return false;
    _p.subVectors(_c, origin);
    const t = _p.dot(_n) / denom;
    if (t < 0 || t > maxDist) return false;
    out.copy(origin).addScaledVector(dir, t);
    const dx = (out.x - _c.x) * _r.x + (out.z - _c.z) * _r.z;
    if (Math.abs(dx) > IMPLANT_BARRIER_CARRY_WIDTH / 2) return false;
    const dy = out.y - this.position.y;
    if (dy < 0 || dy > IMPLANT_BARRIER_CARRY_HEIGHT) return false;
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
