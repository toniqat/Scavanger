import * as THREE from 'three';
import { Layers, buffLineClear, type GameContext, type RemotePlayerRef } from '@/shared';
import type { BeamMesh, ImplantFx } from '../fx/ImplantFx';

/** Cone half-angle (cos) the ally must be inside to be locked on. */
const LOCK_COS = Math.cos(0.42);   // ~24°
/** Chest height above the feet position. */
const CHEST_Y = 1.15;

const _to = new THREE.Vector3();
const _from = new THREE.Vector3();
const _chest = new THREE.Vector3();

/** World point the beam should latch onto for a remote ally. */
export function allyPoint(ref: RemotePlayerRef, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(ref.position).setY(ref.position.y + CHEST_Y);
}

/**
 * Best friendly target for the overcharge beam: the living, connected squadmate closest to the aim ray
 * inside `range`. Returns null in single-player (the beam then falls back to the caster).
 */
export function findAlly(ctx: GameContext, origin: THREE.Vector3, dir: THREE.Vector3, range: number): RemotePlayerRef | null {
  const net = ctx.net;
  if (!net) return null;
  let best: RemotePlayerRef | null = null;
  let bestDot = LOCK_COS;
  const me = ctx.player;
  if (me) _from.copy(me.position).setY(me.position.y + CHEST_Y);
  for (const r of net.getRemotePlayers()) {
    if (!r.connected || r.stale || r.isDead) continue;
    allyPoint(r, _to).sub(origin);
    const d = _to.length();
    if (d < 0.2 || d > range) continue;
    _to.divideScalar(d);
    const dot = _to.dot(dir);
    if (dot <= bestDot) continue;
    // 2026-09-11 (E-4): 벽 · 지형 뒤의 분대원은 잡지 않는다 — 내 가슴 → 그 가슴이 트여 있어야 한다 (`shared/buffLineClear`)
    if (me && !buffLineClear(ctx.world, _from, allyPoint(r, _chest))) continue;
    bestDot = dot; best = r;
  }
  return best;
}

/** Twin-strand energy beam with a soft impact disc at the far end. */
export class OverchargeBeam {
  private readonly core: BeamMesh;
  private readonly halo: BeamMesh;
  private readonly disc: THREE.Mesh;
  private readonly discGeo: THREE.CircleGeometry;
  private readonly discMat: THREE.MeshBasicMaterial;
  private phase = 0;

  constructor(scene: THREE.Scene, fx: ImplantFx, private readonly healColor: number, private readonly boostColor: number) {
    this.core = fx.makeBeam(healColor, 0.9, 0.035);
    this.halo = fx.makeBeam(healColor, 0.25, 0.1);
    this.discGeo = new THREE.CircleGeometry(0.5, 20);
    this.discMat = new THREE.MeshBasicMaterial({
      color: healColor, transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    this.disc = new THREE.Mesh(this.discGeo, this.discMat);
    this.disc.visible = false;
    this.disc.layers.enable(Layers.NO_RAYCAST);
    scene.add(this.disc);
  }

  set(from: THREE.Vector3, to: THREE.Vector3, mode: 'heal' | 'boost', camera: THREE.Camera): void {
    const color = mode === 'heal' ? this.healColor : this.boostColor;
    const wobble = 1 + Math.sin(this.phase * 18) * 0.25;
    this.core.setColor(color); this.halo.setColor(color); this.discMat.color.setHex(color);
    this.core.setFromTo(from, to, wobble);
    this.halo.setFromTo(from, to, 1 / wobble);
    this.core.setOpacity(0.75 + Math.sin(this.phase * 22) * 0.2);
    this.disc.visible = true;
    this.disc.position.copy(to);
    this.disc.lookAt(camera.position);
    this.disc.scale.setScalar(0.7 + Math.sin(this.phase * 9) * 0.12);
    this.discMat.opacity = 0.35 + Math.sin(this.phase * 13) * 0.12;
  }

  hide(): void {
    this.core.hide(); this.halo.hide(); this.disc.visible = false;
  }

  update(dt: number): void { this.phase += dt; }

  dispose(): void {
    this.core.dispose(); this.halo.dispose();
    this.disc.removeFromParent();
    this.discGeo.dispose(); this.discMat.dispose();
  }
}
