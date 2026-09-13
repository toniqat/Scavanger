/**
 * src/world/Hazard.ts — **환경 재해** (`HazardRef`, 게시: `ctx.world.hazard`).
 *
 * 레이드 시작 뒤 `HAZARD_START_MIN_S`–`HAZARD_START_MAX_S` 사이 **30초 단위**의 한 시각(독성 포자만
 * `SPORE_START_S` 고정)에 시작해 `HAZARD_FULL_S` 에 걸쳐 맵을 덮는 행성 현상이다. 안에 있으면
 * `HAZARD_TICK_S` 마다 `HAZARD_DPS` 만큼 깎이고 시야가 좁아지며, 끝까지 가면 안전지대가 사라진다 —
 * 사실상 강제 탈출 타이머다.
 *
 * **평상시 와이어가 없다.** 종류 · 시작 시각 · 도형이 전부 `미션 시드 + missionTime` 의 함수이므로
 * 모든 클라이언트가 같은 답을 낸다 (`Fog` 와 같은 철학). 늦게 합류한 사람만 `hzq sync` → 호스트의
 * `hz sync {data}`(= `serialize()`) 로 계획을 받는다.
 *
 * 소유 계약: `HazardKind` · `HazardZone` · `HazardSource` · `HazardRef` · `WorldRef.hazard`,
 * `hazard:planned / announced / started / progress / insideChanged`, `atmo:override`,
 * `HazardMessage`(`hz`) / `HazardRequest`(`hzq`), `HAZARD_*` · `STORM_EYE_*` · `SPORE_*` 상수,
 * `PlanetDef.hazards` (`data/planets.csv`). 그림 수치는 `data/hazards.csv` (`hazard/model.ts` 가 읽는다).
 *
 * 시야 제한은 **`atmo:override` 로만** 한다 — `core/Atmosphere` 가 그 하나를 받아 포그 · 하늘에 얹는다.
 * `src/core/` 는 건드리지 않는다.
 */
import * as THREE from 'three';
import {
  HAZARD_DPS, HAZARD_DPS_MAX, HAZARD_EDGE_M, HAZARD_FOG_MUL, HAZARD_FOG_RAMP_END, HAZARD_FOG_RAMP_START, HAZARD_TICK_S,
  HAZARD_WARN_S, Random,
  type GameContext, type HazardKind, type HazardRef, type HazardSource, type HazardZone, type PeerId,
} from '@/shared';
import type { BuildCtx } from './build';
import { ATMO_EPS, PROGRESS_EMIT_S, type HazardPlan, type HazardRow, hazardRow } from './hazard/model';
import { HAZARD_FORK, drawHazardKind, planGroveSpots, planHazard } from './hazard/parts/Plan';
import { buildZones, maxDepth, progressAt } from './hazard/parts/Zones';
import { Groves } from './hazard/parts/Grove';
import { HazardVisuals } from './hazard/parts/Visuals';

/** 군락 발견 판정 주기(초). 안개는 5 Hz 로 칠해지므로 이보다 자주 볼 이유가 없다. */
const DISCOVER_INTERVAL_S = 0.5;
/** 구역 안에서 진행도 때문에만 시야 배수가 바뀔 때 `atmo:override` 를 다시 내는 최소 변화폭 (2026-09-13). */
const FOG_MUL_EPS = 0.1;

/** 2026-09-13 — 진행도 `progress` 에서의 초당 피해: `HAZARD_DPS`(시작) → `HAZARD_DPS_MAX`(맵을 다 덮었을 때) 선형. */
function dpsAt(progress: number): number {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return HAZARD_DPS + (HAZARD_DPS_MAX - HAZARD_DPS) * p;
}

export class Hazard implements HazardRef {
  private plan: HazardPlan | null = null;
  private row: HazardRow | null = null;
  private game: GameContext | null = null;
  private root: THREE.Group | null = null;

