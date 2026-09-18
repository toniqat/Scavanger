/**
 * src/enemies/NestDirector.ts — **벌레 둥지** (2026-09-18, 사용자 결정 「둥지 반경 60 m 리시 · 초기 수 절반 ·
 * 재스폰 50/35/15 %」 + 「둥지의 장식 알을 부술 수 있는 적으로」).
 *
 * 한 레이드의 둥지에 대해 세 가지를 답한다.
 *
 * ① **알** — `WorldRef.getNestEggSpots()` 의 자리마다 `bug_egg` 한 마리를 세운다 (`world:ready`, 권위 전용). 알은
 *    움직이지 · 공격하지 · 알아채지 않는 고정 표적이고(`Enemy.isEgg`), 자리마다 크기가 0.35~0.7 m 로 달라 **개체별
 *    `EnemyStats` 사본**과 `rig.baseScale` 로 「보이는 알 = 히트박스」를 맞춘다. 자리의 `position` 은 **그려진 구의 중심**
 *    이므로 발(= `Enemy.position`)은 거기서 `radius × EGG_CENTER_MUL` 아래다. 리플리카는 평소처럼 `ee spawn` 으로 본다 —
 *    새 와이어가 없다. 행성 레이드 전용이다: 훈련장 · 튜토리얼은 `getNestEggSpots()` 가 빈 배열이라 이 파일이 아무 일도 하지 않는다.
 *
 * ② **둥지 앵커** — 「사람이 둥지 하나라고 부르는 것」(`NestEggSpot.nest` = pad 순번)의 자리. `getNestPositions()` 는 둥지
 *    하나당 구멍(둔덕) 4~6개를 줄줄이 내놓아 pad 와 색인이 다르므로 **그것으로 pad 를 찾지 않는다.** 앵커는 그 pad 에 딸린
 *    알자리들의 **무게중심**이다 — 알은 둔덕 밑동을 둘러싸므로 그 가운데가 곧 둥지 한가운데다. `AmbientSpawner` 가 레이드
 *    시작 배치에서 이 앵커를 「둥지」로 쓰고(`nests` 인자), 그 자리에 선 무리가 그 둥지의 수비대가 된다.
 *
 * ③ **수비대 · 보충** — 수비대는 `Enemy.nestOf` 로 제 둥지를 기억하고 `ai/NestLeash` 가 `NEST_LEASH_M`(60 m) 리시를 건다.
 *    레이드 시작 수는 `NEST_INITIAL_GARRISON_MUL`(0.5) 로 절반이다 (`Spawner.initialPopulate` 의 무리 수에 곱한다).
 *    둥지마다 **이번 레이드에 할 수 있는 보충 횟수**를 월드 시드로 한 번 굴린다 (`NEST_REFILL_COUNT_CHANCE` — 1회 50 % ·
 *    2회 35 % · 3회 15 %). 굴림은 `Random.hash('nest@<seed>')` 의 제 스트림이라 월드 · 네임드 굴림을 한 톨도 건드리지 않고
 *    호스트가 바뀌어도 같은 답이 나온다. 그 둥지의 살아 있는 **움직이는** 벌레(알은 `isCombatant` false 라 애초에 안 세진다)가
 *    처음 깔린 수 × `NEST_REFILL_TRIGGER_FRAC` 이하로 줄면 보충 한 번이 터져 무리 하나가 둥지에서 파고 나온다
 *    (`BURROW_EMERGE_S` — 순찰과 같은 길). 배정된 횟수를 다 쓰면 그 둥지는 레이드가 끝날 때까지 비어 있다.
 *
 * 전부 권위(호스트 · 싱글)의 결정이고 **새 와이어가 없다** — 리플리카는 `ee spawn` 만 본다. `nestOf` 는 호스트 메모리라
 * 호스트가 바뀌면 리시가 풀려 평범한 벌레가 된다 (`ai/ArtilleryPack` 의 `escortOf` 와 같은 의도).
 */
