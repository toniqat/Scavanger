/**
 * src/enemies/sandworm/Director.ts — **지하벌레 이벤트 디렉터** (2026-09-13).
 *
 * 이 파일이 답하는 질문: *이번 레이드에 지하벌레가 나오는가, 언제 · 어디서, 나온 뒤에는 무엇을 하나.*
 *
 * ## 굴림 (레이드당 최대 1회 · 모든 클라이언트가 같은 답)
 * `EnemySystem` 의 `world:ready` 가 `onWorldReady` 를 부른다. 시드 스트림 `worldSeed ^ hash('sandworm')` 에서 차례로
 *   ① 등장 여부 `SANDWORM_CHANCE_BY_THREAT[행성 threat − 1]` (threat 1 = 0 · 2 = 낮음 · 3 = 높음, `data/tables.csv`),
 *   ② 발동 시각 = 창(`SANDWORM_WINDOW_START_S..END_S`, `ctx.missionTime`)의 앞쪽 절반 안
 * 을 뽑는다. 리플리카도 똑같이 굴려 두므로 호스트가 바뀌어도 새 호스트가 같은 계획을 이어받는다.
 * 굴림이 성공한 레이드는 지하벌레 리그 하나를 미리 만들어 풀에 넣고 `ctx.shaders.warm` 한다 (분출 순간 컴파일 없음).
 *
 * ## 발동 (호스트)
 * 발동 시각이 지나면 `SANDWORM_CHECK_S` 마다 조건을 본다 — 창이 끝날 때까지 안 맞으면 이번 레이드에는 없다.
 *  - 싱글(또는 분대에 나 혼자): 인원수와 상관없이 그 플레이어 발밑.
 *  - 멀티: 살아 있는 플레이어 **둘 이상**이 서로 `SANDWORM_GROUP_RADIUS` 안에 모여 있을 때, 가장 큰 무리의 **한가운데** 발밑.
 *  - 그 자리가 구조물 발자국 · 선로 데크 · 지붕 · 전차 위(= 무리 중 누구라도 지형보다 1.2 m 이상 높이 서 있다) · 바위 위면 이번 검사는 건너뛴다.
 *
 * ## 순서
 *   전조 `SANDWORM_WARN_S`(5 s): `ee wormWarn` → 모든 클라이언트가 분진 · 흙 파임(점점 거세짐) · 피해 반경 링 · 거리에 따라
 *   약 → 강으로 오르는 흔들림 · 토스트 「지상이변 발생」 · 땅울림.
 *   → 분출: 반경 `SANDWORM_ERUPT_RADIUS` 안 플레이어에 피해 + 넉백(`applyDamage` — 로컬은 직접, 원격은 `dmg.kb`, 끊긴 사람은
 *   `ghost:damage`) · 다른 팩션 적 · 드론 · 지하벌레 스폰(`ee spawn` + `em` = 솟아오름, 최대 체력은 호스트가 굴려 `ee wormErupt.hp`)
 *   · 분대 인원만큼 버그 무리가 파고 나온다(`SANDWORM_BURST_BY_SQUAD`).
 *   → 버그 뱉기 `SANDWORM_SPIT_PHASE_S`(30 s): 입에서 `SANDWORM_SPIT_COUNT` 마리씩 포물선으로 뱉는다(`ee wormSpit`, 생존 상한
 *   `SANDWORM_ALIVE_CAP`). **먼저 죽이면 더 뱉지 않는다.**
 *   → 독극물: 땅에 박힌 채 `SANDWORM_ACID_RANGE` 안의 가장 가까운 플레이어에게 산성 연발(기존 `ee acid` · `ee acidAt`).
 * 죽으면 보스급 시체(`loot_corpses.csv` 의 `sandworm`)가 남고 킬 · 분대 킬 · 계약은 기존 경로 그대로다.
 *
 * ## 늦은 합류 · 재접속 · 호스트 이관
 * `flow rejoined` 를 받은 호스트가 `resync()` — 진행 중인 전조(남은 eta), 살아 있는 지하벌레마다 `wormErupt {sy: 1}`(최대 체력 ·
 * 남은 뱉기 시간), 이미 끝났으면 `wormErupt {id: 0, sy: 1}`(끝났다는 표식). 리플리카는 받은 값을 지하벌레에 적어 두므로
 * (`Enemy.wormSpitUntil` · `maxHp`) 승격되면 그대로 이어서 돌린다. 진행 중인 전조도 새 호스트가 분출시킨다.
 *
 * 수치는 전부 csv 다. 이 파일의 상수는 연출 박자(흔들림 틱 · 입 벌림 준비 시간) · 산성 흩뿌림 · 행성 없는 미션의 구성 가중치뿐이다.
 */
