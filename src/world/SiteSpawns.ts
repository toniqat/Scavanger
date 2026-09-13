/**
 * src/world/SiteSpawns.ts — **거점 스폰 자리** (2026-09-13, `WorldRef.getSiteSpawnPoints` · `getRuinSites`).
 *
 * 행성 threat 별 인간형 팩션(안드로이드 · 로그 · 레이더)이 구조물 · 선로 플랫폼 · 폐허 전초를 점거한다. 어느 팩션이
 * 몇 그룹 서는지는 `enemies/` 가 정하고, 여기서는 **어디에 설 수 있는가**만 답한다 — 호스트가 `world:ready` 에서
 * 거점마다 몇 번 부른다 (프레임 비용 없음).
 *
 * 규칙 두 가지:
 *  - **시드 결정적**: 같은 맵 + 같은 인자 = 같은 자리. rng 는 `new Random(seed ^ Random.hash(siteId + place))` 하나이고
 *    월드 생성 rng 는 한 칸도 쓰지 않는다 (맵 배치가 밀리지 않는다).
 *  - **진짜 월드 질의로 거른다** — 추측한 사각형이 아니라 `getSurfaceY`(발 먼저) → `resolveCollision`(밀리면 탈락) →
 *    위로 쏜 `raycast`(머리 위 여유) 순서다. `player/PlayerController` · `scripts/smoke-structure-reach` 와 같은 순서라
 *    사람이 설 수 있는 칸만 남는다.
 *
 * 실내(`indoor`):
 *  - **구조물**: 정문 안쪽 한 걸음(`StructureNav.doorIn`)에서 몸 반지름 flood fill(`BODY_R`, `FILL_STEP` 격자, 건물 발자국 밖으로
 *    나가지 않는다)을 돌려 **걸어서 닿는 칸**만 모은다 — 그래서 옥상(사다리) · 잠긴 방(문짝) · 벽 속은 애초에 안 들어온다.
 *    그 칸 중 층 바닥 높이(`nav.levels[k]`)에 서 있고, 바깥벽 안쪽 면 안이며, 몸 둘레 여덟 점이 전부 같은 바닥이고(계단 구멍 ·
 *    지하 계단 구멍 가장자리 탈락), 몸 밑에 경사 콜라이더(계단)가 없고, 머리 위가 비어 있는 칸이 후보다. 지하실은 층 높이가
 *    아니라서 빠진다. 잠긴 방 사각형(`nav.locked`)은 문이 열린 뒤에 계산돼도 빠지도록 한 번 더 뺀다.
 *    불시착 함선도 같은 식이다 (층 하나, 발자국 = 동체). 걸어 들어갈 수 없으면 빈 배열.
 *    flood fill 은 무거우니 **거점마다 처음 물을 때 한 번** 계산해 레이드 내내 캐시한다 (`reset` 이 비운다).
 *  - **선로 플랫폼**: 데크 사각형 안 (`structures.csv` 의 `rail_platform` 반길이), 데크 윗면 높이에 서고 몸이 데크 밖으로 걸치지
 *    않는 칸. 계단 · 호출 콘솔 · 컨테이너는 충돌로 빠진다.
 *  - **폐허 전초**: 바닥판 사각형 안 벽 원기둥 줄 안쪽, 충돌 없는 칸.
 *
 * 실외(`outdoor`): 발자국 사각형 바깥 `OUT_NEAR`~`OUT_FAR` m 띠를 시드 rng 로 훑는다 — 맵 안(`PLAY_LIMIT`) · 선로 회랑 밖
 * (`railClearance`) · 완만한 땅 · 장애물이 드문 자리(`obstacleCoverage`) · 충돌 없음 · 다른 구조물 / 플랫폼 / 폐허 바닥판 /
 * 탈출 착륙장 / 둥지 패드 밖 · 땅 위(지형에서 거의 뜨지 않은 표면).
 *
 * 고르기(`pickClustered`): 후보를 시드로 섞고 `count` 를 네 개 안팎의 **무리**로 나눈다 — 첫 무리의 기준점은 섞인 순서의 첫 후보
 * (배열 맨 앞), 다음 기준점은 앞 기준점들에서 **가장 먼** 후보, 무리 안은 기준점에서 **가까운 순서**로 `minGap` 을 지키며 채운다.
 * 스폰 감독이 한 자리(place)의 그룹 인원 합보다 넉넉히 받아 첫 자리 · 가장 먼 자리를 앵커로 떼어 가므로, 그룹은 뭉치고 그룹끼리는
 * 흩어진다. 간격은 3D 거리라 다른 층은 멀다.
 *
 * ⚠ 여기 적힌 거리(몸 반지름 · 띠 폭 · 격자)는 **배치 기하**이고 밸런스 수치가 아니다 (`structures/model` 의 건물 치수와 같은 부류).
 */
