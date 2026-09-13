import * as THREE from 'three';
import {
  EXTRACTION_OUTER_MIN_M, EXTRACTION_PADS_MAX_BY_THREAT, EXTRACTION_PADS_MIN_BY_THREAT, EXTRACTION_PADS_SPORES_MAX,
  EXTRACTION_PADS_SPORES_MIN, MAP_SIZE, RAIL_CHANCE, Random, SPORE_SPAWN_CENTER_M, type RailKind, type StructureKind,
} from '@/shared';
import { RAIL_CLEARANCE_M, STRUCTURE_ROWS, structureRow } from './structures/model';

/**
 * 2026-09-09 — `structure` (버려진 구조물 부지) 와 `platform` (선로 플랫폼) 이 붙었다.
 * 둘 다 지형이 **평탄화해야** 하는 자리라 매크로 레이아웃 단계에서 먼저 잡는다.
 */
export type PadKind = 'spawn' | 'extraction' | 'nest' | 'poi' | 'structure' | 'platform';

/** A flattened circular area blended into the heightfield. */
export interface Pad {
  kind: PadKind;
  x: number;
  z: number;
  radius: number;      // fully flat radius
  blend: number;       // smooth blend width beyond radius
  yaw: number;
  /** Assigned by Terrain once the heightfield is sampled. */
  height: number;
}

export interface Crater { x: number; z: number; radius: number; depth: number }
export interface Basin { x: number; z: number; radius: number; depth: number }

/**
 * 2026-09-09 — 버려진 구조물 한 채의 **부지**. 지형이 이 자리를 평탄화하고, 지하실이 있으면 그 밑을 파낸다
 * (`Terrain.build` 의 pad 평탄화 **다음** 단계). 건물 자체는 `world/Structures.ts` 가 세운다.
 */
export interface StructureSite {
  kind: StructureKind;
  pad: Pad;
  /** 건물 바닥 반길이(m, 패드 로컬 축). */
  halfW: number;
  halfD: number;
  wallH: number;
  /** 지하실 구덩이. null = 지하실 없음. 로컬 축 반길이 + 바닥 깊이(m)다. */
  pit: { halfX: number; halfZ: number; depth: number } | null;
  /** 지상 층수 (2026-09-11) — 1 또는 2. 어느 쪽이든 옥상이 있다. */
  floors: number;
}

/**
 * 2026-09-09 — 이번 맵의 선로 계획. 실제 선로 · 전차는 `world/Rails.ts` 가 지형 높이를 읽어 세운다
 * (선로는 지형을 평탄화하지 않는다 — 교각으로 높이를 맞춘다). 여기서 정하는 것은 **모양과 플랫폼 자리**뿐이다.
 */
export interface RailPlan {
  kind: RailKind;
  /** `loop` = 순환 반지름(m), `line` = 중심에서 끝까지의 반길이(m). */
  extent: number;
  /** `loop` = 링의 위상, `line` = 선로 방향(rad). */
  angle: number;
  /** 선로 위 진행거리 `s` 의 비율(0..1) 로 적어 둔 플랫폼 자리. `Rails` 가 이걸로 정확한 지점을 잡는다. */
  stops: number[];
  platforms: Pad[];
}

export interface WorldLayout {
  spawn: Pad;
  extraction: Pad[];
  nests: Pad[];
  pois: Pad[];
  pads: Pad[];          // all of the above
  craters: Crater[];
  basins: Basin[];
  /* appended (2026-09-09): 레이드 플레이 개선 */
  structures: StructureSite[];
  rail: RailPlan | null;
}

const HALF = MAP_SIZE / 2;

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function farFromAll(x: number, z: number, others: readonly { x: number; z: number }[], minD: number): boolean {
  for (const o of others) if (dist(x, z, o.x, o.z) < minD) return false;
  return true;
}

/** `RailPlan` 의 중심선 위 한 점 (`t` = 0..1). `Rails.build` 가 점열을 만드는 식과 **같은 식**이다. */
function railPointAt(loop: boolean, extent: number, angle: number, t: number): { x: number; z: number } {
  return loop
    ? { x: Math.cos(angle + t * Math.PI * 2) * extent, z: Math.sin(angle + t * Math.PI * 2) * extent }
    : { x: Math.cos(angle) * (t * 2 - 1) * extent, z: Math.sin(angle) * (t * 2 - 1) * extent };
}

