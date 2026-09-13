/**
 * src/world/rover/RoverRoad.ts — 탐사 차량의 **경로 · 흙길 · 정류장 표지 기둥** (owner: R1, 2026-09-13).
 *
 * `WorldSystem.generate` 가 선로(`rails.build`) 바로 뒤 · 재해/소품/상자 앞에서 `build` 를 부르고, 결과 `route` 를 차량
 * (`Rover.build`)에 넘긴다. 매크로 계획(`layout.rover` — 정류장 자리 · 2D 고리)은 `generateLayout` 이 이미 세웠고
 * (`rover/RoadPlan.ts`), 여기서는 지형이 생긴 뒤에야 할 수 있는 일만 한다:
 *   1. 2D 고리를 Catmull-Rom 으로 `ROVER_ROUTE_STEP_M` 간격으로 다시 뽑는다 (정류장 제어점은 곡선 위에 정확히 남는다).
 *   2. 노면 높이 = 지형을 `[1,2,1]/4` 로 `ROVER_ROUTE_SMOOTH_PASSES` 번 편 값, 매번 **지형 아래로는 안 내린다**
 *      (차량이 요철에 떨지 않되 땅에 파묻히지도 않는다). 정류장 부지는 `station` 패드라 지형이 이미 평평하다.
 *   3. 정류장 = 계획의 정류장 점에 가장 가까운 `s`, 순서대로 `rst0…` · `정류장 A…`, 표지 기둥은 맵 바깥쪽 옆.
 *   4. 흙길 그림(`RoadMesh`) · 표지 기둥(`StationMesh`) · 기둥 콜라이더.
 * 계획이 없으면(`layout.rover === null`) `route` 는 null 이고 그 레이드에는 차량이 없다.
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
  /** 세운 경로. `build` 전 · 경로 없음 · `dispose` 뒤에는 null. */
  route: RoverRouteDef | null = null;
  /** 같은 경로의 진행거리 수학 형태 (`makeRoverPath(route.points)` 와 같다). */
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

    /* ── 1 · 2: 다시 뽑기 + 노면 높이 ── */
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

    /* ── 3: 정류장 ── */
    const sList = plan.stations
      .map((p) => {
        const s = wrapRouteS(path, nearestRouteS(path, p.x, p.z));
        return path.total - s < 0.01 ? 0 : s;
      })
      .sort((a, b) => a - b);
    const stations: RoverStationDef[] = sList.map((s, index) => {
      sampleRoute(path, s, this.pos, this.tan);
      let nx = -this.tan.z, nz = this.tan.x;
      if (nx * this.pos.x + nz * this.pos.z < 0) { nx = -nx; nz = -nz; }     // 맵 바깥쪽
      const px = this.pos.x + nx * ROVER_POLE_OFFSET_M, pz = this.pos.z + nz * ROVER_POLE_OFFSET_M;
      return {
        id: `rst${index}`, index, label: `정류장 ${stationLetter(index)}`,
        position: this.pos.clone(), polePosition: new THREE.Vector3(px, terrain.getHeightAt(px, pz), pz), s,
      };
    });
    this.path = path;
    this.route = { points: pts, length: path.total, stations };

    /* ── 4: 그림 · 콜라이더 ── */
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

/** 닫힌 2D 점열을 균일 Catmull-Rom 으로 약 `step` 간격 다시 뽑는다. 제어점(정류장 포함)은 곡선 위에 그대로 남는다. */
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