  private readonly groves = new Groves();
  private readonly visuals = new HazardVisuals();
  /** `spores` 후보가 있는 행성에서 잡아 둔 군락 자리 (`Gather` 가 그 주위에 채집 버섯을 심는다). */
  private groveSpots: Array<{ x: number; z: number }> = [];

  /** `getZones()` 가 돌려주는 배열과 그 도형 풀 (프레임당 할당 0). */
  private readonly zones: HazardZone[] = [];
  private readonly zonePool: HazardZone[] = [];
  private zonesAt = -1;
  private readonly sources: HazardSource[] = [];
  /** 이미 `fog:discovered` 를 낸 군락 id. */
  private readonly discovered = new Set<string>();

  private announcedFlag = false;
  private startedFlag = false;
  private insideFlag = false;
  private damageTimer = 0;
  /** 2026-09-11 (C-14): 끊긴 분대원(고스트) 피해 틱 — 로컬 틱과 따로 돈다. */
  private ghostTimer = 0;
  private progressTimer = 0;
  private lastProgress = -1;
  private discoverTimer = 0;
  private lastBlend = 0;
  /** 마지막으로 보낸 `atmo:override.fogMul` (2026-09-13 — 진행도 램프 때문에 blend 가 그대로여도 바뀐다). */
  private lastFogMul = 1;

  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /**
   * `candidates` = `PlanetDef.hazards` (행성별 후보). 빈 배열이면 아무것도 만들지 않고 **false** 를
   * 돌려준다 — 호출부(`WorldSystem`)는 그때 `ctx.world.hazard` 를 null 로 남긴다.
   *
   * 소품 · 상자보다 **먼저** 불러야 한다: 거대 버섯 줄기가 `SpatialHash` 에 들어가야 `isSpotFree` 가
   * 군락 자리를 피한다 (군락 한가운데 바위가 서지 않게).
   */
  build(ctx: BuildCtx, game: GameContext, candidates: readonly HazardKind[]): boolean {
    this.game = game;
    this.root = ctx.root;
    if (candidates.length === 0) return false;

    const biomeId = ctx.biome?.id ?? null;
    /* 2026-09-13: 이번 레이드의 종류는 **레이아웃보다 먼저** 정해졌다 — `WorldSystem` 이 같은 함수로 뽑아 독성 포자면 중앙 강하 ·
     * 외곽 패드를 골랐다. 여기서 다시 뽑아도 같은 값이다 (루트의 `'hazard'` fork 첫 draw). */
    const drawn = drawHazardKind(ctx.rng, candidates, biomeId);
    // 군락 자리는 재해 추첨과 **독립적인 fork** 다. 이번 레이드가 독성 포자면 맵 중앙에, 아니면 맵 전체에 흩어진다 (2026-09-13)
    if (candidates.includes('spores')) {
      this.groveSpots = planGroveSpots(ctx, ctx.rng.fork('hazardGroves'), drawn === 'spores');
      this.groves.build(ctx, ctx.rng.fork('hazardGroveMesh'), this.groveSpots);
    }

    // 2026-09-10: 지형(biome)을 함께 넘긴다 — 눈 덮인 지형이면 모래 폭풍이 눈보라로 바뀐다 (`Plan.SNOWY_BIOMES`).
    // 2026-09-13: 강하 지점도 넘긴다 — 모래 폭풍 · 눈보라 전선이 그쪽 가장자리에서 들어온다.
    const plan = planHazard(ctx.rng.fork(HAZARD_FORK), candidates, this.groveSpots, biomeId, ctx.layout.spawn);
    if (!plan) return false;
    this.plan = plan;
    this.row = hazardRow(plan.kind) ?? null;
    if (this.row) {
      this.visuals.build(ctx.root, this.row, plan, HazardVisuals.ringsFor(plan));
      this.visuals.warm(game.shaders);
    }
    this.rebuildSources();
    this.ensureNet();
    this.requestSync();

    game.bus.emit('hazard:planned', { kind: plan.kind, startsAt: plan.startsAt });
    return true;
  }