import * as THREE from 'three';
import {
  Random,
  type RailPlatformDef, type SiteSpawnPlace, type StructureDef, type TerrainHit,
} from '@/shared';
import { PLAY_LIMIT } from './build';
import { railClearance, type WorldLayout } from './layout';
import { hullAreaCentroid } from './hull';
import { boxContainsXZ } from './obb';
import type { OutpostSite } from './Outposts';
import { PLATFORM_RADIUS } from './Pads';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import type { StructureNav } from './structures/parts/Build';
import { FLOOR_OVERHANG, WALL_T, structureRow } from './structures/model';

/** 몸 반지름(m) — 사람 몸(`PLAYER_RADIUS`)과 같은 0.45. 인간형 적(0.4)이 여유 있게 선다. */
const BODY_R = 0.45;
/** 머리 위로 비어 있어야 하는 높이(m) — 인간형 키 1.8 + 한 뼘. */
const HEADROOM = 1.9;
/** flood fill 격자(m) — `smoke-structure-reach` 와 같다 (0.8 m 틈을 구분하는 크기). */
const FILL_STEP = 0.3;
/** flood fill 칸 수 상한 (건물 한 채 = 수천 칸). */
const FILL_CAP = 60000;
/** 실내 후보 격자 = flood fill 칸의 `CAND_EVERY` 칸마다 하나 (0.6 m). */
const CAND_EVERY = 2;
/** 층 바닥 높이로 인정하는 오차(m). */
const LEVEL_TOL = 0.05;
/** 한 걸음 밀려난 것으로 보는 거리(m). */
const PUSH_TOL = 0.02;
/** 실외 띠: 발자국 사각형 바깥 거리(m). */
const OUT_NEAR = 3;
const OUT_FAR = 14;
/** 실외 후보를 찾는 시도 횟수 · 모아 둘 후보 수. */
const OUT_ATTEMPTS = 700;
const OUT_POOL_MIN = 28;
/** 실외 자리: 최대 지형 경사 · 반경 `OUT_COVER_R` 안 장애물 면적 비율 상한 · 지형 위로 뜬 표면 상한(m). */
const OUT_MAX_SLOPE = 0.4;
const OUT_COVER_R = 1.6;
const OUT_MAX_COVER = 0.12;
const OUT_MAX_LIFT = 0.35;
/** 실외 자리의 여유 반지름(m) — 이 몸이 어느 콜라이더(상자 포함)에도 밀리지 않아야 한다 (그룹이 벽 · 바위에 붙어 서지 않게). */
const OUT_CLEAR_R = 1.2;
/** 폐허 벽 원기둥(`Outposts` — 바닥판 반폭 − 0.6 줄에 반지름 0.62)의 안쪽 면까지 바닥판 가장자리에서 잰 거리(m). */
const RUIN_WALL_INSET = 0.6 + 0.62;

/** WorldSystem 이 넘겨주는 질의 (자기 자신 + 내부 부품). */
export interface SiteSpawnSources {
  getHeightAt(x: number, z: number): number;
  getSurfaceY(x: number, z: number, feetY?: number): number;
  resolveCollision(position: THREE.Vector3, radius: number): THREE.Vector3;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): TerrainHit | null;
  structureAt(x: number, z: number): StructureDef | null;
  slopeAt(x: number, z: number): number;
  layout(): WorldLayout | null;
  hash(): SpatialHash;
  structureDefs(): readonly StructureDef[];
  structureNav(id: string): StructureNav | null;
  platforms(): readonly RailPlatformDef[];
  ruins(): readonly OutpostSite[];
}

/** 거점 하나의 로컬 틀 — 로컬 (lx, lz) → 월드 `(cx + lx·cos − lz·sin, cz + lx·sin + lz·cos)` (구조물 · 플랫폼 · 폐허 공통). */
interface Frame {
  id: string;
  cx: number; cz: number; cos: number; sin: number;
  /** 발자국 반길이 (실외 띠의 기준). */
  halfX: number; halfZ: number;
}

