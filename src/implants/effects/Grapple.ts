import * as THREE from 'three';
import { Layers } from '@/shared';
import type { BeamMesh, ImplantFx } from '../fx/ImplantFx';

/**
 * Visual for one grapple wire: an additive line from the launcher muzzle to the anchor plus a small
 * harpoon head that sticks into the surface. Used for the local player and for remote casters alike.
 */
export class GrappleWire {
  private readonly beam: BeamMesh;
  private readonly hook: THREE.Mesh;
  private readonly hookGeo: THREE.ConeGeometry;
  private readonly hookMat: THREE.MeshStandardMaterial;
  private phase = 0;

  constructor(scene: THREE.Scene, fx: ImplantFx, color: number) {
    this.beam = fx.makeBeam(color, 0.85, 0.022);
    this.hookGeo = new THREE.ConeGeometry(0.07, 0.22, 7);
    this.hookMat = new THREE.MeshStandardMaterial({ color: 0x323a42, emissive: color, emissiveIntensity: 0.8, roughness: 0.5, metalness: 0.7 });
    this.hook = new THREE.Mesh(this.hookGeo, this.hookMat);
    this.hook.visible = false;
    this.hook.layers.enable(Layers.NO_RAYCAST);
    scene.add(this.hook);
  }

  /** Draw the wire. `anchored` shows the harpoon head at `to`. */
  set(from: THREE.Vector3, to: THREE.Vector3, anchored: boolean): void {
    this.beam.setFromTo(from, to, 1 + Math.sin(this.phase * 12) * 0.12);
    this.hook.visible = anchored;
    if (anchored) this.hook.position.copy(to);
  }

  hide(): void {
    this.beam.hide();
    this.hook.visible = false;
  }

  update(dt: number): void {
    this.phase += dt;
    this.hook.rotation.y += dt * 1.6;
  }

  dispose(): void {
    this.beam.dispose();
    this.hook.removeFromParent();
    this.hookGeo.dispose();
    this.hookMat.dispose();
  }
}
