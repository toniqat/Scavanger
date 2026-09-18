/**
 * src/world/rover/RoverRoad.ts — the rover's **route · dirt road · station sign poles** (owner: R1, 2026-09-13).
 *
 * `WorldSystem.generate` calls `build` right after the rail (`rails.build`) and before hazards / props / crates, and
 * hands the resulting `route` to the vehicle (`Rover.build`). The macro plan (`layout.rover` — the station spots and
 * the 2D loop) was already made by `generateLayout` (`rover/RoadPlan.ts`); only what needs terrain happens here:
 *   1. The 2D loop is resampled by Catmull-Rom at `ROVER_ROUTE_STEP_M` spacing (the station control points stay exactly on the curve).
 *   2. The road surface height = the terrain smoothed `ROVER_ROUTE_SMOOTH_PASSES` times with `[1,2,1]/4`, **never lowered
 *      below the terrain** on any pass (no shaking over bumps, no sinking into the ground). A station site is a `station` pad, so its terrain is already flat.
 *   3. A station = the `s` nearest the plan's station point, in order `rst0…` · `정류장 A…`, the sign pole to the outward side.
 *   4. The dirt road drawing (`RoadMesh`) · the sign poles (`StationMesh`) · the pole colliders.
 * With no plan (`layout.rover === null`) `route` is null and that raid has no vehicle.
 */
import * as THREE from 'three';
import {
  Layers, ROVER_POLE_OFFSET_M, ROVER_ROUTE_SMOOTH_PASSES, ROVER_ROUTE_STEP_M,
  type GameContext, type RoverRouteDef, type RoverStationDef,
} from '@/shared';
import type { BuildCtx } from '../build';
import { makeRoverPath, nearestRouteS, sampleRoute, wrapRouteS, type RoverPath } from './model';
import { buildRoadGeometry } from './RoadMesh';
import { buildStationGeometry, stationLetter } from './StationMesh';

export class RoverRoad {
  /** The route that was built. Null before `build`, with no route, and after `dispose`. */
  route: RoverRouteDef | null = null;
  /** The same route in its arc-position math form (identical to `makeRoverPath(route.points)`). */
  path: RoverPath | null = null;
  private group: THREE.Group | null = null;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly texs: THREE.Texture[] = [];
  private readonly pos = new THREE.Vector3();
  private readonly tan = new THREE.Vector3();

  build(bctx: BuildCtx, _ctx: GameContext): void {
    this.dispose();
    const plan = bctx.layout.rover;
    if (!plan || plan.points.length < 4 || plan.stations.length < 2) {
      console.info('[RoverRoad] 탐사 차량 경로 없음 — 이번 레이드에는 차량이 없다');
      return;
    }
    const terrain = bctx.terrain;

    /* ── 1 · 2: resample + road surface height ── */
    const xz = resampleLoop(plan.points, Math.max(1, ROVER_ROUTE_STEP_M));
    const M = xz.length;
    const ground = new Float32Array(M);
    for (let i = 0; i < M; i++) ground[i] = terrain.getHeightAt(xz[i].x, xz[i].z);
    const ys = Float32Array.from(ground);
    const tmp = new Float32Array(M);
    for (let pass = 0; pass < Math.max(0, ROVER_ROUTE_SMOOTH_PASSES); pass++) {
      for (let i = 0; i < M; i++) tmp[i] = (ys[(i - 1 + M) % M] + 2 * ys[i] + ys[(i + 1) % M]) / 4;
      for (let i = 0; i < M; i++) ys[i] = Math.max(tmp[i], ground[i]);
    }
    const pts = xz.map((p, i) => new THREE.Vector3(p.x, ys[i], p.z));
    const path = makeRoverPath(pts);

    /* ── 3: stations ── */
    const sList = plan.stations
      .map((p) => {
        const s = wrapRouteS(path, nearestRouteS(path, p.x, p.z));
        return path.total - s < 0.01 ? 0 : s;
      })
      .sort((a, b) => a - b);
    const stations: RoverStationDef[] = sList.map((s, index) => {
      sampleRoute(path, s, this.pos, this.tan);
      let nx = -this.tan.z, nz = this.tan.x;
      if (nx * this.pos.x + nz * this.pos.z < 0) { nx = -nx; nz = -nz; }     // outwards from the map
      const px = this.pos.x + nx * ROVER_POLE_OFFSET_M, pz = this.pos.z + nz * ROVER_POLE_OFFSET_M;
      return {
        id: `rst${index}`, index, label: `정류장 ${stationLetter(index)}`,
        position: this.pos.clone(), polePosition: new THREE.Vector3(px, terrain.getHeightAt(px, pz), pz), s,
      };
    });
    this.path = path;
    this.route = { points: pts, length: path.total, stations };

    /* ── 4: drawing · colliders ── */
    const group = new THREE.Group();
    group.name = 'rover_road';
    this.group = group;

    const roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    const roadGeo = buildRoadGeometry(terrain, pts, stations, bctx.biome);
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.name = 'rover_road_surface';
    road.receiveShadow = true;
    group.add(road);
    this.mats.push(roadMat);
    this.geos.push(roadGeo);

    const sb = buildStationGeometry(bctx, stations);
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.5 });
    const glowMat = new THREE.MeshStandardMaterial({ color: 0x1a1206, emissive: 0xffb43a, emissiveIntensity: 2.2, roughness: 0.4 });
    const signMat = new THREE.MeshStandardMaterial({
      map: sb.tex, emissiveMap: sb.tex, emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.75, metalness: 0.05,
    });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, cast: boolean): void => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.layers.enable(Layers.PROP);
      group.add(mesh);
      this.geos.push(geo);
    };
    add(sb.body, bodyMat, 'rover_station_body', true);
    add(sb.glow, glowMat, 'rover_station_beacon', false);
    add(sb.signs, signMat, 'rover_station_signs', false);
    this.mats.push(bodyMat, glowMat, signMat);
    this.texs.push(sb.tex);

    bctx.root.add(group);
  }

  dispose(): void {
    this.group?.removeFromParent();
    this.group = null;
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.geos.length = 0;
    this.mats.length = 0;
    this.texs.length = 0;
    this.route = null;
    this.path = null;
  }
}

/** Resamples a closed 2D point list by uniform Catmull-Rom at roughly `step` spacing. The control points (stations included) stay on the curve. */
function resampleLoop(src: readonly { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const n = src.length;
  const out: { x: number; z: number }[] = [];
  const cr = (a: number, b: number, c: number, d: number, u: number): number =>
    0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  for (let i = 0; i < n; i++) {
    const p0 = src[(i - 1 + n) % n], p1 = src[i], p2 = src[(i + 1) % n], p3 = src[(i + 2) % n];
    const m = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let j = 0; j < m; j++) {
      const u = j / m;
      out.push({ x: cr(p0.x, p1.x, p2.x, p3.x, u), z: cr(p0.z, p1.z, p2.z, p3.z, u) });
    }
  }
  return out;
}
