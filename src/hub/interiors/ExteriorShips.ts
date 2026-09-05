import * as THREE from 'three';
import { GeoBatch, HUB_MATS as M, disposeMeshes } from './GeoBatch';

export interface ExteriorModel {
  group: THREE.Group;
  /** Engine glow discs (opacity/scale driven by thrust). */
  engines: THREE.Mesh[];
  engineMat: THREE.MeshBasicMaterial;
  setThrust(t: number): void;
  dispose(): void;
}

function finish(group: THREE.Group, meshes: THREE.Mesh[], engines: THREE.Mesh[], engineMat: THREE.MeshBasicMaterial, extra: Array<THREE.BufferGeometry | THREE.Material>): ExteriorModel {
  return {
    group, engines, engineMat,
    setThrust(t: number) {
      const k = THREE.MathUtils.clamp(t, 0, 1);
      engineMat.opacity = 0.25 + 0.7 * k;
      for (const e of engines) e.scale.setScalar(0.6 + 0.6 * k);
    },
    dispose() {
      disposeMeshes(meshes);
      for (const e of engines) { e.geometry.dispose(); e.removeFromParent(); }
      engineMat.dispose();
      for (const d of extra) d.dispose();
      group.removeFromParent();
    },
  };
}

/** Compact personal ship (~9 m, nose = −Z). Low-poly wedge hull, canopy, two nacelles with additive engine discs. */
export function buildPersonalExterior(): ExteriorModel {
  const g = new THREE.Group();
  g.name = 'PersonalShipExterior';
  const b = new GeoBatch();
  // hull
  b.box(2.4, 1.3, 5.0, 0, 0, 0.6, M.hull);
  b.cyl(0.35, 1.25, 3.2, 4, 0, 0.05, -3.1, M.hullLight, -Math.PI / 2, Math.PI / 4);    // tapered nose (4-sided)
  b.box(2.0, 0.5, 1.2, 0, 0.75, -0.6, M.glassDark);                                   // canopy
  b.box(1.6, 0.35, 2.2, 0, -0.75, 0.8, M.hullDark);                                    // belly
  b.box(2.6, 0.3, 1.6, 0, -0.45, 2.7, M.hullDark);                                     // tail block
  // wings + fins
  b.box(6.5, 0.14, 2.0, 0, -0.2, 1.4, M.hull);
  b.box(6.6, 0.05, 0.12, 0, -0.1, 0.45, M.trim);
  b.box(0.12, 1.3, 1.4, 0, 1.2, 2.4, M.hullLight);
  // nacelles
  for (const x of [-2.4, 2.4]) {
    b.cyl(0.5, 0.55, 3.0, 12, x, -0.1, 1.6, M.hullLight, Math.PI / 2);
    b.cyl(0.6, 0.6, 0.3, 12, x, -0.1, 3.05, M.gunmetal, Math.PI / 2);
    b.box(0.3, 0.06, 0.06, x, 0.5, 0.2, M.stripRed);
  }
  b.box(0.08, 0.08, 0.3, -3.2, -0.15, 1.4, M.stripRed);
  b.box(0.08, 0.08, 0.3, 3.2, -0.15, 1.4, M.stripCyan);
  const meshes: THREE.Mesh[] = [];
  b.build(g, meshes, false, false);

  const engineMat = M.engine.clone();
  const engines: THREE.Mesh[] = [];
  for (const x of [-2.4, 2.4]) {
    const e = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), engineMat);
    e.position.set(x, -0.1, 3.22);
    engines.push(e); g.add(e);
  }
  return finish(g, meshes, engines, engineMat, []);
}

/**
 * Large shared ship (~80 m, nose = −Z). Boxy spine, bridge tower, side hangar with an emissive-lined bay mouth on +X
 * at local (16, 0, 4) — the docking target — and four big engines aft.
 */
export function buildSharedExterior(): ExteriorModel {
  const g = new THREE.Group();
  g.name = 'SharedShipExterior';
  const b = new GeoBatch();
  b.box(14, 9, 62, 0, 0, 0, M.hull);                          // spine
  b.cyl(2.5, 7.5, 14, 4, 0, 0, -38, M.hullLight, -Math.PI / 2, Math.PI / 4);   // bow
  b.box(10, 2.2, 48, 0, 5.4, 3, M.hullDark);                   // dorsal ridge
  b.box(7, 5, 9, 0, 8.6, -12, M.hullLight);                    // bridge tower
  b.box(6.4, 1.2, 2.5, 0, 9.2, -16.6, M.glassDark);            // bridge glass
  b.box(0.3, 6, 0.3, 0, 14, -10, M.hullLight);                 // mast
  b.box(0.6, 0.2, 0.6, 0, 17.1, -10, M.stripRed);
  // side hangar (+X) with bay opening facing +X
  b.box(10, 7, 24, 11, 0, 4, M.hull);
  b.box(0.6, 5.0, 12, 16.1, 0, 4, M.hullDark);                 // bay back plate (dark mouth)
  b.box(0.3, 0.25, 12.6, 16.2, 2.65, 4, M.stripAmber);         // bay mouth outline
  b.box(0.3, 0.25, 12.6, 16.2, -2.65, 4, M.stripAmber);
  b.box(0.3, 5.3, 0.25, 16.2, 0, -2.3, M.stripAmber);
  b.box(0.3, 5.3, 0.25, 16.2, 0, 10.3, M.stripAmber);
  // port-side pods / greebles
  b.box(6, 5, 18, -9.5, -0.5, 6, M.hullDark);
  for (let i = 0; i < 6; i++) b.box(0.4, 0.4, 3.0, -12.6, 1.5, -12 + i * 6, M.stripCyan);
  for (let i = 0; i < 9; i++) b.box(14.2, 0.12, 0.12, 0, 4.56, -26 + i * 6, M.trimDark);   // panel lines
  b.box(0.3, 0.3, 40, 7.1, 2.0, -4, M.trim);
  b.box(0.3, 0.3, 40, -7.1, 2.0, -4, M.trim);
  // engines
  for (const [x, y] of [[-4.5, 2.2], [4.5, 2.2], [-4.5, -2.2], [4.5, -2.2]] as Array<[number, number]>) {
    b.cyl(2.0, 2.4, 8, 14, x, y, 32, M.gunmetal, Math.PI / 2);
    b.cyl(2.5, 2.5, 0.8, 14, x, y, 35.5, M.hullDark, Math.PI / 2);
  }
  const meshes: THREE.Mesh[] = [];
  b.build(g, meshes, false, false);

  const engineMat = M.engine.clone();
  engineMat.color.setHex(0x9fd0ff);
  const engines: THREE.Mesh[] = [];
  for (const [x, y] of [[-4.5, 2.2], [4.5, 2.2], [-4.5, -2.2], [4.5, -2.2]] as Array<[number, number]>) {
    const e = new THREE.Mesh(new THREE.CircleGeometry(2.1, 24), engineMat);
    e.position.set(x, y, 36);
    engines.push(e); g.add(e);
  }
  // bay interior glow
  const bayLight = new THREE.PointLight(0xffb347, 60, 40, 2);
  bayLight.position.set(15, 0, 4);
  g.add(bayLight);
  return finish(g, meshes, engines, engineMat, []);
}