type SiteKind = 'structure' | 'platform' | 'ruin';

interface Site {
  kind: SiteKind;
  frame: Frame;
  structure?: { def: StructureDef; nav: StructureNav };
  platform?: RailPlatformDef;
  ruin?: OutpostSite;
}

const UP = new THREE.Vector3(0, 1, 0);
/** 몸 둘레 여덟 방위 (cos, sin). */
const RING: readonly [number, number][] = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)]);

export class SiteSpawns {
  /** 거점 id → 실내 후보 (월드 좌표, 시드와 무관한 목록). 레이드 동안 유지된다. */
  private readonly indoorCache = new Map<string, THREE.Vector3[]>();
  private readonly p = new THREE.Vector3();
  private readonly o = new THREE.Vector3();
  private readonly near: ObstacleEntry[] = [];
  private readonly ac = { area: 0, x: 0, z: 0 };

  constructor(private readonly src: SiteSpawnSources) {}

  /** 미션이 끝나면 (`WorldSystem.clear`). */
  reset(): void { this.indoorCache.clear(); }

  /** `WorldRef.getSiteSpawnPoints` — 호출부(WorldSystem)가 훈련장 · 준비 전을 이미 걸렀다. */
  points(siteId: string, place: SiteSpawnPlace, count: number, minGap: number, seed: number): THREE.Vector3[] {
    if (typeof siteId !== 'string' || !(count >= 1)) return [];
    if (place !== 'indoor' && place !== 'outdoor') return [];
    const site = this.resolve(siteId);
    if (!site) return [];
    const n = Math.floor(count);
    const gap = Number.isFinite(minGap) && minGap > 0 ? minGap : 0;
    const rng = new Random(((seed >>> 0) ^ Random.hash(siteId + place)) >>> 0);
    const cands = place === 'indoor' ? this.indoorOf(site) : this.outdoorOf(site, rng, n);
    return pickClustered(cands, n, gap, rng);
  }

  /* ── 거점 찾기 ───────────────────────────────────────────────────── */

  private resolve(id: string): Site | null {
    const s = this.src;
    if (id.startsWith('struct_')) {
      const def = s.structureDefs().find((d) => d.id === id);
      const nav = def ? s.structureNav(id) : null;
      if (!def || !nav) return null;
      // 바닥판이 벽 바깥으로 `FLOOR_OVERHANG` 물러나 있다 — 실외 띠는 그 판 끝에서 잰다
      return { kind: 'structure', frame: frameOf(id, nav.cx, nav.cz, nav.yaw, nav.halfW + FLOOR_OVERHANG, nav.halfD + FLOOR_OVERHANG), structure: { def, nav } };
    }
    if (id.startsWith('outpost_')) {
      const ruin = s.ruins().find((r) => r.id === id);
      if (!ruin) return null;
      return { kind: 'ruin', frame: frameOf(id, ruin.position.x, ruin.position.z, ruin.yaw, ruin.slabHalfX, ruin.slabHalfZ), ruin };
    }
    const plat = s.platforms().find((p) => p.id === id);
    if (plat) {
      const { hx, hz } = platformHalf();
      return { kind: 'platform', frame: frameOf(id, plat.position.x, plat.position.z, plat.yaw, hx, hz), platform: plat };
    }
    return null;
  }

  /* ── 실내 ───────────────────────────────────────────────────────── */

  private indoorOf(site: Site): THREE.Vector3[] {
    const hit = this.indoorCache.get(site.frame.id);
    if (hit) return hit;
    const out = site.structure ? this.structureIndoor(site.frame, site.structure.def, site.structure.nav)
      : site.platform ? this.platformIndoor(site.frame, site.platform)
        : site.ruin ? this.ruinIndoor(site.frame, site.ruin) : [];
    this.indoorCache.set(site.frame.id, out);
    return out;
  }