import * as THREE from 'three';
import { BURROW_EMERGE_S, Random, type NestEggSpot, type PlanetEcosystem, type WorldRef } from '@/shared';
import type { Enemy } from './Enemy';
import { ENEMY_STATS } from './EnemyTypes';
import {
  NEST_REFILL_CHECK_S, NEST_REFILL_COUNT_CHANCE, NEST_REFILL_TRIGGER_FRAC, type BugThreatTuning, bugThreatTuning,
} from './factionTables';
import { EGG_CENTER_MUL, setEggScale } from './models/EggModel';
import { ambientCap, ambientGroup, ambientOptsOf, spawnGroup, type SpawnHost } from './Spawner';

/** 이 레이드의 둥지 하나 (권위 전용 기록). */
interface NestState {
  /** `NestEggSpot.nest` — pad 순번 그대로 (기록 · 디버그용). */
  readonly pad: number;
  /** 둥지 한가운데 (그 pad 알자리들의 무게중심). 리시의 기준점이자 보충이 파고 나오는 자리다. */
  readonly anchor: THREE.Vector3;
  /** 이번 레이드에 남은 보충 횟수. */
  refillsLeft: number;
  /** 처음 깔린 수비대 마리 수 (0 = 이 둥지에는 수비대가 서지 않았다 → 보충 방아쇠도 없다). */
  garrison: number;
}

/** 레이드 요약 (디버그 · 스모크 — `EnemySystem.debugNests()`). */
export interface NestPlacement {
  /** 세운 알 수. */
  eggs: number;
  /** 둥지별 기록 (앵커 순번 = `Enemy.nestOf`). */
  nests: Array<{ pad: number; refills: number; garrison: number; x: number; z: number }>;
}

const _p = new THREE.Vector3();

export class NestDirector {
  private host: SpawnHost | null = null;
  private readonly nests: NestState[] = [];
  private readonly anchorList: THREE.Vector3[] = [];
  private checkT = 0;
  /** 레이드 요약 (권위 1회). */
  placement: NestPlacement | null = null;
  /** 이번 레이드의 실효 생태계 · 난이도 · ramp threat — 보충 무리 구성 (`EnemySystem` 이 `world:ready` 에서 넣는다). */
  eco: PlanetEcosystem | null = null;
  tuning: BugThreatTuning = bugThreatTuning(1);
  threat = 0.35;

  bind(host: SpawnHost): void { this.host = host; }

  /** `AmbientSpawner.initialPopulate` 가 「둥지」로 쓰는 앵커 (비어 있으면 예전처럼 `getNestPositions()` 를 쓴다). */
  get anchors(): readonly THREE.Vector3[] { return this.anchorList; }

  reset(): void {
    this.nests.length = 0;
    this.anchorList.length = 0;
    this.checkT = 0;
    this.placement = null;
  }

  /**
   * `world:ready` (권위, 훈련장 · 튜토리얼 제외) — 알을 세우고 둥지별 보충 횟수를 굴린다.
   * **`AmbientSpawner.initialPopulate` 보다 먼저** 불러야 한다 (앵커가 있어야 수비대가 둥지에 선다).
   */
  onWorldReady(): void {
    const host = this.host;
    const world = host?.ctx.world;
    this.reset();
    if (!host || !world?.ready) return;
    const spots = world.getNestEggSpots();
    if (spots.length === 0) return;           // 훈련장 · 튜토리얼 · 둥지 없는 맵

    // ① pad 별 무게중심 = 둥지 앵커
    const sum = new Map<number, { x: number; y: number; z: number; n: number }>();
    for (const s of spots) {
      const pad = s.nest;
      if (!Number.isInteger(pad) || pad < 0) continue;
      const acc = sum.get(pad) ?? { x: 0, y: 0, z: 0, n: 0 };
      acc.x += s.position.x; acc.y += s.position.y; acc.z += s.position.z; acc.n++;
      sum.set(pad, acc);
    }
    // ② 둥지별 보충 횟수 — 월드 시드의 제 스트림 (`named/Director` 와 같은 요령). pad 오름차순이라 굴림 순서가 늘 같다.
    const rng = new Random(Random.hash(`nest@${world.seed >>> 0}`));
    const placement: NestPlacement = { eggs: 0, nests: [] };
    for (const pad of [...sum.keys()].sort((a, b) => a - b)) {
      const acc = sum.get(pad)!;
      const anchor = new THREE.Vector3(acc.x / acc.n, 0, acc.z / acc.n);
      anchor.y = world.getHeightAt(anchor.x, anchor.z);
      const refills = rollRefills(rng);
      this.nests.push({ pad, anchor, refillsLeft: refills, garrison: 0 });
      this.anchorList.push(anchor);
      placement.nests.push({ pad, refills, garrison: 0, x: anchor.x, z: anchor.z });
    }

    // ③ 알 — 자리마다 한 마리
    for (const s of spots) if (this.spawnEgg(host, s)) placement.eggs++;
    this.placement = placement;
  }