import * as THREE from 'three';
import {
  BURROW_EMERGE_S, PLAYER_RADIUS, Random, planetThreat,
  SANDWORM_ACID_INTERVAL_S, SANDWORM_ACID_RANGE, SANDWORM_ACID_VOLLEY, SANDWORM_ALERT_RADIUS, SANDWORM_ALIVE_CAP,
  SANDWORM_BURST_BY_SQUAD, SANDWORM_BURST_RING_MAX, SANDWORM_BURST_RING_MIN, SANDWORM_CHANCE_BY_THREAT, SANDWORM_CHECK_S,
  SANDWORM_ERUPT_DAMAGE, SANDWORM_ERUPT_KNOCKBACK, SANDWORM_ERUPT_RADIUS, SANDWORM_GROUP_RADIUS, SANDWORM_HP_MAX, SANDWORM_HP_MIN,
  SANDWORM_RISE_S, SANDWORM_SHAKE_MAX, SANDWORM_SPIT_COUNT, SANDWORM_SPIT_FLIGHT_S, SANDWORM_SPIT_INTERVAL_S, SANDWORM_SPIT_MAX_M,
  SANDWORM_SPIT_MIN_M, SANDWORM_SPIT_PHASE_S, SANDWORM_WARN_S, SANDWORM_WINDOW_END_S, SANDWORM_WINDOW_START_S,
  type EnemyEvent, type EnemyType, type PlanetEcosystem, type PlanetId,
} from '@/shared';
import { Enemy } from '../Enemy';
import { ENEMY_STATS } from '../EnemyTypes';
import { ecoAllows, pickEcoType, spawnBlocked } from '../Spawner';
import type { CombatTarget } from '../Targets';
import { turnToward, yawTo } from '../ai/Steering';
import { round, tuple } from '../net/HostSync';
import { isVec3Tuple } from '../model';
import { applyWormHint, WORM_HINT_ACID, WORM_HINT_SPIT } from './Pose';
import type { EnemySystem } from '../EnemySystem';

/** 뱉기 · 분출 무리의 종류 후보 (행성 생태계 가중치로 뽑는다). 포병 · 차저 · 베헤모스는 뱉기에 너무 크다. */
const SPIT_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'toxic'];
/** 행성이 없는 미션(`eco` null)에서 쓰는 같은 순서의 가중치. */
const SPIT_FALLBACK: readonly number[] = [5, 2, 1.2, 1, 0.8];
/** 분대 정원 — `RogueDrop` · `WaveDirector` 와 같은 값. */
const MAX_SQUAD = 4;
/** 전조 흔들림을 더하는 간격(초) — `camera:shake` 는 trauma 를 **더하므로** 이 박자가 세기의 단위다. */
const WARN_SHAKE_TICK_S = 0.2;
/** 뱉기 · 독극물 직전 입을 벌리는 시간(초) — 와이어 힌트 21 / 22 가 이만큼 먼저 선다. */
const SPIT_WINDUP_S = 0.7;
const ACID_WINDUP_S = 0.6;
/** 독극물 연발의 두 번째부터 표적 주변에 흩뿌리는 반경(m). */
const ACID_SCATTER_MIN = 2.5;
const ACID_SCATTER_MAX = 5;
/** 리플리카: 분출 방송을 못 받은 전조를 이만큼 뒤에 스스로 거둔다(초). */
const REPLICA_WARN_TIMEOUT_S = 3;
/** 발동 자리 검사: 무리 중 누가 지형보다 이만큼 높이 서 있으면 (데크 · 지붕 · 전차) 건너뛴다(m). */
const OFF_TERRAIN_M = 1.2;
/** 발동 자리 바로 위에 올라설 수 있는 소품(바위)이 이만큼 솟아 있으면 건너뛴다(m). */
const PROP_ON_SPOT_M = 0.6;

const TOAST_WARN = '지상이변 발생 — 발밑에서 무언가 파고 올라온다!';
const TOAST_KILLED = '지하벌레 처치 — 사체를 수색할 수 있다';

const TWO_PI = Math.PI * 2;
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _mouth = new THREE.Vector3();
const _erupt = new THREE.Vector3();

/** 이번 레이드의 굴림 (`EnemySystem.debugSandwormState.plan`). */
export interface SandwormPlan {
  /** 굴림이 성공했는가 (이 레이드에 발동 조건 검사를 한다). */
  rolled: boolean;
  /** 행성 threat (1..3). */
  threat: number;
  chance: number;
  /** 굴린 값 (0..1, `< chance` 면 성공). */
  roll: number;
  /** 조건 검사를 시작하는 `ctx.missionTime`(초). */
  triggerAt: number;
}

function emptyPlan(): SandwormPlan {
  return { rolled: false, threat: 1, chance: 0, roll: 1, triggerAt: Infinity };
}