  /** 구조물: 정문 안쪽에서 몸 반지름 flood fill → 층 바닥의 걸어서 닿는 칸. */
  private structureIndoor(f: Frame, def: StructureDef, nav: StructureNav): THREE.Vector3[] {
    const s = this.src;
    const p = this.p;
    const I = Math.ceil(nav.halfW / FILL_STEP), J = Math.ceil(nav.halfD / FILL_STEP);
    const limX = nav.halfW - 0.1, limZ = nav.halfD - 0.1;
    /** 칸 (i, j) 의 월드 XZ. */
    const wx = (i: number, j: number): number => f.cx + i * FILL_STEP * f.cos - j * FILL_STEP * f.sin;
    const wz = (i: number, j: number): number => f.cz + i * FILL_STEP * f.sin + j * FILL_STEP * f.cos;
    const blocked = (x: number, y: number, z: number): boolean => {
      p.set(x, y, z);
      s.resolveCollision(p, BODY_R);
      return Math.hypot(p.x - x, p.z - z) >= PUSH_TOL;
    };

    const y0 = nav.levels[0];
    const si = Math.round(nav.doorIn[0] / FILL_STEP), sj = Math.round(nav.doorIn[1] / FILL_STEP);
    if (Math.abs(si) > I || Math.abs(sj) > J) return [];
    const sy = s.getSurfaceY(wx(si, sj), wz(si, sj), y0 + 0.3);
    if (blocked(wx(si, sj), sy, wz(si, sj))) return [];

    // flood fill — 키는 (i, j, 반 뼘 높이). 칸마다 한 번만 판정한다.
    const key = (i: number, j: number, y: number): string => `${i},${j},${Math.round(y * 2)}`;
    const seen = new Set<string>([key(si, sj, sy)]);
    const bad = new Set<string>();
    const qi: number[] = [si], qj: number[] = [sj], qy: number[] = [sy];
    for (let head = 0; head < qi.length && qi.length < FILL_CAP; head++) {
      const i = qi[head], j = qj[head], y = qy[head];
      for (let d = 0; d < 4; d++) {
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0), nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (Math.abs(ni * FILL_STEP) > limX || Math.abs(nj * FILL_STEP) > limZ) continue;
        const x = wx(ni, nj), z = wz(ni, nj);
        const ny = s.getSurfaceY(x, z, y);
        const k = key(ni, nj, ny);
        if (seen.has(k) || bad.has(k)) continue;
        if (blocked(x, ny, z)) { bad.add(k); continue; }
        seen.add(k);
        qi.push(ni); qj.push(nj); qy.push(ny);
      }
    }