  /**
   * `WorldRef.hazard` 가 돌려줄 값. 계획이 없으면(후보 없는 행성 · 자리를 못 잡은 시드) null 이다 —
   * 그래도 이 객체 자체는 살아 있다 (군락은 지형지물이라 재해가 없어도 서 있을 수 있다).
   */
  get ref(): HazardRef | null { return this.plan ? this : null; }

  /** 군락 자리 (`Gather` 가 이 주위에 채집 버섯을 심는다). 재해가 포자가 아니어도 군락은 서 있을 수 있다. */
  getGroveSpots(): ReadonlyArray<{ x: number; z: number }> { return this.groveSpots; }

  dispose(): void {
    // 나가면서 대기 오버라이드를 반드시 되돌린다 — 안 그러면 다음 미션까지 시야가 좁은 채로 간다
    if (this.lastBlend > 0) this.game?.bus.emit('atmo:override', { fogMul: 1, color: null, blend: 0 });
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.visuals.dispose();
    this.groves.dispose();
    this.groveSpots = [];
    this.zones.length = 0;
    this.zonePool.length = 0;
    this.sources.length = 0;
    this.discovered.clear();
    this.zonesAt = -1;
    this.announcedFlag = false;
    this.startedFlag = false;
    this.lastProgress = -1;
    this.progressTimer = 0;
    this.damageTimer = 0;
    this.ghostTimer = 0;
    this.discoverTimer = 0;
    this.plan = null;
    this.row = null;
    this.game = null;
    this.root = null;
    this.lastBlend = 0;
    this.lastFogMul = 1;
    this.insideFlag = false;
  }

  /* ── HazardRef ─────────────────────────────────────────────────────── */

  get kind(): HazardKind | null { return this.plan?.kind ?? null; }
  get startsAt(): number { return this.plan?.startsAt ?? -1; }
  get announced(): boolean { return this.announcedFlag; }
  get active(): boolean {
    const p = this.plan;
    return !!p && !!this.game && this.game.missionTime >= p.startsAt;
  }
  get progress(): number {
    const p = this.plan;
    return p && this.game ? progressAt(p, this.game.missionTime) : 0;
  }
  /** 2026-09-13: 지금 초당 피해 / `HAZARD_DPS` — 1 → `HAZARD_DPS_MAX / HAZARD_DPS` (적의 조용한 피해가 곱한다). */
  get damageMul(): number {
    return HAZARD_DPS > 0 ? dpsAt(this.progress) / HAZARD_DPS : 1;
  }

  isInside(x: number, z: number): boolean {
    if (!this.active) return false;
    return maxDepth(this.getZones(), x, z) > 0;
  }

  getZones(): readonly HazardZone[] {
    const p = this.plan;
    const t = this.game?.missionTime ?? 0;
    if (!p) return this.zones;
    if (t !== this.zonesAt) {
      this.zonesAt = t;
      buildZones(p, t, this.zonePool, this.zones);
    }
    return this.zones;
  }

  getSources(): readonly HazardSource[] {
    return this.plan?.kind === 'spores' ? this.sources : EMPTY_SOURCES;
  }

  /* ── 매 프레임 ─────────────────────────────────────────────────────── */