export class SandwormDirector {
  private sys!: EnemySystem;
  private plan: SandwormPlan = emptyPlan();
  private eco: PlanetEcosystem | null = null;
  /** 이번 레이드의 이벤트가 이미 시작됐다 (레이드당 최대 1회 — 리플리카는 방송을 받으면 켠다). */
  private done = false;
  private checkTimer = 0;
  private readonly warn = { active: false, p: new THREE.Vector3(), startedAt: 0, eruptAt: 0, shakeAcc: 0 };
  /** 콘솔 · 스모크가 바꾼 다음 분출의 뱉기 단계 길이(초), null = csv. */
  private forcedSpitS: number | null = null;
  /** 리플리카: `wormErupt` 로 받은 최대 체력 · 뱉기 종료 시각 — 그 적이 생기면 적용하고 지운다. */
  private readonly meta = new Map<number, { hp: number; spitUntil: number }>();
  /* 디버그 · 스모크 카운터 (이 클라이언트 기준) */
  warnings = 0;
  eruptions = 0;
  spitVolleys = 0;
  acidVolleys = 0;
  warnShakes = 0;

  bind(sys: EnemySystem): void { this.sys = sys; }

  /** 레이드 리셋 (`Pool.reset`). */
  reset(): void {
    this.plan = emptyPlan();
    this.eco = null;
    this.done = false;
    this.checkTimer = 0;
    this.warn.active = false;
    this.forcedSpitS = null;
    this.meta.clear();
    this.warnings = 0; this.eruptions = 0; this.spitVolleys = 0; this.acidVolleys = 0; this.warnShakes = 0;
  }

  /* ── 굴림 ─────────────────────────────────────────────────────────────── */
  /** `world:ready` (권위 · 리플리카 모두). 훈련장이면 계획이 없다. */
  onWorldReady(planet: PlanetId | null, eco: PlanetEcosystem | null, training: boolean): void {
    const ctx = this.sys?.ctx;
    const world = ctx?.world;
    this.eco = eco;
    this.plan = emptyPlan();
    if (!ctx || training || ctx.isTraining() || !world?.ready) return;
    const threat = planetThreat(planet);
    const raw = SANDWORM_CHANCE_BY_THREAT[threat - 1];
    let chance = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    if (eco && !SPIT_TYPES.some((t) => ecoAllows(eco, t))) chance = 0;   // 벌레가 안 사는 행성
    const rng = new Random((((world.seed >>> 0) ^ Random.hash('sandworm')) >>> 0) || 1);
    const roll = rng.next();
    const span = Math.max(0, SANDWORM_WINDOW_END_S - SANDWORM_WINDOW_START_S);
    const triggerAt = SANDWORM_WINDOW_START_S + rng.next() * span * 0.5;
    this.plan = { rolled: roll < chance, threat, chance, roll, triggerAt };
    if (this.plan.rolled) this.prewarm();
  }