    // 층 바닥 · 바깥벽 안쪽 · 잠긴 방 밖 · 몸 둘레가 같은 바닥 · 계단 없음 · 머리 위 여유
    const building = def.kind !== 'wreck';
    const inX = (building ? nav.halfW - WALL_T / 2 : nav.halfW) - BODY_R;
    const inZ = (building ? nav.halfD - WALL_T / 2 : nav.halfD) - BODY_R;
    const lock = nav.locked;
    const out: THREE.Vector3[] = [];
    for (let n = 0; n < qi.length; n++) {
      const i = qi[n], j = qj[n], y = qy[n];
      if (((i % CAND_EVERY) + CAND_EVERY) % CAND_EVERY !== 0 || ((j % CAND_EVERY) + CAND_EVERY) % CAND_EVERY !== 0) continue;
      const k = nav.levels.findIndex((lv) => Math.abs(y - lv) <= LEVEL_TOL);
      if (k < 0) continue;
      const lx = i * FILL_STEP, lz = j * FILL_STEP;
      if (Math.abs(lx) > inX || Math.abs(lz) > inZ) continue;
      if (lock && lock.k === k && lx > lock.x0 - 0.8 && lx < lock.x1 + 0.8 && lz > lock.z0 - 0.8 && lz < lock.z1 + 0.8) continue;
      const x = wx(i, j), z = wz(i, j);
      if (!this.bodyOnFloor(x, y, z)) continue;
      out.push(new THREE.Vector3(x, y, z));
    }
    return out;
  }

  /** 선로 플랫폼: 데크 사각형 안, 데크 윗면에 몸 전체가 올라서는 칸. */
  private platformIndoor(f: Frame, plat: RailPlatformDef): THREE.Vector3[] {
    const top = plat.position.y;
    const step = FILL_STEP * CAND_EVERY;
    const ex = f.halfX - BODY_R - 0.15, ez = f.halfZ - BODY_R - 0.15;
    const out: THREE.Vector3[] = [];
    for (let lx = -Math.floor(ex / step) * step; lx <= ex + 1e-6; lx += step) {
      for (let lz = -Math.floor(ez / step) * step; lz <= ez + 1e-6; lz += step) {
        const x = f.cx + lx * f.cos - lz * f.sin, z = f.cz + lx * f.sin + lz * f.cos;
        const y = this.src.getSurfaceY(x, z, top + 0.3);
        if (Math.abs(y - top) > LEVEL_TOL) continue;
        if (!this.collisionFree(x, y, z)) continue;
        if (!this.bodyOnFloor(x, y, z)) continue;
        out.push(new THREE.Vector3(x, y, z));
      }
    }
    return out;
  }

  /** 폐허 전초: 바닥판 안 벽 줄 안쪽, 충돌 없는 칸 (바닥판은 콜라이더가 없어 지형을 밟는다). */
  private ruinIndoor(f: Frame, ruin: OutpostSite): THREE.Vector3[] {
    const step = FILL_STEP * CAND_EVERY;
    const ex = ruin.slabHalfX - RUIN_WALL_INSET - BODY_R, ez = ruin.slabHalfZ - RUIN_WALL_INSET - BODY_R;
    const out: THREE.Vector3[] = [];
    if (ex <= 0 || ez <= 0) return out;
    for (let lx = -Math.floor(ex / step) * step; lx <= ex + 1e-6; lx += step) {
      for (let lz = -Math.floor(ez / step) * step; lz <= ez + 1e-6; lz += step) {
        const x = f.cx + lx * f.cos - lz * f.sin, z = f.cz + lx * f.sin + lz * f.cos;
        if (Math.hypot(x - ruin.position.x, z - ruin.position.z) > ruin.radius) continue;
        const ground = this.src.getHeightAt(x, z);
        const y = this.src.getSurfaceY(x, z, ground + 0.3);
        if (y - ground > OUT_MAX_LIFT) continue;             // 드럼통 · 잔해 위가 아니라 바닥
        if (this.src.slopeAt(x, z) > OUT_MAX_SLOPE) continue;
        if (!this.collisionFree(x, y, z)) continue;
        if (!this.bodyOnFloor(x, y, z, 0.3)) continue;
        out.push(new THREE.Vector3(x, y, z));
      }
    }
    return out;
  }

  /* ── 실외 ───────────────────────────────────────────────────────── */

  private outdoorOf(site: Site, rng: Random, count: number): THREE.Vector3[] {
    const s = this.src;
    const layout = s.layout();
    if (!layout) return [];
    const f = site.frame;
    const selfStructure = site.structure?.def.id ?? null;
    const plats = s.platforms();
    const { hx: phx, hz: phz } = platformHalf();
    const ruins = s.ruins();
    const poolCap = Math.max(OUT_POOL_MIN, count * 6);
    const spanX = f.halfX + OUT_FAR, spanZ = f.halfZ + OUT_FAR;
    const out: THREE.Vector3[] = [];
    for (let a = 0; a < OUT_ATTEMPTS && out.length < poolCap; a++) {
      const lx = rng.range(-spanX, spanX), lz = rng.range(-spanZ, spanZ);
      const d = rectDistance(lx, lz, f.halfX, f.halfZ);
      if (d < OUT_NEAR || d > OUT_FAR) continue;
      const x = f.cx + lx * f.cos - lz * f.sin, z = f.cz + lx * f.sin + lz * f.cos;
      if (Math.abs(x) > PLAY_LIMIT || Math.abs(z) > PLAY_LIMIT) continue;
      if (railClearance(layout, x, z) < BODY_R) continue;
      if (s.slopeAt(x, z) > OUT_MAX_SLOPE) continue;
      // 다른 거점 · 착륙장 · 둥지 안이 아니다
      const st = s.structureAt(x, z);
      if (st && st.id !== selfStructure) continue;
      if (plats.some((pl) => pl.id !== f.id && insideRect(pl.position.x, pl.position.z, pl.yaw, phx + 2, phz + 2, x, z))) continue;
      if (ruins.some((r) => r.id !== f.id && insideRect(r.position.x, r.position.z, r.yaw, r.slabHalfX + 1, r.slabHalfZ + 1, x, z))) continue;
      if (layout.extraction.some((e) => Math.hypot(e.x - x, e.z - z) < PLATFORM_RADIUS + OUT_NEAR)) continue;
      if (layout.nests.some((nest) => Math.hypot(nest.x - x, nest.z - z) < nest.radius)) continue;
      const ground = s.getHeightAt(x, z);
      const y = s.getSurfaceY(x, z, ground + 0.3);
      if (y - ground > OUT_MAX_LIFT) continue;
      /* 장애물이 드문 자리: `obstacleCoverage` 는 상자 콜라이더를 **외접원**으로 세서 건물 바닥판(외접원 반지름 ≈ 15 m)
       * 곁을 전부 "가득 찼다" 로 읽는다 — 그래서 원 · 윤곽 소품에만 그 비율을 쓰고, 상자까지 포함한 여유는 넓은 몸
       * (`OUT_CLEAR_R`)의 진짜 충돌 판정으로 본다. */
      if (this.roundCoverage(x, z) > OUT_MAX_COVER) continue;
      if (!this.collisionFree(x, y, z, OUT_CLEAR_R)) continue;
      if (!this.bodyOnFloor(x, y, z, 0.6)) continue;
      out.push(new THREE.Vector3(x, y, z));
    }
    return out;
  }

  /* ── 공용 판정 ─────────────────────────────────────────────────── */

  /** 반지름 `r` 몸이 밀리지 않는다 (머리 위는 `bodyOnFloor` 가 본다). */
  private collisionFree(x: number, y: number, z: number, r = BODY_R): boolean {
    const p = this.p.set(x, y, z);
    this.src.resolveCollision(p, r);
    return Math.hypot(p.x - x, p.z - z) < PUSH_TOL;
  }

  /**
   * 반경 `OUT_COVER_R` 원 안을 **원기둥 · 볼록 윤곽** 소품이 차지하는 면적 비율 — `WorldSystem.obstacleCoverage` 와 같은 식에서
   * 상자만 뺐다 (상자는 외접원으로 세면 실제보다 훨씬 커서 건물 곁이 전부 막힌 것으로 읽힌다 — 상자는 충돌 판정이 본다).
   */
  private roundCoverage(x: number, z: number): number {
    const near = this.near;
    near.length = 0;
    this.src.hash().query(x, z, OUT_COVER_R, near);
    let area = 0;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.box) continue;
      if (o.hull) {
        hullAreaCentroid(o.hull.points, this.ac);
        area += circleOverlap(Math.hypot(this.ac.x - x, this.ac.z - z), OUT_COVER_R, Math.sqrt(Math.max(0, this.ac.area) / Math.PI));
      } else {
        area += circleOverlap(Math.hypot(o.position.x - x, o.position.z - z), OUT_COVER_R, o.radius);
      }
    }
    near.length = 0;
    return area / (Math.PI * OUT_COVER_R * OUT_COVER_R);
  }

  private headroom(x: number, y: number, z: number): boolean {
    return this.src.raycast(this.o.set(x, y + 0.1, z), UP, HEADROOM - 0.1) === null;
  }

  /**
   * 몸 둘레 여덟 점이 모두 같은 바닥(`tol` 안)이고, 몸 밑에 경사 콜라이더(계단)가 없고, 머리 위가 비어 있다.
   * 계단 구멍 · 지하 계단 구멍 · 데크 가장자리에 몸이 걸친 칸이 여기서 빠진다.
   */
  private bodyOnFloor(x: number, y: number, z: number, tol = LEVEL_TOL): boolean {
    const s = this.src;
    for (const [c, sn] of RING) {
      const py = s.getSurfaceY(x + c * BODY_R, z + sn * BODY_R, y + 0.3);
      if (Math.abs(py - y) > tol) return false;
    }
    const near = this.near;
    near.length = 0;
    s.hash().query(x, z, BODY_R + 0.2, near);
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.ramp && o.box && boxContainsXZ(o, x, z, BODY_R + 0.1)) { near.length = 0; return false; }
    }
    near.length = 0;
    return this.headroom(x, y, z);
  }
}