  update(dt: number, ctx: GameContext): void {
    const plan = this.plan;
    if (!plan) return;
    this.ensureNet();
    this.groves.update(ctx.time);

    const t = ctx.missionTime;
    const active = t >= plan.startsAt;

    // 예고 → 시작
    if (!this.announcedFlag && t >= plan.startsAt - HAZARD_WARN_S) {
      this.announcedFlag = true;
      const left = Math.max(0, Math.round(plan.startsAt - t));
      ctx.bus.emit('hazard:announced', { kind: plan.kind, secondsLeft: left });
    }
    if (!this.startedFlag && active) {
      this.startedFlag = true;
      this.announcedFlag = true;
      ctx.bus.emit('hazard:started', { kind: plan.kind });
    }

    const zones = this.getZones();

    // 진행도 — 초당 몇 번만 (계약 주석)
    const pr = progressAt(plan, t);
    if (active) {
      this.progressTimer -= dt;
      if (this.progressTimer <= 0 && Math.abs(pr - this.lastProgress) > 1e-4) {
        this.progressTimer = PROGRESS_EMIT_S;
        this.lastProgress = pr;
        ctx.bus.emit('hazard:progress', { kind: plan.kind, progress: pr });
      }
    }

    // 발생지 상태 (피어올랐나 · 안개가 걷혀 아는 자리인가)
    this.discoverTimer -= dt;
    if (this.discoverTimer <= 0) {
      this.discoverTimer = DISCOVER_INTERVAL_S;
      this.refreshSources(ctx, t);
    }

    // 피해 · 시야
    const p = ctx.player;
    const alive = !!p && !p.isDead && !p.isInShip && !p.isDropping;
    const playable = alive && ctx.isGameplayPhase() && !ctx.isTraining();
    const depth = p ? maxDepth(zones, p.position.x, p.position.z) : -Infinity;
    const inside = active && playable && depth > 0;

    if (inside !== this.insideFlag) {
      this.insideFlag = inside;
      ctx.bus.emit('hazard:insideChanged', { inside, kind: inside ? plan.kind : null });
    }

    if (inside && p) {
      this.damageTimer += dt;
      // 프레임이 길게 튀어도 정확히 `HAZARD_TICK_S` 마다 한 번씩만 깎는다
      while (this.damageTimer >= HAZARD_TICK_S) {
        this.damageTimer -= HAZARD_TICK_S;
        // 2026-09-13: 재해는 시간에 따라 강해진다 — 진행도 0 에서 `HAZARD_DPS`, 1 에서 `HAZARD_DPS_MAX`
        p.takeDamage(dpsAt(pr) * HAZARD_TICK_S);
      }
    } else {
      this.damageTimer = 0;
    }

    this.tickGhosts(dt, ctx, active, zones, pr);

    // 경계에서 `HAZARD_EDGE_M` 에 걸쳐 0 → 1. `insideChanged` 와 **같은 조건**으로 잠근다 — 죽었거나
    // 함선 안인데 화면만 뿌예지면 HUD 의 "위험 구역" 표시와 어긋난다.
    const raw = active && playable && depth > -Infinity ? depth / (HAZARD_EDGE_M > 0 ? HAZARD_EDGE_M : 1) : 0;
    const blend = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
    // 2026-09-10: 시야 제한의 세기는 **재해마다 다르다** (`data/hazards.csv` 의 fogMul). 폭풍의 눈은
    // 폭풍 안에서 PC 주변만 보이도록 훨씬 크다 — 그래야 "저기 벽 안쪽이 안전지대" 가 읽힌다.
    // `HAZARD_FOG_MUL` 은 줄을 못 찾았을 때의 기본값으로만 남았다.
    // 2026-09-13: 그 세기가 **진행도에 따라 오른다** — (fogMul − 1) 에 `HAZARD_FOG_RAMP_START` → `END` 를 곱한다.
    const baseFog = this.row ? this.row.fogMul : HAZARD_FOG_MUL;
    const ramp = HAZARD_FOG_RAMP_START + (HAZARD_FOG_RAMP_END - HAZARD_FOG_RAMP_START) * pr;
    const peak = Math.max(1, 1 + (baseFog - 1) * ramp);
    const fogMul = 1 + (peak - 1) * blend;
    if (Math.abs(blend - this.lastBlend) > ATMO_EPS || (blend === 0 && this.lastBlend !== 0)
      || (blend > 0 && Math.abs(fogMul - this.lastFogMul) > FOG_MUL_EPS)) {
      this.lastBlend = blend;
      this.lastFogMul = fogMul;
      ctx.bus.emit('atmo:override', {
        fogMul,
        color: blend > 0 && this.row ? this.row.fogColor : null,
        blend,
      });
    }

    this.visuals.update(dt, ctx.time, ctx.camera, zones, this.lastBlend, active, pr);
  }