  /**
   * 알 한 마리. 자리의 `position` 은 **그려진 구의 중심**이므로 발(= `Enemy.position`)은 그보다 `radius × EGG_CENTER_MUL`
   * 아래다. 크기는 여기서 넣지 않는다 — `parts/Pool.acquire` 가 권위 · 리플리카 **양쪽에서** `applyEggSize` 로 넣는다.
   */
  private spawnEgg(host: SpawnHost, spot: NestEggSpot): boolean {
    const base = ENEMY_STATS.bug_egg;
    const r = Number.isFinite(spot.radius) && spot.radius > 0 ? spot.radius : base.radius;
    // 자리 벡터는 월드의 살아 있는 항목이다 — 읽기만 하고 절대 바꾸지 않는다
    _p.set(spot.position.x, spot.position.y - r * EGG_CENTER_MUL, spot.position.z);
    return host.spawn('bug_egg', _p, Math.random() * Math.PI * 2, false, false) !== null;
  }

  /**
   * 앵커 `index` 에 방금 선 몸들(활성 목록에서 `from` 번째부터)을 그 둥지의 수비대로 묶는다 —
   * `Spawner.initialPopulate` 이 무리를 세운 직후에 부른다.
   */
  claimGarrison(index: number, host: SpawnHost, from: number): void {
    const nest = this.nests[index];
    if (!nest) return;
    const list = host.active;
    for (let i = from; i < list.length; i++) {
      const e = list[i];
      if (!e.active || e.isEgg || e.isHumanoid) continue;
      e.nestOf = index;
      e.nestReturning = false;
      e.guardPos.copy(nest.anchor);
      nest.garrison++;
    }
    const rec = this.placement?.nests[index];
    if (rec) rec.garrison = nest.garrison;
  }

  /**
   * 호스트 틱 (`EnemySystem.update` 의 권위 가지, 훈련장 · 튜토리얼 제외). `NEST_REFILL_CHECK_S` 마다 둥지별 생존 수를 세고
   * 방아쇠를 넘긴 둥지에 보충 한 번을 터뜨린다.
   */
  update(dt: number, host: SpawnHost): void {
    if (this.nests.length === 0) return;
    this.checkT -= dt;
    if (this.checkT > 0) return;
    this.checkT = Math.max(0.25, NEST_REFILL_CHECK_S);
    for (let i = 0; i < this.nests.length; i++) {
      const nest = this.nests[i];
      if (nest.refillsLeft <= 0 || nest.garrison <= 0) continue;
      if (countNestBugs(host, i) > Math.floor(nest.garrison * Math.max(0, NEST_REFILL_TRIGGER_FRAC))) continue;
      if (this.refill(host, nest, i)) nest.refillsLeft--;
    }
  }

  /** 보충 한 번 — 둥지에서 무리 하나가 파고 나온다 (순찰과 같은 `BURROW_EMERGE_S` 길). 한 마리도 못 세우면 횟수를 쓰지 않는다. */
  private refill(host: SpawnHost, nest: NestState, index: number): boolean {
    const types = ambientGroup(this.threat, this.eco, ambientOptsOf(this.tuning));
    if (types.length === 0) return false;
    const allowed = host.ensureCapacity(types.length, ambientCap(this.threat, this.eco));
    if (allowed <= 0) return false;
    const from = host.active.length;
    if (spawnGroup(host, types.slice(0, allowed), nest.anchor, false, false, undefined, BURROW_EMERGE_S) <= 0) return false;
    this.claimGarrisonOnly(index, host, from, nest);
    return true;
  }