/* ── 순수 도우미 ──────────────────────────────────────────────────── */

function frameOf(id: string, cx: number, cz: number, yaw: number, halfX: number, halfZ: number): Frame {
  return { id, cx, cz, cos: Math.cos(yaw), sin: Math.sin(yaw), halfX, halfZ };
}

/** 플랫폼 데크 반길이 — `Rails` 가 짓는 값과 같은 줄 (`rails/parts/Platform` 의 폴백 7 × 4.5 포함). */
function platformHalf(): { hx: number; hz: number } {
  const row = structureRow('rail_platform');
  return { hx: row ? row.halfW : 7, hz: row ? row.halfD : 4.5 };
}

/** 두 원이 겹치는 넓이 (`WorldSystem.obstacleCoverage` 의 식과 같다). */
function circleOverlap(d: number, r1: number, r2: number): number {
  if (r1 <= 0 || r2 <= 0 || d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) { const r = Math.min(r1, r2); return Math.PI * r * r; }
  const s1 = r1 * r1, s2 = r2 * r2;
  const a1 = Math.acos(Math.min(1, Math.max(-1, (d * d + s1 - s2) / (2 * d * r1))));
  const a2 = Math.acos(Math.min(1, Math.max(-1, (d * d + s2 - s1) / (2 * d * r2))));
  return s1 * (a1 - Math.sin(2 * a1) / 2) + s2 * (a2 - Math.sin(2 * a2) / 2);
}