  /**
   * 2026-09-11 (C-14 · X-7) — **끊긴 분대원의 몸(고스트)도 재해를 맞는다.** 예전에는 위의 로컬 판정뿐이라, 소켓이
   * 끊긴 사람의 몸은 폭풍 한가운데서 레이드가 끝날 때까지 멀쩡했다.
   *
   * 고스트는 **권위(싱글 · 호스트)가 시뮬레이션**하고 피해 입구는 적 공격과 같은 `ghost:damage` 하나다
   * (`player/RemotePlayerSystem.damageGhost` — 실드 → 체력 → 전투불능 → 사망 순서가 거기 있다). 그래서 여기서는
   * `HAZARD_TICK_S` 마다 `suspended` 이면서 구역 안인 분대원에게 그 이벤트를 낼 뿐이다. 새 와이어는 없다 —
   * 결과는 호스트의 `ghost state` 가 이미 방송한다. 로컬 틱과 **다른 타이머**다: 호스트 자신이 죽었거나 함선에
   * 있어도 끊긴 사람의 몸은 계속 맞는다. 적의 조용한 DoT 는 `enemies/` 소관이다.
   */
  private tickGhosts(dt: number, ctx: GameContext, active: boolean, zones: readonly HazardZone[], progress: number): void {
    const net = ctx.net;
    if (!active || !net || !ctx.isAuthority || !ctx.isGameplayPhase() || ctx.isTraining()) { this.ghostTimer = 0; return; }
    this.ghostTimer += dt;
    if (this.ghostTimer < HAZARD_TICK_S) return;
    // 프레임이 길게 튀어도 틱 수만큼 정확히 — 로컬 피해의 `while` 과 같은 합계를 한 이벤트에 싣는다
    const ticks = Math.floor(this.ghostTimer / HAZARD_TICK_S);
    this.ghostTimer -= ticks * HAZARD_TICK_S;
    const amount = dpsAt(progress) * HAZARD_TICK_S * ticks;   // 2026-09-13: 로컬 피해와 같은 램프
    const refs = net.getRemotePlayers();
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      if (!r.suspended || !r.inMission || r.isDead || r.ghostState === 2) continue;
      if (maxDepth(zones, r.position.x, r.position.z) <= 0) continue;
      ctx.bus.emit('ghost:damage', { id: r.id, amount });
    }
  }

  /* ── 발생지 (거대 버섯 군락) ───────────────────────────────────────── */

  private rebuildSources(): void {
    this.sources.length = 0;
    const plan = this.plan;
    if (!plan) return;
    for (let i = 0; i < plan.sources.length; i++) {
      const s = plan.sources[i];
      this.sources.push({
        id: `grove_${i}`,
        position: new THREE.Vector3(s.x, 0, s.z),
        radius: plan.sourceRadius,
        erupted: false,
        discovered: false,
      });
    }
  }

  /**
   * 발생지 상태를 갱신하고, **군락이 처음 안개 밖으로 나오면** `fog:discovered {kind:'grove'}` 를 낸다.
   * 토스트는 띄우지 않는다 — 그 문구는 ui/ 소유다 (`Fog.TOAST` 에 `grove` 를 넣지 않는 것과 같은 이유).
   *
   * 사용자 요구: 군락을 **전부 발견하면** 6분 뒤 어디서 포자가 시작될지 미리 안다. 그래서 `discovered` 는
   * 재해 종류와 무관하게 안개만 본다.
   */
  private refreshSources(ctx: GameContext, missionTime: number): void {
    const fog = ctx.world?.fog ?? null;
    const plan = this.plan;
    // 군락은 재해가 포자가 아니어도 서 있다 — 발견 이벤트는 그때도 낸다 (지형지물이므로)
    for (const g of this.groves.getDefs()) {
      if (this.discovered.has(g.id)) continue;
      if (fog && !fog.isDiscovered(g.position)) continue;
      this.discovered.add(g.id);
      ctx.bus.emit('fog:discovered', { kind: 'grove', id: g.id, position: g.position });
    }
    if (!plan) return;
    const defs = this.groves.getDefs();
    for (let i = 0; i < this.sources.length; i++) {
      const src = this.sources[i];
      const p = plan.sources[i];
      if (!p) continue;
      // 군락이 세워졌으면 그 지형 높이를 그대로 쓴다 (지도는 xz 만 보지만 월드 마커는 y 를 본다)
      const def = defs[i];
      if (def) src.position.y = def.position.y;
      src.erupted = missionTime >= p.eruptAt;
      src.discovered = fog ? fog.isDiscovered(src.position) : true;
    }
  }

  /* ── 멀티플레이 (늦게 합류한 사람만) ───────────────────────────────── */

  serialize(): string {
    return this.plan ? JSON.stringify(this.plan) : '';
  }

  /**
   * 호스트의 계획을 그대로 받아 쓴다. 같은 시드 · 같은 행성이면 이미 같은 값이라 아무 것도 바뀌지 않는다 —
   * 이 경로는 시드가 어긋난 클라이언트(구버전 피어 · 손댄 세이브)를 위한 안전망이다.
   */
  applySerialized(data: string): void {
    if (!data) return;
    let next: HazardPlan | null = null;
    try { next = JSON.parse(data) as HazardPlan; } catch { return; }
    if (!next || typeof next.kind !== 'string' || !Number.isFinite(next.startsAt)) return;
    if (!Array.isArray(next.sources)) next.sources = [];
    const prev = this.plan;
    if (prev && prev.kind === next.kind && prev.startsAt === next.startsAt && prev.sources.length === next.sources.length) {
      this.plan = next;
      this.zonesAt = -1;
      this.rebuildSources();
      return;
    }
    this.plan = next;
    this.zonesAt = -1;
    this.rebuildSources();
    const row = hazardRow(next.kind) ?? null;
    this.row = row;
    // 종류 자체가 다르면 벽 · 입자를 다시 만든다 (군락은 지형이라 그대로 둔다 — 아래 README 의 한계)
    if (row && this.root) {
      this.visuals.dispose();
      this.visuals.build(this.root, row, next, HazardVisuals.ringsFor(next));
      this.visuals.warm(this.game?.shaders);
    }
    console.warn(`[Hazard] 호스트의 계획으로 교체했다 — ${next.kind} @ ${next.startsAt}s`);
  }

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('hz', (m) => {
        if (m.ev === 'sync' && !ctx.net?.isHost) this.applySerialized(m.data);
      }),
      net.onMessage('hzq', (m, from) => {
        if (m.ev === 'sync' && ctx.net?.isHost) this.sendSync(from);
      }),
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from);
      }),
      // 승격된 호스트의 계획이 정답이 된다 — Fog / Gather 와 같은 규약
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'hzq', ev: 'sync' }, 'host');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !this.plan) return;
    net.send({ t: 'hz', ev: 'sync', data: this.serialize() }, to);
  }

  /* ── 디버그 / 스모크 ───────────────────────────────────────────────── */

  /** 스모크가 시간을 앞당기지 않고도 도형을 확인할 수 있게 하는 계획 사본. */
  get debugPlan(): Readonly<HazardPlan> | null { return this.plan; }
  /** 같은 시드에서 계획이 재현되는지 스모크가 확인하는 값. */
  static debugPlanFor(seed: number, candidates: readonly HazardKind[], spots: ReadonlyArray<{ x: number; z: number }>): HazardPlan | null {
    return planHazard(new Random(seed >>> 0).fork('hazard'), candidates, spots);
  }
}

const EMPTY_SOURCES: readonly HazardSource[] = [];