  /** 보충으로 선 몸을 이 둥지에 묶는다 — `garrison`(방아쇠의 모수)은 **처음 깔린 수 그대로** 두어야 하므로 따로 둔다. */
  private claimGarrisonOnly(index: number, host: SpawnHost, from: number, nest: NestState): void {
    const list = host.active;
    for (let i = from; i < list.length; i++) {
      const e = list[i];
      if (!e.active || e.isEgg || e.isHumanoid) continue;
      e.nestOf = index;
      e.nestReturning = false;
      e.guardPos.copy(nest.anchor);
    }
  }

  /** 디버그 · 스모크: 둥지별 남은 보충 횟수 · 지금 살아 있는 수. */
  debugState(host: SpawnHost): Array<{ pad: number; anchorIndex: number; refillsLeft: number; garrison: number; alive: number }> {
    return this.nests.map((n, i) => ({ pad: n.pad, anchorIndex: i, refillsLeft: n.refillsLeft, garrison: n.garrison, alive: countNestBugs(host, i) }));
  }
}

/**
 * 알 한 마리의 **크기**를 그 자리의 반지름에 맞춘다 (`parts/Pool.acquire` 가 알 종류에만 부른다).
 *
 * 자리 목록에서 발 아래 (x, z) 가 가장 가까운 알자리를 골라 그 반지름을 쓴다 — 월드는 시드가 같으면 모든 클라이언트에서
 * 똑같이 만들어지므로 **호스트와 리플리카가 같은 답**을 얻는다. 그래서 `ee spawn` 에 반지름 칸을 더하지 않았다
 * (`BUG_HP_MUL_BY_THREAT` 가 체력 배수를 와이어 없이 맞추는 것과 같은 요령). 자리를 못 찾으면 csv 크기 그대로다.
 *
 * 몸(`rig.baseScale`)과 히트 캡슐(`stats.radius` / `height` / `headRadius`)에 **같은 배수**를 넣는다 — 알은
 * `EnemyStats` 를 개체마다 복사해 드는 유일한 종류라(`Enemy` 생성자) 다른 알 · 다른 종류에 번지지 않는다.
 * `hp` 는 크기와 무관하다 (csv 한 줄) — 작은 알이라고 약하지 않다.
 */
export function applyEggSize(e: Enemy, world: WorldRef): void {
  const base = ENEMY_STATS.bug_egg;
  const spots = world.getNestEggSpots();
  let best = -1, bestD = Infinity;
  for (let i = 0; i < spots.length; i++) {
    const p = spots[i].position;
    const dx = p.x - e.position.x, dz = p.z - e.position.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  const raw = best >= 0 ? spots[best].radius : base.radius;
  const r = Number.isFinite(raw) && raw > 0 ? raw : base.radius;
  const k = r / Math.max(0.05, base.radius);
  e.stats.radius = base.radius * k;
  e.stats.height = base.height * k;
  e.stats.headRadius = base.headRadius * k;
  if (e.rig.kind === 'egg') { setEggScale(e.rig, r); e.rig.root.scale.setScalar(e.rig.baseScale); }
}

/** `NEST_REFILL_COUNT_CHANCE` 한 번 굴림 → 이번 레이드에 그 둥지가 할 수 있는 보충 횟수 (index k = k+1 회). */
function rollRefills(rng: Random): number {
  const table = NEST_REFILL_COUNT_CHANCE;
  let total = 0;
  for (const w of table) if (Number.isFinite(w) && w > 0) total += w;
  if (total <= 0) return 0;
  let r = rng.next() * total;
  for (let i = 0; i < table.length; i++) {
    const w = Number.isFinite(table[i]) && table[i] > 0 ? table[i] : 0;
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return i + 1;
  }
  return table.length;
}

/** 그 둥지에 딸린 **살아 싸우는** 벌레 수 (알은 `isCombatant` false 라 빠진다 — `Enemy.isEgg`). */
function countNestBugs(host: SpawnHost, index: number): number {
  const list = host.active;
  let n = 0;
  for (let i = 0; i < list.length; i++) if (list[i].nestOf === index && list[i].isCombatant) n++;
  return n;
}
