import * as THREE from 'three';
import { MAP_SIZE, RAIL_CHANCE, Random, type RailKind, type StructureKind } from '@/shared';
import { STRUCTURE_ROWS, structureRow } from './structures/model';

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

/** Place the macro layout: spawn, extraction pads, nests, POIs, craters, basins. Deterministic per rng. */
export function generateLayout(rng: Random): WorldLayout {
  const margin = 56; // keep pads away from the cliff wall
  const inner = HALF - margin;

  // Spawn near one edge
  const side = rng.int(0, 3);
  const along = rng.range(-inner * 0.6, inner * 0.6);
  const edgeDist = HALF - 64;
  let sx = 0, sz = 0;
  if (side === 0) { sx = -edgeDist; sz = along; }
  else if (side === 1) { sx = edgeDist; sz = along; }
  else if (side === 2) { sx = along; sz = -edgeDist; }
  else { sx = along; sz = edgeDist; }
  const spawn: Pad = { kind: 'spawn', x: sx, z: sz, radius: 18, blend: 22, yaw: Math.atan2(-sx, -sz), height: 0 };

  // Extraction pads: 3, pairwise >= 180 m, >= 150 m from spawn
  const extraction: Pad[] = [];
  {
    let minPair = 180, minSpawn = 150;
    let attempts = 0;
    while (extraction.length < 3) {
      attempts++;
      if (attempts % 400 === 0) { minPair *= 0.92; minSpawn *= 0.92; } // relax slowly if unlucky
      const x = rng.range(-inner, inner), z = rng.range(-inner, inner);
      if (dist(x, z, spawn.x, spawn.z) < minSpawn) continue;
      if (!farFromAll(x, z, extraction, minPair)) continue;
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
      pois.push({ kind: 'poi', x, z, radius: 13, blend: 16, yaw: rng.range(-Math.PI, Math.PI), height: 0 });
    }
  }

  const pads = [spawn, ...extraction, ...nests, ...pois];

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
        const pad: Pad = {
          kind: 'structure', x, z, radius: reach + 4, blend: 11,
          yaw: rng.range(-Math.PI, Math.PI), height: 0,
        };
        // 지하실은 전진기지 · 연구실만 (불시착 함선은 밑이 없다). 벽에서 2.2 m 안쪽으로 파낸다.
        const wantPit = row.basementChance > 0 && rng.chance(row.basementChance);
        const pit = wantPit && row.halfW > 3.4 && row.halfD > 3.4
          ? { halfX: row.halfW - 2.2, halfZ: row.halfD - 2.2, depth: row.basementDepth }
          : null;
        structures.push({ kind: row.kind, pad, halfW: row.halfW, halfD: row.halfD, wallH: row.wallH, pit });
        placed++;
      }
    }
    for (const s of structures) pads.push(s.pad);
  }

  /* ── 2026-09-09: 선로 계획 ────────────────────────────────────────────────
   * 선로 자체는 지형을 평탄화하지 않는다 (교각이 높이를 맞춘다) — 여기서 정하는 것은 모양과 **플랫폼 자리**다.
   * 위상은 8번 굴려 스폰 · 둥지 · 탈출 패드에서 제일 멀리 떨어지는 것을 고른다. */
  let rail: RailPlan | null = null;
  if (rng.chance(RAIL_CHANCE)) {
    const platRow = structureRow('rail_platform');
    const stopCount = Math.max(2, platRow ? platRow.minCount : 2);
    const loop = rng.chance(0.5);
    const extent = loop ? inner * 0.62 : inner * 0.72;
    const avoid = [spawn, ...extraction, ...nests, ...structures.map((s) => s.pad)];
    const at = (angle: number, t: number): { x: number; z: number } => (loop
      ? { x: Math.cos(angle + t * Math.PI * 2) * extent, z: Math.sin(angle + t * Math.PI * 2) * extent }
      : { x: Math.cos(angle) * (t * 2 - 1) * extent, z: Math.sin(angle) * (t * 2 - 1) * extent });
    let bestAngle = 0, bestScore = -Infinity, bestStops: number[] = [];
    for (let a = 0; a < 8; a++) {
      const angle = loop ? rng.range(0, Math.PI * 2) : (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.35, 0.35);
      const stops: number[] = [];
      for (let i = 0; i < stopCount; i++) stops.push(loop ? i / stopCount : i / (stopCount - 1));
      let score = Infinity;
      for (const t of stops) {
        const p = at(angle, t);
        for (const o of avoid) score = Math.min(score, dist(p.x, p.z, o.x, o.z));
      }
      if (score > bestScore) { bestScore = score; bestAngle = angle; bestStops = stops; }
    }
    const platforms: Pad[] = bestStops.map((t) => {
      const p = at(bestAngle, t);
      return { kind: 'platform' as PadKind, x: p.x, z: p.z, radius: 13, blend: 12, yaw: 0, height: 0 };
    });
    rail = { kind: (loop ? 'loop' : 'line') as RailKind, extent, angle: bestAngle, stops: bestStops, platforms };
    for (const p of platforms) pads.push(p);
  }

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
