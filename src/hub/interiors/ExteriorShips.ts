import * as THREE from 'three';
import { SHIP_EXTERIOR_SCALE, SHIP_RAMP_END_Z, buildShipModel, type ShipModelId } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes } from './GeoBatch';

export interface ExteriorModel {
  group: THREE.Group;
  /** Engine glow discs (opacity/scale driven by thrust). */
  engines: THREE.Mesh[];
  engineMat: THREE.MeshBasicMaterial;
  setThrust(t: number): void;
  /** Rear ramp: flat down (a parked ship you board) or shut (a ship in flight). Default shut. */
  setRampOpen?(open: boolean): void;
  /**
   * Rear ramp at an arbitrary pitch (rad, + tilts the far end **down**). A ship standing on its gear has its ramp
   * hinge above the deck, so "open" for it is a slope that reaches the floor, not flat.
   */
  setRampPitch?(rad: number): void;
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

/**
 * A member's own ship, seen from outside — **the very dropship that lands in a raid** (2026-09-21, user's decision).
 *
 * Until now this file drew a 9 m wedge of its own while `extraction/Ship.ts` drew a ~14 m "Pelican", so the ship
 * parked in the hangar was not the ship that came down on the pad. Both build from `shared/shipModel.ts` now; this
 * one asks for `'exterior'` detail (no bay, materials shared per model id, everything but the ramp merged per
 * material) because the hangar parks four at once and the cutscene never gets close enough for greebles.
 *
 * The model is drawn at `SHIP_EXTERIOR_SCALE` on an **inner** group, so the caller's `group` stays at scale 1 and
 * the cutscene's `lookAt` / yaw maths are untouched. Nose = −Z, ramp = +Z, exactly like the raid ship.
 */
export function buildPersonalExterior(model?: ShipModelId): ExteriorModel {
  const g = new THREE.Group();
  g.name = 'PersonalShipExterior';
  const inner = new THREE.Group();
  inner.scale.setScalar(SHIP_EXTERIOR_SCALE);
  g.add(inner);
  const build = buildShipModel(inner, { model, detail: 'exterior' });
  // A parked / flying exterior neither casts nor receives the sun's shadow (the deck it stands on is interior
  // geometry lit by the hangar's own fixtures) — the same call the merged wedge made before.
  inner.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.receiveShadow = false; } });

  // Additive glow discs **under** the nacelles — this hull is a VTOL: its nacelles stand upright and exhaust
  // downward (the plumes at `enginePoints` point −Y), so a disc behind the tail would glow at nothing.
  const engineMat = M.engine.clone();
  const engines: THREE.Mesh[] = [];
  for (const p of build.enginePoints) {
    const e = new THREE.Mesh(new THREE.CircleGeometry(0.9, 20), engineMat);
    e.position.copy(p);
    e.rotation.x = Math.PI / 2;      // CircleGeometry faces +Z; +π/2 about X turns it to face −Y
    engines.push(e); inner.add(e);
  }

  return {
    group: g, engines, engineMat,
    setThrust(t: number) {
      const k = THREE.MathUtils.clamp(t, 0, 1);
      engineMat.opacity = 0.25 + 0.7 * k;
      for (const e of engines) e.scale.setScalar(0.6 + 0.6 * k);
      for (const m of build.thrustMats) m.opacity = 0.15 + k * 0.7;
      for (const c of build.thrustCones) c.scale.set(0.6 + k * 0.5, 0.5 + k * 1.1, 0.6 + k * 0.5);
    },
    setRampOpen(open: boolean) { build.ramp.rotation.x = open ? 0 : -Math.PI / 2; },
    setRampPitch(rad: number) { build.ramp.rotation.x = rad; },
    dispose() {
      build.dispose();
      for (const e of engines) { e.geometry.dispose(); e.removeFromParent(); }
      engineMat.dispose();
      inner.removeFromParent();
      g.removeFromParent();
    },
  };
}

/** Local z the open ramp's far edge reaches, at hangar / cutscene scale (where a bay's boarding spot goes). */
export const EXTERIOR_RAMP_END_Z = SHIP_RAMP_END_Z * SHIP_EXTERIOR_SCALE;

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