/**
 * `(x, z)` 에서 선로 **중심선**까지의 XZ 거리. 선로가 없으면 Infinity.
 * `loop` 은 닫힌 원이라 점-원 거리, `line` 은 원점을 지나는 선분이라 점-선분 거리다.
 */
export function railDistance(rail: RailPlan | null, x: number, z: number): number {
  if (!rail) return Infinity;
  if (rail.kind === 'loop') return Math.abs(Math.hypot(x, z) - rail.extent);
  const dx = Math.cos(rail.angle), dz = Math.sin(rail.angle);
  const t = Math.max(-rail.extent, Math.min(rail.extent, x * dx + z * dz));
  return Math.hypot(x - dx * t, z - dz * t);
}

/**
 * 선로 회랑까지의 여유(m) — 음수면 **회랑 안**이라 아무것도 놓지 않는다 (`isSpotFree` 가 본다).
 * 플랫폼은 선로 시설이므로 여기서 세지 않는다 (그 자리는 `layout.pads` 의 `platform` 패드가 막는다).
 */
export function railClearance(layout: WorldLayout, x: number, z: number): number {
  return railDistance(layout.rail, x, z) - RAIL_CLEARANCE_M;
}

/**
 * 2026-09-13 — 매크로 레이아웃이 **재해 종류 · 행성 threat** 를 안다. 둘 다 레이아웃보다 먼저 시드에서 정해진다
 * (`WorldSystem.generate` — 재해 종류는 `hazard/parts/Plan.drawHazardKind` 의 자기 fork, 패드 수는 `extractionPadCount`
 * 의 자기 fork) 그래서 멀티 결정성은 그대로다.
 */
export interface LayoutOptions {
  /** 탈출 패드 수 (`extractionPadCount`). 없으면 옛 3. */
  extractionCount?: number;
  /**
   * 이번 레이드의 재해가 **독성 포자**인가. 포자는 맵 중앙에서 외곽으로 퍼지므로 강하 지점은 맵 중앙
   * (`SPORE_SPAWN_CENTER_M`), 탈출 패드는 외곽(`EXTRACTION_OUTER_MIN_M`) 에 선다 — 다른 재해의 반대다.
   */
  sporeLayout?: boolean;
}

/**
 * 2026-09-13 (사용자 결정) — 탈출 패드 수. 행성 threat 1 = 2–3 · 2 = 2 · 3 = 1–2 (`tables.csv` 의
 * `EXTRACTION_PADS_MIN/MAX_BY_THREAT`), 독성 포자 레이드는 threat 와 무관하게 2–3 (`EXTRACTION_PADS_SPORES_*`).
 * `rng` 는 호출자가 넘기는 **전용 fork** 다 — 한 번만 뽑으므로 레이아웃 스트림을 밀지 않는다.
 */
export function extractionPadCount(rng: Random, threat: number, spores: boolean): number {
  const i = Math.max(0, Math.min(2, Math.round(threat) - 1));
  const lo0 = spores ? EXTRACTION_PADS_SPORES_MIN : (EXTRACTION_PADS_MIN_BY_THREAT[i] ?? 3);
  const hi0 = spores ? EXTRACTION_PADS_SPORES_MAX : (EXTRACTION_PADS_MAX_BY_THREAT[i] ?? lo0);
  const lo = Math.max(1, Math.round(lo0));
  const hi = Math.max(lo, Math.round(hi0));
  return rng.int(lo, hi);
}