/** 로컬 점 (lx, lz) 에서 원점 중심 사각형(±hx, ±hz)까지의 바깥 거리 (안이면 0). */
function rectDistance(lx: number, lz: number, hx: number, hz: number): number {
  const dx = Math.max(0, Math.abs(lx) - hx), dz = Math.max(0, Math.abs(lz) - hz);
  return Math.hypot(dx, dz);
}

/** 월드 점 (x, z) 가 (cx, cz, yaw) 틀의 사각형(±hx, ±hz) 안인가. */
function insideRect(cx: number, cz: number, yaw: number, hx: number, hz: number, x: number, z: number): boolean {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = x - cx, dz = z - cz;
  return Math.abs(dx * c + dz * s) <= hx && Math.abs(-dx * s + dz * c) <= hz;
}

/** 돌려주는 자리를 몇 개씩 한 무리로 묶나 — 인간형 한 그룹(1–4명)의 크기. */
const CLUMP = 4;

/**
 * **무리 지어 흩어 놓기.** `count` 를 `floor(count / CLUMP)` 개(최소 1) 무리로 나눈다:
 *  ① 첫 무리의 기준점 = 시드로 섞은 순서의 첫 후보 (돌려주는 배열의 **맨 앞**이다),
 *  ② 다음 기준점 = 앞 기준점들에서 **가장 먼** 후보 (`gap` 이상 떨어진 것 중, 동점은 섞인 순서),
 *  ③ 무리마다 기준점에서 가까운 순서(3D)로 `gap` 을 지키며 채운다 (마지막 무리가 나머지를 받는다).
 * 배열은 무리 순서대로다. 스폰 감독(`enemies/SiteGroups`)은 첫 자리를 첫 그룹 앵커로, 앞 앵커에서 가장 먼 자리를 다음 앵커로
 * 삼고 앵커 곁을 떼어 가므로 — 그룹마다 한 무리가 되어 거점 둘레에 흩어지고, 한 그룹은 뭉쳐 선다.
 * 후보 배열은 건드리지 않는다 (캐시다).
 */
function pickClustered(cands: readonly THREE.Vector3[], count: number, gap: number, rng: Random): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  if (cands.length === 0 || count <= 0) return out;
  const order = cands.map((_, i) => i);
  rng.shuffle(order);
  const rank = new Array<number>(cands.length);
  order.forEach((ci, r) => { rank[ci] = r; });
  const gap2 = gap * gap;

  // ①② 기준점 — 최원점 샘플링
  const clumps = Math.max(1, Math.floor(count / CLUMP));
  const anchors: number[] = [order[0]];
  while (anchors.length < clumps) {
    let best = -1, bestD = -1;
    for (const ci of order) {
      let d = Infinity;
      for (const a of anchors) d = Math.min(d, cands[ci].distanceToSquared(cands[a]));
      if (d < gap2 || d <= bestD) continue;
      bestD = d; best = ci;
    }
    if (best < 0) break;
    anchors.push(best);
  }

  // ③ 무리 채우기
  const per = Math.ceil(count / anchors.length);
  const taken = new Uint8Array(cands.length);
  anchors.forEach((a, k) => {
    const quota = k === anchors.length - 1 ? count - out.length : Math.min(per, count - out.length);
    if (quota <= 0) return;
    const base = cands[a];
    const byNear = order.slice().sort((x, y) => (cands[x].distanceToSquared(base) - cands[y].distanceToSquared(base)) || (rank[x] - rank[y]));
    let got = 0;
    for (const ci of byNear) {
      if (got >= quota) break;
      if (taken[ci]) continue;
      const c = cands[ci];
      let ok = true;
      for (let i = 0; i < out.length; i++) if (out[i].distanceToSquared(c) < gap2) { ok = false; break; }
      if (!ok) continue;
      taken[ci] = 1;
      out.push(c.clone());
      got++;
    }
  });
  return out;
}