  /** 지하벌레 리그 하나를 풀에 미리 만들어 숨긴 채 씬에 넣고 셰이더를 걸어 둔다 (`acquire` 가 그대로 꺼내 쓴다). */
  private prewarm(): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    let pool = sys.pools.get('sandworm');
    if (!pool) { pool = []; sys.pools.set('sandworm', pool); }
    if (pool.length === 0) {
      const e = new Enemy('sandworm');
      e.bindHost(sys);
      pool.push(e);
    }
    const root = pool[pool.length - 1].rig.root;
    if (!root.parent) ctx.scene.add(root);
    void ctx.shaders?.warm(root);
  }

  /* ── 프레임 ───────────────────────────────────────────────────────────── */
  update(dt: number): void {
    const sys = this.sys;
    const ctx = sys?.ctx;
    if (!ctx?.world?.ready) return;
    if (this.warn.active) this.tickWarn(dt);
    if (this.meta.size > 0) this.applyMeta();
    if (!sys.authority || !ctx.isGameplayPhase()) return;
    const now = ctx.time;
    if (this.warn.active) {
      if (now >= this.warn.eruptAt) this.erupt();
    } else if (!this.done && this.plan.rolled && ctx.phase === 'playing'
      && ctx.missionTime >= this.plan.triggerAt && ctx.missionTime <= SANDWORM_WINDOW_END_S) {
      this.checkTimer -= dt;
      if (this.checkTimer <= 0) {
        this.checkTimer = SANDWORM_CHECK_S;
        if (this.findSpot(_p)) this.warnAt(_p, SANDWORM_WARN_S);
      }
    }
    const active = sys.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.type === 'sandworm' && e.active && e.state !== 'dead') this.tickWorm(e, dt);
    }
  }

  /* ── 발동 자리 ────────────────────────────────────────────────────────── */
  private findSpot(out: THREE.Vector3): boolean {
    const sys = this.sys;
    const ctx = sys.ctx;
    const targets = sys.targets;
    const alive = targets.alive;
    if (alive.length === 0) return false;
    let present = 0;
    for (let i = 0; i < targets.all.length; i++) if (targets.all[i].present) present++;
    if (!ctx.isMultiplayer || present <= 1) {
      const local = targets.local();
      const t = local && local.present && !local.isDeadOrDowned ? local : alive[0];
      return this.validSpot(t.position.x, t.position.z, out);
    }
    const r2 = SANDWORM_GROUP_RADIUS * SANDWORM_GROUP_RADIUS;
    let bestN = 0, bx = 0, bz = 0;
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i].position;
      let n = 0, cx = 0, cz = 0;
      for (let j = 0; j < alive.length; j++) {
        const b = alive[j].position;
        const dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz > r2) continue;
        n++; cx += b.x; cz += b.z;
      }
      if (n >= 2 && n > bestN) { bestN = n; bx = cx / n; bz = cz / n; }
    }
    if (bestN < 2) return false;
    return this.validSpot(bx, bz, out);
  }

  /** 분출할 수 있는 땅인가 (구조물 · 데크 · 지붕 · 바위 위가 아니다). 되면 지형 높이로 `out` 에 적는다. */
  private validSpot(x: number, z: number, out: THREE.Vector3): boolean {
    const sys = this.sys;
    const world = sys.ctx.world!;
    if (!world.isInsideBounds(x, z) || world.structureAt(x, z)) return false;
    const r2 = SANDWORM_GROUP_RADIUS * SANDWORM_GROUP_RADIUS;
    const alive = sys.targets.alive;
    for (let i = 0; i < alive.length; i++) {
      const p = alive[i].position;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (p.y > world.getHeightAt(p.x, p.z) + OFF_TERRAIN_M) return false;
    }
    const h = world.getHeightAt(x, z);
    if (world.getSurfaceY(x, z, h) > h + PROP_ON_SPOT_M) return false;
    out.set(x, h, z);
    return true;
  }

  /* ── 전조 ─────────────────────────────────────────────────────────────── */
  /** 호스트: 전조를 시작하고 방송한다. */
  private warnAt(p: THREE.Vector3, eta: number): void {
    const sys = this.sys;
    this.startWarnLocal(p, eta);
    if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'wormWarn', p: tuple(p, 2), eta: round(eta, 2), r: SANDWORM_ERUPT_RADIUS }, 'others');
  }

  /** 이 클라이언트의 전조 연출 (권위 · 리플리카 공통). 같은 자리의 전조가 이미 돌고 있으면 남은 시간만 맞춘다. */
  private startWarnLocal(p: THREE.Vector3, eta: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const now = ctx.time;
    const w = this.warn;
    const already = w.active && w.p.distanceToSquared(p) < 1;
    this.done = true;
    w.eruptAt = now + eta;
    if (already) return;
    w.active = true;
    w.p.copy(p);
    const elapsed = Math.max(0, SANDWORM_WARN_S - eta);
    w.startedAt = now - elapsed;
    w.shakeAcc = 0;
    this.warnings++;
    sys.burrowFx?.warn(p, SANDWORM_ERUPT_RADIUS, eta, ctx.world, now, elapsed);
    sys.playAudio('sandworm_rumble', p, 1, 1);
    ctx.bus.emit('ui:notify', { text: TOAST_WARN, kind: 'danger', duration: 5 });
    ctx.bus.emit('sandworm:warning', { position: p.clone(), radius: SANDWORM_ERUPT_RADIUS, eta });
  }

  private endWarn(): void {
    this.warn.active = false;
    this.sys.burrowFx?.endWarn();
  }

  /** 거리에 따라 약 → 강으로 오르는 흔들림 (모든 클라이언트). */
  private tickWarn(dt: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const w = this.warn;
    const now = ctx.time;
    if (!sys.authority && now > w.eruptAt + REPLICA_WARN_TIMEOUT_S) { this.endWarn(); return; }
    w.shakeAcc -= dt;
    if (w.shakeAcc > 0) return;
    w.shakeAcc = WARN_SHAKE_TICK_S;
    const d = sys.targets.distToLocal(w.p);
    if (!(d < SANDWORM_ALERT_RADIUS)) return;
    const k = THREE.MathUtils.clamp((now - w.startedAt) / SANDWORM_WARN_S, 0, 1);
    const fall = Math.pow(1 - d / SANDWORM_ALERT_RADIUS, 1.5);
    this.warnShakes++;
    ctx.bus.emit('camera:shake', { intensity: SANDWORM_SHAKE_MAX * (0.12 + 0.88 * k * k) * fall, duration: 0.3 });
  }

  /* ── 분출 (호스트) ────────────────────────────────────────────────────── */
  private erupt(): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const world = ctx.world;
    if (!world) return;
    const p = _erupt.copy(this.warn.p);
    this.endWarn();
    this.eruptions++;
    const R = SANDWORM_ERUPT_RADIUS;

    const face = sys.targets.nearestAlive(p);
    const yaw = face ? Math.atan2(face.position.x - p.x, face.position.z - p.z) : Math.random() * TWO_PI;
    const worm = sys.spawn('sandworm', p, yaw, true, true, SANDWORM_RISE_S);
    const spitPhase = this.forcedSpitS ?? SANDWORM_SPIT_PHASE_S;
    this.forcedSpitS = null;
    let hp = 0;
    if (worm) {
      hp = Math.round(SANDWORM_HP_MIN + Math.random() * Math.max(0, SANDWORM_HP_MAX - SANDWORM_HP_MIN));
      worm.maxHp = hp;
      worm.hp = hp;
      worm.aware = true;
      worm.wormSpitUntil = ctx.time + SANDWORM_RISE_S + spitPhase;
      worm.wormTimer = SPIT_WINDUP_S + 0.5;   // 다 솟은 뒤(틱은 굴착이 끝나야 돈다) 곧 첫 뱉기
    }

    // 피해 + 넉백 — 로컬은 직접, 원격은 `dmg.kb`, 끊긴 분대원은 `ghost:damage` (`applyDamage` 가 가른다)
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const dx = t.position.x - p.x, dz = t.position.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R + PLAYER_RADIUS) continue;
      const falloff = THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / R, 0.3, 1);
      if (d > 0.05) _kb.set(dx / d, 0, dz / d);
      else { const a = Math.random() * TWO_PI; _kb.set(Math.cos(a), 0, Math.sin(a)); }
      _kb.y = 0.8;
      _kb.normalize();
      sys.applyDamage(t, SANDWORM_ERUPT_DAMAGE * falloff, p, worm?.id ?? 0, 'sandworm', null, 0, false, _kb, SANDWORM_ERUPT_KNOCKBACK * falloff);
    }
    _c.set(p.x, p.y + 1, p.z);
    sys.explode(_c, R, SANDWORM_ERUPT_DAMAGE, 'ai', null, worm, 'bug');   // 다른 팩션 적 (벌레는 제 편)
    ctx.drones?.applyExplosion(p, R, SANDWORM_ERUPT_DAMAGE);

    this.spawnBurst(p);
    this.eruptFxLocal(p);
    if (worm) {
      if (sys.hosting) {
        sys.ctx.net!.send({ t: 'ee', ev: 'wormErupt', id: worm.id, p: tuple(p, 2), r: R, hp, spit: round(worm.wormSpitUntil - ctx.time, 2) }, 'others');
      }
      ctx.bus.emit('sandworm:erupted', { id: worm.id, position: worm.position.clone(), radius: R });
    }
  }

  /** 분출과 함께 링 위에서 파고 나오는 버그 무리 (분대 인원표). */
  private spawnBurst(p: THREE.Vector3): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, squadSize(sys) - 1));
    const want = Math.max(0, Math.round(SANDWORM_BURST_BY_SQUAD[idx] ?? 0));
    if (want <= 0) return;
    const allowed = sys.ensureCapacity(want, SANDWORM_ALIVE_CAP);
    const base = Math.random() * TWO_PI;
    for (let i = 0; i < allowed; i++) {
      const type = pickEcoType(this.eco, SPIT_TYPES, SPIT_FALLBACK);
      if (!type) continue;
      let placed = false;
      let ang = base;
      for (let a = 0; a < 4 && !placed; a++) {
        ang = base + (i / allowed) * TWO_PI + (Math.random() - 0.5) * 0.6 + a * 0.9;
        const rad = SANDWORM_BURST_RING_MIN + Math.random() * Math.max(0, SANDWORM_BURST_RING_MAX - SANDWORM_BURST_RING_MIN);
        _q.set(p.x + Math.sin(ang) * rad, 0, p.z + Math.cos(ang) * rad);
        if (!world.isInsideBounds(_q.x, _q.z)) continue;
        world.resolveCollision(_q, ENEMY_STATS[type].radius + 0.3);
        if (spawnBlocked(world, type, _q.x, _q.z)) continue;
        placed = true;
      }
      if (!placed) continue;
      _q.y = world.getHeightAt(_q.x, _q.z);
      const face = sys.targets.nearestAlive(_q);
      const yaw = face ? Math.atan2(face.position.x - _q.x, face.position.z - _q.z) : ang;
      sys.spawn(type, _q, yaw, true, true, BURROW_EMERGE_S);
    }
  }

  /** 분출 연출 (권위 · 리플리카 공통): 흙 폭발 · 굉음 · 거리 흔들림. */
  private eruptFxLocal(p: THREE.Vector3): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    sys.burrowFx?.erupt(p, SANDWORM_ERUPT_RADIUS, ctx.world);
    sys.playAudio('sandworm_erupt', p, 1, 1);
    sys.playAudio('sandworm_roar', p, 1, 1);
    const d = sys.targets.distToLocal(p);
    if (d < SANDWORM_ALERT_RADIUS) {
      ctx.bus.emit('camera:shake', { intensity: Math.min(1, 0.25 + 0.75 * Math.pow(1 - d / SANDWORM_ALERT_RADIUS, 1.2)), duration: 0.8 });
    }
  }

  /* ── 지하벌레 틱 (호스트) ─────────────────────────────────────────────── */
  private tickWorm(e: Enemy, dt: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    e.velocity.set(0, 0, 0);
    e.hasMoveTarget = false;
    e.investigating = false;
    e.relentless = true;
    e.aware = true;
    if (e.state !== 'stagger') e.state = 'chase';   // 전소는 stagger 를 탄다 — 그동안은 뱉지 않는다
    if (e.emergeT > 0) { e.namedHint = 0; applyWormHint(e, 0, dt); return; }
    const target = sys.targets.nearestAlive(e.position);
    if (target) e.yaw = turnToward(e.yaw, yawTo(e.position, target.position), e.stats.turnRate, dt);
    let hint = 0;
    if (!e.isIncapacitated) {
      e.wormTimer -= dt;
      if (ctx.time < e.wormSpitUntil) {
        if (e.wormTimer <= SPIT_WINDUP_S) hint = WORM_HINT_SPIT;
        if (e.wormTimer <= 0) { e.wormTimer = SANDWORM_SPIT_INTERVAL_S; this.spitBugs(e, target); }
      } else if (target && target.dist2D(e.position) <= SANDWORM_ACID_RANGE) {
        if (e.wormTimer <= ACID_WINDUP_S) hint = WORM_HINT_ACID;
        if (e.wormTimer <= 0) { e.wormTimer = SANDWORM_ACID_INTERVAL_S; this.spitAcid(e, target); }
      } else if (e.wormTimer < ACID_WINDUP_S + 0.2) {
        e.wormTimer = ACID_WINDUP_S + 0.2;   // 사거리 밖: 들어오면 입을 벌린 뒤 쏜다
      }
    }
    e.namedHint = hint;
    applyWormHint(e, hint, dt);
  }

  /** 입에서 버그를 뱉는다 (호스트). 버그는 `ee spawn` 으로 먼저 생기고 `ee wormSpit` 이 비행을 알린다. */
  private spitBugs(e: Enemy, target: CombatTarget | null): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const want = Math.max(0, Math.round(SANDWORM_SPIT_COUNT));
    const n = sys.ensureCapacity(want, SANDWORM_ALIVE_CAP);
    if (n <= 0) return;
    mouthOf(e, _mouth);
    const base = target ? Math.atan2(target.position.x - e.position.x, target.position.z - e.position.z) : Math.random() * TWO_PI;
    const entries: [number, number, number, number][] = [];
    const lo = SANDWORM_SPIT_MIN_M, hi = Math.max(lo, SANDWORM_SPIT_MAX_M);
    for (let i = 0; i < n; i++) {
      const type = pickEcoType(this.eco, SPIT_TYPES, SPIT_FALLBACK);
      if (!type) continue;
      const ang = base + (Math.random() - 0.5) * 1.8;
      const dist = lo + Math.random() * (hi - lo);
      _to.set(e.position.x + Math.sin(ang) * dist, 0, e.position.z + Math.cos(ang) * dist);
      if (!world.isInsideBounds(_to.x, _to.z)) _to.set(e.position.x - Math.sin(ang) * dist, 0, e.position.z - Math.cos(ang) * dist);
      if (!world.isInsideBounds(_to.x, _to.z)) continue;
      world.resolveCollision(_to, ENEMY_STATS[type].radius + 0.3);
      _to.y = world.getSurfaceY(_to.x, _to.z, world.getHeightAt(_to.x, _to.z));
      const b = sys.spawn(type, _mouth, ang, true, true);
      if (!b) continue;
      b.startSpat(_mouth, _to, SANDWORM_SPIT_FLIGHT_S);
      entries.push([b.id, round(_to.x, 2), round(_to.y, 2), round(_to.z, 2)]);
    }
    if (entries.length === 0) return;
    this.spitVolleys++;
    sys.fx?.burst(_mouth, 36, 'acid', 6);
    sys.playAudio('sandworm_spit', _mouth, 1, 1);
    if (sys.hosting) {
      sys.ctx.net!.send({ t: 'ee', ev: 'wormSpit', id: e.id, from: tuple(_mouth, 2), b: entries, T: round(SANDWORM_SPIT_FLIGHT_S, 2) }, 'others');
    }
  }

  /** 독극물 연발 (호스트): 첫 발은 예측 조준(`ee acid`), 나머지는 주변에 흩뿌린다(`ee acidAt`). 피해는 기존 산성 경로. */
  private spitAcid(e: Enemy, target: CombatTarget): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    mouthOf(e, _mouth);
    sys.fireAcid(_mouth, e, target);
    const extra = Math.max(0, Math.round(SANDWORM_ACID_VOLLEY) - 1);
    for (let k = 0; k < extra; k++) {
      const a = Math.random() * TWO_PI;
      const r = ACID_SCATTER_MIN + Math.random() * (ACID_SCATTER_MAX - ACID_SCATTER_MIN);
      _aim.set(target.position.x + Math.cos(a) * r, 0, target.position.z + Math.sin(a) * r);
      if (!world.isInsideBounds(_aim.x, _aim.z)) continue;
      _aim.y = world.getHeightAt(_aim.x, _aim.z);
      sys.fireAcidAt(_mouth, _aim, e);
    }
    this.acidVolleys++;
    sys.playAudio('sandworm_spit', _mouth, 0.8, 1.3);
  }

  /* ── 사망 (모든 클라이언트 — `parts/Damage.onEnemyKilled`) ─────────────── */
  onWormKilled(e: Enemy): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    sys.burrowFx?.puff(e.position, 3, ctx.world);
    sys.playAudio('sandworm_death', e.position, 1, 1);
    ctx.bus.emit('ui:notify', { text: TOAST_KILLED, kind: 'success', duration: 4 });
    const d = sys.targets.distToLocal(e.position);
    if (d < 40) ctx.bus.emit('camera:shake', { intensity: 0.45 * (1 - d / 40), duration: 0.6 });
  }

  /* ── 와이어 (리플리카) ────────────────────────────────────────────────── */
  onWire(msg: EnemyEvent): void {
    const sys = this.sys;
    if (!sys || sys.authority) return;
    const ctx = sys.ctx;
    if (!ctx.world?.ready) return;
    switch (msg.ev) {
      case 'wormWarn': {
        if (!isVec3Tuple(msg.p) || !Number.isFinite(msg.eta)) return;
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        this.startWarnLocal(_p, THREE.MathUtils.clamp(msg.eta, 0, SANDWORM_WARN_S * 2));
        return;
      }
      case 'wormErupt': {
        this.done = true;
        if (!(msg.id > 0) || !isVec3Tuple(msg.p)) return;   // id 0 = 이미 끝난 이벤트라는 표식뿐
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        if (this.warn.active) this.endWarn();
        if (!msg.sy) { this.eruptions++; this.eruptFxLocal(_p); }
        const hp = Number.isFinite(msg.hp) && msg.hp > 0 ? msg.hp : 0;
        const spit = Number.isFinite(msg.spit) ? Math.max(0, msg.spit) : 0;
        this.meta.set(msg.id, { hp, spitUntil: ctx.time + spit });
        this.applyMeta();
        if (!msg.sy) ctx.bus.emit('sandworm:erupted', { id: msg.id, position: _p.clone(), radius: Number.isFinite(msg.r) ? msg.r : SANDWORM_ERUPT_RADIUS });
        return;
      }
      case 'wormSpit': {
        if (!isVec3Tuple(msg.from) || !Array.isArray(msg.b) || !Number.isFinite(msg.T)) return;
        _mouth.set(msg.from[0], msg.from[1], msg.from[2]);
        const T = THREE.MathUtils.clamp(msg.T, 0.2, 3);
        for (let i = 0; i < msg.b.length; i++) {
          const row = msg.b[i];
          if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isFinite)) continue;
          const b = sys.byId.get(row[0]);
          if (!b || !b.active || b.state === 'dead') continue;
          _to.set(row[1], row[2], row[3]);
          b.startSpat(_mouth, _to, T);
        }
        this.spitVolleys++;
        sys.fx?.burst(_mouth, 36, 'acid', 6);
        sys.playAudio('sandworm_spit', _mouth, 1, 1);
        return;
      }
      default:
        return;
    }
  }

  /** 리플리카: 받아 둔 최대 체력 · 뱉기 종료 시각을 그 지하벌레에 적는다 (승격되면 그대로 이어 돌린다). */
  private applyMeta(): void {
    const sys = this.sys;
    for (const [id, m] of this.meta) {
      const e = sys.byId.get(id);
      if (!e || !e.active || e.type !== 'sandworm') continue;
      if (m.hp > 0) { e.maxHp = m.hp; if (e.hp > m.hp) e.hp = m.hp; }
      e.wormSpitUntil = m.spitUntil;
      this.meta.delete(id);
    }
  }

  /** 호스트: 재접속 · 늦은 합류(`flow rejoined`)에 진행 상황을 다시 보낸다. */
  resync(): void {
    const sys = this.sys;
    if (!sys?.hosting) return;
    const ctx = sys.ctx;
    const net = ctx.net!;
    const now = ctx.time;
    if (this.warn.active) {
      net.send({ t: 'ee', ev: 'wormWarn', p: tuple(this.warn.p, 2), eta: round(Math.max(0, this.warn.eruptAt - now), 2), r: SANDWORM_ERUPT_RADIUS }, 'others');
    }
    let alive = 0;
    const active = sys.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.type !== 'sandworm' || !e.active || e.state === 'dead') continue;
      alive++;
      net.send({ t: 'ee', ev: 'wormErupt', id: e.id, p: tuple(e.position, 2), r: SANDWORM_ERUPT_RADIUS, hp: round(e.maxHp, 0), spit: round(Math.max(0, e.wormSpitUntil - now), 2), sy: 1 }, 'others');
    }
    if (this.done && !this.warn.active && alive === 0) {
      net.send({ t: 'ee', ev: 'wormErupt', id: 0, p: [0, 0, 0], r: 0, hp: 0, spit: 0, sy: 1 }, 'others');
    }
  }

  /* ── 디버그 ───────────────────────────────────────────────────────────── */
  /**
   * 콘솔 · 스모크: 굴림 · 창 · 레이드당 1회를 무시하고 **지금** 전조를 시작한다 (권위 · 레이드 중만). `at` 이 없으면 로컬 플레이어 발밑.
   * `spitS` = 이번 분출의 뱉기 단계 길이(초, 0 = 곧장 독극물). 시작했으면 true.
   */
  debugForce(opts: { at?: { x: number; z: number }; spitS?: number } = {}): boolean {
    const sys = this.sys;
    const ctx = sys?.ctx;
    const world = ctx?.world;
    if (!sys || !sys.authority || sys.training || !ctx || ctx.isTraining() || !world?.ready || !ctx.isGameplayPhase() || this.warn.active) return false;
    const src = opts.at ?? ctx.player?.position ?? null;
    if (!src || !world.isInsideBounds(src.x, src.z)) return false;
    _p.set(src.x, world.getHeightAt(src.x, src.z), src.z);
    this.forcedSpitS = typeof opts.spitS === 'number' && Number.isFinite(opts.spitS) && opts.spitS >= 0 ? opts.spitS : null;
    this.warnAt(_p, SANDWORM_WARN_S);
    return true;
  }

  debugState(): {
    plan: SandwormPlan; done: boolean; warning: { x: number; y: number; z: number; eta: number } | null;
    worms: Array<{ id: number; hp: number; maxHp: number; spitLeft: number; emerging: boolean; hint: number }>;
    warnings: number; eruptions: number; spitVolleys: number; acidVolleys: number; warnShakes: number;
  } {
    const sys = this.sys;
    const now = sys?.ctx.time ?? 0;
    const worms: Array<{ id: number; hp: number; maxHp: number; spitLeft: number; emerging: boolean; hint: number }> = [];
    if (sys) {
      for (const e of sys.active) {
        if (e.type !== 'sandworm' || !e.active || e.state === 'dead') continue;
        worms.push({ id: e.id, hp: e.hp, maxHp: e.maxHp, spitLeft: Math.max(0, e.wormSpitUntil - now), emerging: e.emergeT > 0, hint: e.namedHint });
      }
    }
    const w = this.warn;
    return {
      plan: { ...this.plan }, done: this.done,
      warning: w.active ? { x: w.p.x, y: w.p.y, z: w.p.z, eta: w.eruptAt - now } : null,
      worms, warnings: this.warnings, eruptions: this.eruptions, spitVolleys: this.spitVolleys, acidVolleys: this.acidVolleys, warnShakes: this.warnShakes,
    };
  }
}

/** 입 월드 위치 (리그의 입 그룹 — 마지막 프레임 자세). 리그가 없으면 머리 구 중심. */
function mouthOf(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
  const rig = e.rig;
  if (rig.kind === 'worm') {
    rig.root.updateMatrixWorld(true);
    return rig.mouth.getWorldPosition(out);
  }
  return e.headCenter(out);
}

/** 분대 인원 (1..4). 싱글은 1. `RogueDrop.squadSize` · `WaveDirector.squadSize` 와 같은 계산. */
function squadSize(sys: EnemySystem): number {
  const net = sys.ctx.net;
  let n = 1;
  if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
  return Math.max(1, Math.min(MAX_SQUAD, n));
}