/** Place the macro layout: spawn, extraction pads, nests, POIs, craters, basins. Deterministic per rng. */
export function generateLayout(rng: Random, opts: LayoutOptions = {}): WorldLayout {
  const margin = 56; // keep pads away from the cliff wall
  const inner = HALF - margin;

  /* ── 2026-09-10: 선로를 **제일 먼저** 잡는다 ─────────────────────────────────
   * 요구는 "선로 회랑 안에 아무것도 놓이지 않는다" 인데, 선로의 자유도는 `line` = 방향 하나,
   * `loop` = 반지름 하나뿐이다 (둘 다 원점을 지나는 도형이고 `Rails` 가 `extent` · `angle` 을 그대로 쓴다).
   * 패드 스무 개를 다 뽑아 놓고 그 사이를 지나는 각도 · 반지름을 찾는 것은 실제로 불가능하다 — 반지름
   * 20 m 짜리 원반 하나가 막는 각도 폭이 0.4 rad 쯤이라 스무 개면 π 를 넘는다. 그래서 순서를 뒤집었다:
   * **선로가 먼저 서고 나머지가 전부 피한다** (`railFree`). 2026-09-09 의 "크레이터 다음에 굴린다" 는
   * rng 순서 배려는 여기서 끝난다 — 같은 시드의 매크로 레이아웃이 이 변경 전과 달라진다
   * (멀티 결정성은 그대로: 모두가 같은 코드를 같은 시드로 돌린다). */
  let rail: RailPlan | null = null;
  if (rng.chance(RAIL_CHANCE)) {
    const platRow = structureRow('rail_platform');
    const stopCount = Math.max(2, platRow ? platRow.minCount : 2);
    const loop = rng.chance(0.5);
    const extent = loop ? inner * 0.62 : inner * 0.72;
    const angle = loop ? rng.range(0, Math.PI * 2) : (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.35, 0.35);
    const stops: number[] = [];
    for (let i = 0; i < stopCount; i++) stops.push(loop ? i / stopCount : i / (stopCount - 1));
    const platforms: Pad[] = stops.map((t) => {
      const p = railPointAt(loop, extent, angle, t);
      return { kind: 'platform' as PadKind, x: p.x, z: p.z, radius: 13, blend: 12, yaw: 0, height: 0 };
    });
    rail = { kind: (loop ? 'loop' : 'line') as RailKind, extent, angle, stops, platforms };
  }

  /** 반지름 `extra` 짜리 자리가 선로 회랑 · 플랫폼 패드를 건드리지 않는가. */
  const railFree = (x: number, z: number, extra: number): boolean => {
    if (!rail) return true;
    if (railDistance(rail, x, z) < RAIL_CLEARANCE_M + extra) return false;
    for (const p of rail.platforms) if (dist(x, z, p.x, p.z) < p.radius + extra) return false;
    return true;
  };

  let spawn: Pad;
  if (opts.sporeLayout) {
    /* 2026-09-13 — 독성 포자 레이드는 맵 **중앙**에 강하한다 (포자가 중앙에서 외곽으로 퍼진다). `line` 선로는 원점을 지나고
     * 가운데 플랫폼이 원점에 설 수도 있어서, 회랑에 걸리면 반경을 조금씩 넓혀 다시 뽑는다. */
    let sx = 0, sz = 0;
    for (let a = 0; a < 240; a++) {
      const reach = SPORE_SPAWN_CENTER_M + a * 0.75;
      const ang = rng.range(0, Math.PI * 2);
      const r = reach * Math.sqrt(rng.next());
      sx = Math.cos(ang) * r; sz = Math.sin(ang) * r;
      if (railFree(sx, sz, 18)) break;
    }
    spawn = { kind: 'spawn', x: sx, z: sz, radius: 18, blend: 22, yaw: rng.range(-Math.PI, Math.PI), height: 0 };
  } else {
    // Spawn near one edge (선로 회랑에 걸리면 가장자리를 따라 다시 뽑는다)
    const side = rng.int(0, 3);
    let along = rng.range(-inner * 0.6, inner * 0.6);
    const edgeDist = HALF - 64;
    const edgePoint = (a: number): { x: number; z: number } => (
      side === 0 ? { x: -edgeDist, z: a }
        : side === 1 ? { x: edgeDist, z: a }
          : side === 2 ? { x: a, z: -edgeDist }
            : { x: a, z: edgeDist });
    for (let a = 0; a < 60; a++) {
      const p = edgePoint(along);
      if (railFree(p.x, p.z, 18)) break;
      along = rng.range(-inner * 0.6, inner * 0.6);
    }
    const { x: sx, z: sz } = edgePoint(along);
    spawn = { kind: 'spawn', x: sx, z: sz, radius: 18, blend: 22, yaw: Math.atan2(-sx, -sz), height: 0 };
  }

  /* Extraction pads: `opts.extractionCount` (2026-09-13 — 옛 3 고정), pairwise >= 180 m, >= 150 m from spawn.
   * 독성 포자 레이드는 맵 **외곽**(x · z 중 큰 쪽이 `EXTRACTION_OUTER_MIN_M` 이상)에만 — 포자가 마지막에 닿는 곳이다. */
  const extraction: Pad[] = [];
  {
    const want = Math.max(1, Math.round(opts.extractionCount ?? 3));
    let minPair = 180, minSpawn = 150;
    let outer = opts.sporeLayout ? Math.min(EXTRACTION_OUTER_MIN_M, inner - 4) : 0;
    let attempts = 0;
    while (extraction.length < want) {
      attempts++;
      if (attempts % 400 === 0) { minPair *= 0.92; minSpawn *= 0.92; outer *= 0.96; } // relax slowly if unlucky
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (outer > 0 && Math.max(Math.abs(x), Math.abs(z)) < outer) continue;
      if (dist(x, z, spawn.x, spawn.z) < minSpawn) continue;
      if (!farFromAll(x, z, extraction, minPair)) continue;
      if (!railFree(x, z, 20)) continue;
      extraction.push({ kind: 'extraction', x, z, radius: 20, blend: 26, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  // Nest clusters: 4–6
  const nests: Pad[] = [];
  {
    const n = rng.int(4, 6);
    let attempts = 0;
    while (nests.length < n && attempts < 4000) {
      attempts++;
      const x = rng.range(-inner + 10, inner - 10), z = rng.range(-inner + 10, inner - 10);
      if (dist(x, z, spawn.x, spawn.z) < 110) continue;
      if (!farFromAll(x, z, extraction, 62)) continue;
      if (!farFromAll(x, z, nests, 90)) continue;
      if (!railFree(x, z, 20)) continue;
      nests.push({ kind: 'nest', x, z, radius: 20, blend: 24, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  // POIs (ruined outposts): 5–8
  const pois: Pad[] = [];
  {
    const n = rng.int(5, 8);
    let attempts = 0;
    while (pois.length < n && attempts < 4000) {
      attempts++;
      const x = rng.range(-inner + 8, inner - 8), z = rng.range(-inner + 8, inner - 8);
      if (dist(x, z, spawn.x, spawn.z) < 50) continue;
      if (!farFromAll(x, z, extraction, 48)) continue;
      if (!farFromAll(x, z, nests, 48)) continue;
      if (!farFromAll(x, z, pois, 70)) continue;
      if (!railFree(x, z, 13)) continue;
      pois.push({ kind: 'poi', x, z, radius: 13, blend: 16, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  /* 플랫폼 패드는 **구조물보다 먼저** 넣는다: 겹칠 일은 없지만(`railFree`), `Terrain` 이 배열 순서대로
   * 평탄화하므로 만에 하나 겹치면 뒤에 오는 구조물 바닥이 이긴다 — 실내 바닥이 기우는 쪽보다 낫다. */
  const pads = [spawn, ...extraction, ...nests, ...pois, ...(rail ? rail.platforms : [])];

  // Craters: 3–5, away from pads
  const craters: Crater[] = [];
  {
    const n = rng.int(3, 5);
    let attempts = 0;
    while (craters.length < n && attempts < 2000) {
      attempts++;
      const radius = rng.range(14, 30);
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (!farFromAll(x, z, pads, radius + 34)) continue;
      if (!farFromAll(x, z, craters, radius + 40)) continue;
      // 선로는 지형을 평탄화하지 않는다 — 크레이터를 가로지르면 교각만 길어지고 궤도가 허공에 뜬다
      if (!railFree(x, z, radius)) continue;
      craters.push({ x, z, radius, depth: rng.range(4, 8) });
    }
  }

  // Basins: 2–3 broad gentle depressions
  const basins: Basin[] = [];
  {
    const n = rng.int(2, 3);
    let attempts = 0;
    while (basins.length < n && attempts < 1000) {
      attempts++;
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (!farFromAll(x, z, basins, 120)) continue;
      basins.push({ x, z, radius: rng.range(55, 90), depth: rng.range(3, 6) });
    }
  }

  /* ── 2026-09-09: 버려진 구조물 부지 ────────────────────────────────────────
   * **크레이터 · 분지를 다 뽑은 뒤에** 굴린다. 그래야 구조물이 소비하는 rng 가 그 앞의 추첨을 밀지 않는다
   * (같은 시드의 지형 매크로 형태는 이 변경 전과 그대로다). 다만 새 패드가 `pads` 에 들어가므로
   * `padClearance` 를 보는 소품 · 상자 · 적 스폰의 자리는 달라진다 — 건물 안에 바위가 서지 않게 하려면
   * 이게 맞다. */
  const structures: StructureSite[] = [];
  {
    for (const row of STRUCTURE_ROWS) {
      if (row.kind !== 'outpost' && row.kind !== 'lab' && row.kind !== 'wreck') continue;
      const want = row.maxCount <= 0 ? 0 : rng.int(row.minCount, row.maxCount);
      const reach = Math.hypot(row.halfW, row.halfD);
      let placed = 0;
      for (let a = 0; a < 3000 && placed < want; a++) {
        const x = rng.range(-inner + reach, inner - reach), z = rng.range(-inner + reach, inner - reach);
        if (dist(x, z, spawn.x, spawn.z) < row.minGap) continue;
        if (!farFromAll(x, z, extraction, 70)) continue;
        if (!farFromAll(x, z, nests, 80)) continue;
        if (!farFromAll(x, z, pois, 55)) continue;
        if (!farFromAll(x, z, structures.map((s) => s.pad), 110)) continue;
        if (!railFree(x, z, reach + 4)) continue;
        const pad: Pad = {
          kind: 'structure', x, z, radius: reach + 4, blend: 11,
          yaw: rng.range(-Math.PI, Math.PI), height: 0,
        };
        // 지하실은 전진기지 · 연구실만 (불시착 함선은 밑이 없다). 벽에서 2.2 m 안쪽으로 파낸다.
        // 2026-09-12: 연구실은 `basementChance` 0 이 됐지만 **들어가는 건물 두 종은 이 추첨을 늘 소비한다** — 조건을
        // `basementChance > 0` 로 두면 연구실에서 draw 가 하나 빠져 그 뒤의 부지 · 층수 · 다른 구조물 추첨이 전부 밀린다.
        const wantPit = (row.kind === 'outpost' || row.kind === 'lab') && rng.chance(row.basementChance);
        const pit = wantPit && row.halfW > 3.4 && row.halfD > 3.4
          ? { halfX: row.halfW - 2.2, halfZ: row.halfD - 2.2, depth: row.basementDepth }
          : null;
        // 2026-09-11: 2층 여부. **맨 마지막에** 굴린다 — 앞의 추첨(자리 · 지하실)을 밀지 않는다.
        const floors = row.upperChance > 0 && rng.chance(row.upperChance) ? 2 : 1;
        structures.push({ kind: row.kind, pad, halfW: row.halfW, halfD: row.halfD, wallH: row.wallH, pit, floors });
        placed++;
      }
    }
    for (const s of structures) pads.push(s.pad);
  }

  /* 선로 계획은 이 함수 **맨 앞**에서 이미 잡혔다 (위의 2026-09-10 주석) — 여기서는 아무것도 하지 않는다.
   * 플랫폼 패드도 `pads` 에 이미 들어가 있다. */

  return { spawn, extraction, nests, pois, pads, craters, basins, structures, rail };
}

/** Distance from (x,z) to nearest pad edge (negative when inside a pad's flat radius). */
export function padClearance(layout: WorldLayout, x: number, z: number, extra = 0): number {
  let best = Infinity;
  for (const p of layout.pads) {
    const d = dist(x, z, p.x, p.z) - (p.radius + extra);
    if (d < best) best = d;
  }
  return best;
}

export function nearestPad(layout: WorldLayout, x: number, z: number, kinds?: readonly PadKind[]): { pad: Pad; d: number } | null {
  let best: Pad | null = null, bd = Infinity;
  for (const p of layout.pads) {
    if (kinds && !kinds.includes(p.kind)) continue;
    const d = dist(x, z, p.x, p.z);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { pad: best, d: bd } : null;
}

export const tmpV3 = new THREE.Vector3();
