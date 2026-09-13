import * as THREE from 'three';
import type { RogueShotOpts } from './Enemy';
import {
  BEHEMOTH_KNOCKBACK, BURNOUT_DURATION, CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, ENEMY_DEATH_DIRS, ENEMY_SHOT_ALERT_DIST, ENEMY_SHOT_IMPACT_DIST, ENEMY_STATUS_BITS, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION, GADGET_LURE_RADIUS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, PLAYER_RADIUS, ROGUE_DAMAGE, ROGUE_GRENADE_DAMAGE, ROGUE_GRENADE_FUSE, ROGUE_GRENADE_RADIUS, ROGUE_MAG_ROUNDS, ROGUE_RANGE,
  SHELL_BLAST_RADIUS, SHELL_DAMAGE, SHELL_FLIGHT_TIME, SHOCK_SLOW_DURATION, SHOCK_SLOW_FACTOR, TOXIC_DAMAGE, TOXIC_RADIUS, getPlanet,
  type DamageMessage, type EnemyDeathDir, type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type Vec3Tuple, type WorldRef,
  /* appended (2026-09-09): 로그 강하 계약 */
  type RogueDropView,
  /* appended (2026-09-10): HUD 위험 인디케이터가 읽는 적 수류탄 */
  type GrenadeView,
  /* appended (2026-09-11): 네임드 로그 디버그 훅 */
  type NamedRogueType,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { ROGUE_AI, SPEWER_SPIT } from './EnemyTypes';
import { SpatialGrid } from './SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from './Targets';
import { SUSPICION_TIME, updateEnemyAI } from './ai/EnemyAI';
import { LureField } from './ai/Lures';
import { becomeAlert, canPerceive } from './ai/Perception';
import { beginInvestigation, endInvestigation } from './ai/Investigate';
import { BloodFX } from './fx/BloodFX';
import { EnemyXray } from './fx/Xray';
import { AcidProjectiles, type AcidHost, type AcidSlow } from './fx/AcidProjectile';
import { ShellProjectiles, type ShellHost } from './fx/ShellProjectile';
import { RogueGrenades, type GrenadeHost } from './fx/RogueGrenade';
import { AmbientSpawner, ambientGroup, waveGroup, type SpawnHost } from './Spawner';
import { WaveDirector } from './WaveDirector';
import { disposeBugAssets } from './models/BugModel';
import { disposeRogueAssets } from './models/RogueModel';
import { EnemyReplica, type ReplicaHost } from './net/Replica';
import { animHint, encodeSnapshot, round, SnapshotCache, tuple } from './net/HostSync';
import { CorpseManager, rollCorpseLootable, type CorpseWireOpts } from './Corpses';
import { placeRogueGuards, type RogueSpawnHost } from './RogueGuards';
import { RogueDropDirector, type RogueDropHost } from './RogueDrop';
import { NamedRogueDirector, type NamedRollResult } from './named/Director';
import { raySphere, rayCapsule, rayStandingCapsule, standingTopY } from './RayTests';
import { carryCorpse } from './ai/Ride';
import { BODY_RAY_VERTICAL, namedBodyNormal, namedBodyRay } from './models/named';

import { BARRIER_BUMP_INTERVAL, BARRIER_RETARGET_S, BURN_TICK, CLASH_RADIUS, CLASH_THROTTLE, CORPSE_SLACK, EMBER_INTERVAL, FLEE_DURATION, GRENADE_KNOCKBACK, GRENADE_LOB_SPEED, GRENADE_NOISE, GUNFIRE_LURE_DURATION, GUNFIRE_LURE_WEIGHT, INCAP_EMBER_INTERVAL, MAX_REQUEST_DAMAGE, MAX_REQUEST_RADIUS, MAX_SHOT_RANGE, MAX_STATUS_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, RECYCLE_DISTANCE, SHIELD_CONTACT_Y, SHOCK_SPARK_TIME, SHOT_CHECK_INTERVAL, SPARK_INTERVAL, STATUS_REQUEST_INTERVAL, SUSPICION_RADIUS, SUSPICION_REFRESH, EMPTY_GRENADES, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, deathDirIndex, isVec3Tuple, killedBuf, queryBuf } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Dmg from './parts/Damage';
import * as Atk from './parts/Attacks';
import * as Alert from './parts/Alerts';
import * as Status from './parts/Status';
import * as Pool from './parts/Pool';
import * as RFx from './parts/RemoteFx';

export class EnemySystem implements GameSystem, EnemyManagerRef, EnemyHost, SpawnHost, RogueSpawnHost, RogueDropHost, AcidHost, ShellHost, ReplicaHost, GrenadeHost {
  readonly name = 'enemies';
  ctx!: GameContext;
  /* ── Phase 12: 총알 추적 · 정찰 x-ray (EnemyManagerRef) ─────────────────── */
  /**
   * A local shot was fired (weapons calls this for every one). Authority: run the alert routine; a joined client
   * forwards it to the host as `shotq` instead (replicas have no AI). No-op on the 훈련장.
   */
  reportShot(origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null): void { return Alert.reportShot(this, origin, dir, range, hit); }

  /**
   * 정찰 x-ray: red through-wall silhouette for these enemies (simulated or replica) for `seconds`; a second call
   * extends. Unknown ids are ignored; `seconds <= 0` hides the listed ones (`[]` + 0 is a no-op).
   */
  setXray(ids: readonly number[], seconds: number): void { return Status.setXray(this, ids, seconds); }
  /* ── appended (2026-09-09): 로그 강하 (`RogueDrop.ts` 가 전부 갖는다) ── */
  /**
   * **호스트 전용**: 로그 분대를 강하시킨다 (예고 → `ROGUE_DROP_ETA_S` 뒤 착지 → 구조물로 진격).
   * 인원 · 보스 여부는 **분대 인원**이 정한다. 같은 `dropId` 가 진행 중이거나 호스트가 아니면 false.
   */
  callRogueDrop(dropId: string, position: THREE.Vector3): boolean { return this.rogueDrops.call(dropId, position); }
  /** 진행 중인 강하 (HUD 경고 · 오프스크린 화살표용). */
  getRogueDrops(): readonly RogueDropView[] { return this.rogueDrops.views(); }
  /** 2026-09-10: 날아가는 적 수류탄 — HUD 위험 인디케이터가 아군 수류탄과 나란히 읽는다. */
  getEnemyGrenades(): readonly GrenadeView[] { return this.grenades?.getViews() ?? EMPTY_GRENADES; }
  /** 로그 강하 — 굴림 기록 · 포드 연출 · 착지 스폰 (호스트 권한, 훈련장에서는 아무 것도 하지 않는다). */
  readonly rogueDrops = new RogueDropDirector();
  /** 2026-09-11: 네임드 로그 — 레이드당 1회 굴림 · 자리 · 스폰 · `enemy:namedSpawned` (`named/Director.ts`). */
  readonly named = new NamedRogueDirector();
  /** Phase 12: through-wall silhouettes (`setXray`). */
  readonly xray = new EnemyXray();
  readonly grid = new SpatialGrid<Enemy>(MAP_SIZE + 40, 8);
  readonly targets = new TargetList();

  readonly active: Enemy[] = [];
  readonly byId = new Map<number, Enemy>();
  readonly pools = new Map<EnemyType, Enemy[]>();
  fx: BloodFX | null = null;
  acid: AcidProjectiles | null = null;
  shells: ShellProjectiles | null = null;
  /** Phase 7: rogue grenades (host = damage, replica = visual copies from `ee grenade`). */
  grenades: RogueGrenades | null = null;
  readonly corpses = new CorpseManager();
  readonly spawner = new AmbientSpawner();
  readonly waves = new WaveDirector();
  readonly replicaMgr = new EnemyReplica(this);
  /** Noise beacons the bugs walk toward (`addDistraction`, gunfire). Merged with `ctx.gadgets.findDistraction`. */
  readonly lures = new LureField();
  /** ctx.time when the spatial grid was last rebuilt (so `queryNear` knows it can trust it). */
  private gridTime = -1;
  nextId = 1;
  nextShellId = 1;
  private paused = false;
  /** Cached per mission: this client simulates the bugs (single-player or host). */
  authority = true;
  /** Cached per mission: a lobby session is running (replication on). */
  multiplayer = false;
  snapTimer = 0;
  /** Phase 9: delta-snapshot state (last sent fields per enemy, monotonic seq, forced keyframe). */
  readonly snapCache = new SnapshotCache();
  resetting = false;
  /** 2026-09-11 (C-14): seconds accumulated toward the next 환경 재해 tick on enemies (`parts/Status.updateHazardDot`). */
  hazardTick = 0;
  lastClash = -Infinity;
  /** Current boss (authority) for debugging / HUD. */
  bossId = 0;
  /* ── Phase 7 ── */
  /** 시뮬레이션 훈련장: no spawner / waves / guards / initial population (set at `world:ready`). */
  training = false;
  /* ── Phase 11 ── */
  /** Ecosystem of the 목표 행성 this mission runs on (`world:ready.planet` → `PLANET_DEFS`), null = the default tables. */
  private eco: PlanetEcosystem | null = null;
  /** Waves announced so far this mission (`enemy:waveStarted`, also from `ee wave` on a replica) — the wave director resumes from it on promotion. */
  wavesSeen = 0;
  /** Debug counters (smoke tests): rogue grenades thrown / exploded on this client. */
  grenadesThrown = 0;
  grenadesExploded = 0;
  /**
   * 2026-09-11 (E-4 · X-6) debug counters of the host's request guards (`parts/Damage.onHitRequest`): hits trimmed /
   * dropped by the per-sender DPS budget, knockback requests refused for a sender too far from the enemy.
   *
   * appended 2026-09-11 (E-8, `parts/Damage.onExplodeRequest` · the `st` guard) — **the only way a smoke can see a
   * refusal**, since a refused request simply does nothing:
   *   `explodeShape`  `explode` dropped on shape (`p` not a finite tuple, `r` / `dmg` non-finite or out of bounds)
   *   `explodeSender` `explode` dropped because `from` has no live snapshot on this host
   *   `explodeRange`  `explode` dropped because the sender stood farther than `EXPLODE_SOURCE_REACH` from the blast
   *   `statusBits`    `HitRequest.st` carried **only** bits outside `ENEMY_STATUS_BITS` (the status half was skipped)
   *   `statusRange`   `st` skipped: the sender has no snapshot / stood farther than `STATUS_SOURCE_REACH` from the enemy
   *   `statusRate`    `st` skipped: the sender's per-second status budget ran out
   * An over-budget `explode` shares `trimmed` / `dropped` with `hit` — it spends the **same** bucket on purpose.
   */
  readonly hitGuardStats = {
    trimmed: 0, dropped: 0, kbRefused: 0,
    explodeShape: 0, explodeSender: 0, explodeRange: 0,
    statusBits: 0, statusRange: 0, statusRate: 0,
  };
  /** Debug: where the last rogue grenade went off. */
  readonly lastGrenadeBlast = new THREE.Vector3();
  private readonly unsub: Array<() => void> = [];
  private readonly netUnsub: Array<() => void> = [];
  readonly lastAudio = new Map<string, number>();

  get replica(): boolean { return !this.authority; }

  /** Authority inside a running session: replicate out. */
  get hosting(): boolean { return this.authority && this.multiplayer && !!this.ctx.net; }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.enemies = this;
    this.fx = new BloodFX(ctx.scene);
    this.acid = new AcidProjectiles(ctx.scene, this.fx);
    this.shells = new ShellProjectiles(ctx.scene);
    this.shells.bind(this);
    this.grenades = new RogueGrenades(ctx.scene);
    this.grenades.bind(this);
    this.corpses.bind(ctx);
    this.rogueDrops.bind(this);
    this.named.bind(this);

    const bus = ctx.bus;
    this.unsub.push(
      bus.on('world:ready', ({ seed, playerSpawn, planet }) => {
        this.refreshMode();
        this.reset();
        this.spawner.reset();
        this.ensureNet();
        // Phase 7: the training arena has no enemies at all (world/ reports `mode`, game/ sets `ctx.missionMode` before emitting)
        this.training = ctx.isTraining() || ctx.missionMode === 'training' || (ctx.world as Partial<WorldRef> | null)?.mode === 'training';
        // Phase 11: 목표 행성 생태계 → spawner / waves / guards. Training keeps it null; so does a mission without a planet
        // (the ecosystem is host-side composition only — the `es` / `ee` wire and replica behaviour are untouched).
        this.eco = this.training ? null : (getPlanet(planet ?? ctx.world?.planet ?? ctx.missionPlanet)?.eco ?? null);
        this.spawner.eco = this.eco;
        this.waves.eco = this.eco;
        if (this.training) return;
        if (this.authority && ctx.world?.ready) {
          this.targets.refresh(ctx);
          this.spawner.initialPopulate(this, playerSpawn);
          const guards = placeRogueGuards(this, seed, this.eco);
          if (guards.boss) {
            this.bossId = guards.boss.id;
            ctx.bus.emit('enemy:bossSpawned', { id: guards.boss.id, type: guards.boss.type, position: guards.boss.position });
          }
          // 2026-09-11: 네임드 로그 — 가드 배치 뒤 레이드당 한 번 (world:ready 에서만 굴리므로 승격된 호스트는 다시 굴리지 않는다)
          this.named.roll(planet ?? ctx.world?.planet ?? ctx.missionPlanet ?? null);
        }
      }),
      // WorldSystem (registered earlier) generates synchronously inside ITS game:newMission handler and emits
      // world:ready before this handler runs, so the initial population already exists here. Only reset when the
      // world did not (yet) generate for this seed; otherwise we would wipe the bugs we just spawned.
      bus.on('game:newMission', ({ seed }) => {
        this.refreshMode();
        if (!(ctx.world?.ready && ctx.world.seed === seed)) this.reset();
      }),
      bus.on('game:abort', () => { this.reset(); this.disposePools(); this.refreshMode(); }),
      // multiplayer pause menus keep simulating (freeze === false)
      bus.on('game:paused', ({ paused, freeze }) => { this.paused = paused && freeze !== false; }),
      bus.on('weapon:fired', ({ origin }) => this.onGunshot(origin, 55)),
      bus.on('net:remoteFired', ({ origin }) => this.onGunshot(origin, 55)),
      bus.on('grenade:exploded', ({ position }) => this.onGunshot(position, 80)),
      // 2026-09-13: 탈출 디펜스 웨이브 제거 (사용자 결정) — `extraction:activated` 는 더 이상 웨이브를 부르지 않는다
      bus.on('extraction:liftoff', ({ position }) => {
        if (this.authority) this.fleeFrom(position, 18);
      }),
      bus.on('enemy:waveStarted', ({ index, count }) => {
        this.wavesSeen = Math.max(this.wavesSeen, index + 1);
        if (this.hosting) this.ctx.net!.send({ t: 'ee', ev: 'wave', index, count }, 'others');
      }),
      bus.on('crate:looted', ({ crateId }) => this.corpses.markLooted(crateId)),
      // 2026-09-11 (적 ↔ 드론): 질주하는 지상 드론의 소음 — 권한 클라이언트에서만 나온다 (`parts/Alerts.onWorldNoise`)
      bus.on('world:noise', ({ position, radius }) => this.onWorldNoise(position, radius)),
      // 2026-09-11: 리플리카는 `ee spawn` 으로 네임드를 처음 볼 때 `enemy:namedSpawned` 를 낸다 (권한은 스폰 경로가 직접)
      bus.on('enemy:spawned', ({ id, type }) => this.named.onSpawned(id, type)),
      // 2026-09-09: 로그 강하 — world/ 가 구조물 · 플랫폼 컨테이너를 처음 조사할 때 낸다. 호스트만 굴린다 (구역당 1회).
      bus.on('structure:investigated', ({ zoneId, position }) => this.rogueDrops.onInvestigated(zoneId, position)),
      // Phase 7: mid-mission host migration — the only place authority changes while a mission runs
      bus.on('net:hostChanged', ({ isLocalHost }) => this.setAuthority(isLocalHost)),
    );
    this.refreshMode();
    this.ensureNet();
  }

  private refreshMode(): void {
    const ctx = this.ctx;
    this.multiplayer = ctx.isMultiplayer;
    this.authority = !this.multiplayer || ctx.isAuthority;
  }

  /** Subscribe to relayed game messages once `ctx.net` exists (NetSystem registers first, but stay defensive). */
  private ensureNet(): void {
    const net = this.ctx.net;
    if (!net || this.netUnsub.length > 0) return;
    this.netUnsub.push(
      net.onMessage('es', (msg) => { if (this.replica) this.replicaMgr.onSnapshot(msg); }),
      // 2026-09-11 (E-4): enemy events are host-authoritative — a non-host's `ee` (e.g. a forged `kill` to pump squad
      // contract kills through `enemy:squadKill`) is dropped. No lobby (test harness) = nothing to compare with.
      net.onMessage('ee', (msg, from) => {
        if (!this.replica) return;
        const hostId = net.lobby?.hostId;
        if (hostId && from !== hostId) return;
        this.replicaMgr.onEvent(msg);
      }),
      net.onMessage('hitc', (msg) => {
        if (!this.replica) return;
        if (msg.killed) this.ctx.bus.emit('ui:hitmarker', { kill: true, headshot: msg.part === 'head' });
      }),
      net.onMessage('hit', (msg, from) => this.onHitRequest(msg, from)),
      net.onMessage('explode', (msg, from) => this.onExplodeRequest(msg.p, msg.r, msg.dmg, from)),
      // Phase 9: a member that (re)joined the mission or a takeover needs a full picture — the next `es` is a keyframe
      net.onMessage('flow', (msg) => {
        if ((msg.ev === 'rejoined' || msg.ev === 'takeover') && this.hosting) this.snapCache.forceFull = true;
      }),
      net.onMessage('intq', (msg) => {
        // a client's bullet hit shell `sid`: validate it still exists, pop it here and broadcast
        if (!this.hosting || !this.shells) return;
        _c.set(msg.p[0], msg.p[1], msg.p[2]);
        this.shells.interceptById(msg.sid, _c, true);
      }),
      // Phase 12: a client's bullet report — the host runs the same routine as for its own shots
      net.onMessage('shotq', (msg, from) => this.onShotReport(msg, from)),
      // 2026-09-09: 로그 강하 — 비호스트는 예고 · 착지를 받아 같은 이벤트를 내고 포드만 그린다 (적은 `es` / `ee`)
      net.onMessage('rdrop', (msg) => {
        if (msg.ev === 'incoming') this.rogueDrops.onIncomingWire(msg.dropId, msg.p, msg.eta, msg.count, msg.boss);
        else this.rogueDrops.onLandedWire(msg.dropId);
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    if (!world || !world.ready || this.paused) return;
    this.targets.refresh(ctx);

    // spatial grid for neighbour queries + faction target proxies
    const grid = this.grid;
    grid.clear();
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      e.syncTarget();
      if (e.state !== 'dead' && e.state !== 'flee') grid.insert(e);
    }
    this.gridTime = ctx.time;
    this.lures.prune(ctx.time);
    // status effects tick on every client (embers are visual); only the authority applies the damage
    if (ctx.isGameplayPhase()) this.updateStatuses(dt);
    // 로그 강하: 포드 낙하 연출은 어디서나, 착지 스폰은 호스트에서만 (안쪽에서 갈린다)
    if (!this.training) this.rogueDrops.update(dt);

    if (this.authority) {
      if (ctx.isGameplayPhase()) {
        for (let i = 0; i < this.active.length; i++) updateEnemyAI(this.active[i], dt, this);
        Status.updateHazardDot(this, dt);   // 2026-09-11 (C-14): 재해 구역 안의 적 — 조용한 피해 (권위만)
        this.acid?.update(dt, this);
        this.shells?.update(dt, this);
        this.grenades?.update(dt);
        if (!this.training) {
          this.spawner.update(dt, this);
          this.waves.update(dt, this);
        }
      }
      if (this.hosting) {
        this.snapTimer -= dt;
        if (this.snapTimer <= 0) {
          this.snapTimer = Math.max(0, this.snapTimer + 1 / NET_ENEMY_SNAPSHOT_HZ);
          ctx.net!.send(encodeSnapshot(this.active, ctx.time, this.snapCache), 'others');
        }
      }
    } else {
      this.replicaMgr.update(dt);
      this.acid?.update(dt, this);      // visual only: damageTargetAcid is a no-op here
      this.shells?.update(dt, this);    // visual only: onShellLanded applies no damage on a replica
      if (ctx.isGameplayPhase()) this.grenades?.update(dt);   // visual copies (`authority` false → FX only)
    }

    // visuals always tick (frozen AI still renders idle motion), then despawn finished corpses / fled bugs
    const slack = this.authority ? 0 : 1;   // replicas: the host's despawn normally arrives first
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      // 2026-09-11 (C-18): 전차 위 시체는 전차와 함께 간다 (권위 · 리플리카 공통) — 수색 자리(`corpse:<id>`)도 몸을 따라간다
      if (e.state === 'dead' && (carryCorpse(e, world) || e.corpseDropped)) {
        const c = this.corpses.get(e.id);
        if (c) c.position.copy(e.position);
        if (e.deathLanded) e.corpseDropped = false;
      }
      e.animate(dt);
      // Phase 10: a mid-air kill registers its corpse once the body has come to rest (or after CORPSE_LAND_TIMEOUT)
      if (e.corpsePending && this.authority && !this.resetting && (e.deathLanded || e.deathTimer >= CORPSE_LAND_TIMEOUT)) this.registerCorpse(e);
      if ((e.state === 'dead' && e.deathTimer >= e.corpseLife + slack) || (e.state === 'flee' && e.fleeTimer >= FLEE_DURATION)) this.despawn(e);
    }
    this.xray.tick(ctx.time);
    this.corpses.update(dt);
    this.fx?.update(dt, world);
  }

  dispose(): void {
    for (const off of this.unsub) off();
    this.unsub.length = 0;
    for (const off of this.netUnsub) off();
    this.netUnsub.length = 0;
    this.reset();
    this.disposePools();
    this.fx?.dispose(); this.fx = null;
    this.acid?.dispose(); this.acid = null;
    this.shells?.dispose(); this.shells = null;
    this.grenades?.dispose(); this.grenades = null;
    if (this.ctx && this.ctx.enemies === this) this.ctx.enemies = null;
  }

  /* ── EnemyManagerRef ───────────────────────────────────────────────────── */
  getEnemies(): readonly EnemyRef[] { return this.active; }

  getAliveCount(): number { return this.aliveCount(); }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null {
    return this.raycastEx(origin, dir, maxDist, null);
  }

  /** Ray vs every enemy hitbox except `exclude` (rogue shots skip the shooter). */
  raycastEx(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, exclude: Enemy | null): EnemyHit | null {
    let best: Enemy | null = null;
    let bestT = maxDist;
    let bestPart: HitPart = 'body';
    let bestKind = 0; // 0 cylinder, 1 cap, 2 head, 3 armour plate, 4 lying-body capsule (C-55)
    let bestCapY = 0;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e === exclude || !e.active || e.state === 'dead' || e.state === 'flee') continue;
      const r = e.stats.radius, h = e.stats.height;
      // broad phase: bounding sphere around the capsule + head (+ plate)
      const cx = e.position.x, cy = e.position.y + h * 0.5, cz = e.position.z;
      const R = Math.max(r, h * 0.5) + e.stats.headRadius + e.rig.params.head.z * 0.5 + 0.2 + (e.hasFrontPlate ? r : 0);
      const ox = cx - origin.x, oy = cy - origin.y, oz = cz - origin.z;
      const tc = ox * dir.x + oy * dir.y + oz * dir.z;
      if (tc < -R || tc - R > bestT) continue;
      const perp2 = ox * ox + oy * oy + oz * oz - tc * tc;
      if (perp2 > R * R) continue;

      // head sphere
      e.headCenter(_hc);
      const th = raySphere(origin, dir, _hc, e.stats.headRadius);
      if (th >= 0 && th < bestT) { best = e; bestT = th; bestPart = 'head'; bestKind = 2; }

      // body capsule — C-55 (2026-09-11): a lying body (the prone sniper) is a capsule along its visible pose
      // (`models/named.namedBodyRay`, kind 4). Broad phase: its ends stay ≤ ~1.35 m from (feet + h/2), inside R (1.68 prone).
      const tb = namedBodyRay(e, origin, dir);
      if (tb !== BODY_RAY_VERTICAL) {
        if (tb >= 0 && tb < bestT) { best = e; bestT = tb; bestKind = 4; bestPart = e.classifyHit(undefined, dir); }
      } else {
        // 2026-09-11 (C-72): 서 있는 캡슐의 축 높이 규칙은 `RayTests.standingTopY` 하나다 — 여기 같은 식을 또 적지 않는다.
        const y0 = e.position.y + r;
        const y1 = standingTopY(e.position.y, r, h);
        const res = rayCapsule(origin, dir, cx, cz, y0, y1, r);
        if (res.t >= 0 && res.t < bestT) {
          best = e; bestT = res.t; bestKind = res.kind; bestCapY = res.capY;
          bestPart = e.classifyHit(undefined, dir);
        }
      }

      // behemoth front plate (armoured): a thick vertical capsule hanging in front of the head
      if (e.hasFrontPlate) {
        e.plateAxis(_hc);
        const pr = e.plateRadius;
        const pres = rayCapsule(origin, dir, _hc.x, _hc.z, e.position.y + e.plateY0 + pr, e.position.y + e.plateY1 - pr, pr);
        if (pres.t >= 0 && pres.t <= bestT) { best = e; bestT = pres.t; bestKind = 3; bestPart = 'front'; }
      }
    }
    if (!best) return null;
    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    const normal = new THREE.Vector3();
    if (bestKind === 2) { best.headCenter(_hc); normal.subVectors(point, _hc).normalize(); }
    else if (bestKind === 3) { best.plateAxis(_hc); normal.set(point.x - _hc.x, 0, point.z - _hc.z).normalize(); }
    else if (bestKind === 1) { normal.set(point.x - best.position.x, point.y - bestCapY, point.z - best.position.z).normalize(); }
    else if (bestKind === 4) { namedBodyNormal(best, point, normal).normalize(); }
    else { normal.set(point.x - best.position.x, 0, point.z - best.position.z).normalize(); }
    if (normal.lengthSq() < 0.5) normal.copy(dir).negate();
    const hit: EnemyHit = { enemy: best, point, normal, distance: bestT, part: bestPart };
    if (bestKind === 3) hit.armored = true;
    return hit;
  }

  raycastInterceptable(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { target: InterceptableRef; point: THREE.Vector3; distance: number } | null {
    return this.shells ? this.shells.raycast(origin, dir, maxDist) : null;
  }

  /** Radial damage. On a replica this only plays local FX and forwards an `ExplodeRequest` to the host (returns 0). */
  applyExplosion(center: THREE.Vector3, radius: number, damage: number): number { return Dmg.applyExplosion(this, center, radius, damage); }

  /** `skipFaction` (Phase 7): enemies of that faction are spared (a rogue grenade hurts bugs, not the rogues). */
  explode(center: THREE.Vector3, radius: number, damage: number, attacker: TargetId, killedOut: Enemy[] | null, exclude: Enemy | null, skipFaction: EnemyFaction | null = null): number { return Dmg.explode(this, center, radius, damage, attacker, killedOut, exclude, skipFaction); }

  setThreatLevel(level: number): void { this.spawner.threat = THREE.MathUtils.clamp(level, 0, 1); }

  startExtractionWaves(target: THREE.Vector3): void { if (!this.training) this.waves.start(target); }

  stopExtractionWaves(): void { this.waves.stop(); }

  killAll(): void { return Pool.killAll(this); }

  /* ── EnemyManagerRef: appended tactical-kit queries ────────────────────── */

  /**
   * Alive enemies within `radius` of `pos` (turrets, scans, explosions, lures).
   * Uses the per-frame spatial grid when it is fresh, else a linear scan — both allocation-free apart
   * from the returned array.
   */
  queryNear(pos: THREE.Vector3, radius: number): EnemyRef[] {
    const out: EnemyRef[] = [];
    const r2 = radius * radius;
    const usable = this.gridTime === this.ctx.time && this.active.length > 24;
    if (usable) {
      queryBuf.length = 0;
      const n = this.grid.query(pos.x, pos.z, radius, queryBuf);
      for (let i = 0; i < n; i++) {
        const e = queryBuf[i];
        if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
        const dx = e.position.x - pos.x, dy = e.position.y + e.stats.height * 0.5 - pos.y, dz = e.position.z - pos.z;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
      }
      queryBuf.length = 0;
      return out;
    }
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      const dx = e.position.x - pos.x, dy = e.position.y + e.stats.height * 0.5 - pos.y, dz = e.position.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
    }
    return out;
  }

  /**
   * Pull aggro toward `pos` (lure grenade, gunfire noise). Registers a lure the AI walks toward and
   * wakes unaware bugs inside the radius. Authority only — replicas follow the host's snapshots.
   */
  addDistraction(pos: THREE.Vector3, radius: number, duration: number, weight: number): void { return Alert.addDistraction(this, pos, radius, duration, weight); }

  /**
   * Apply a status effect. `burning` deals `dps` damage (in 0.5 s ticks) for `duration` seconds and
   * spits embers; `slowed` reads `dps` as the fraction of speed removed (0.4 → 60 % speed), clamped to 0.2…1.
   * `incinerated` (전소, 2026-09-06): `duration` s of writhing on the spot — no movement / attacks, still damageable —
   * `isIncapacitated`, faster embers, `enemy:incinerated`; `dps` is ignored. `shocked`: `dps` is the **speed
   * multiplier** (0..1, `SHOCK_SLOW_FACTOR` = 55 % speed) for `duration` s, plus a cyan spark strobe and
   * `enemy:shocked` (emitted once per shock, not per tick — the arc calls this every frame).
   * `dps` 0 (or `duration` 0 for 전소) clears the effect. Visuals run everywhere; gameplay only on the authority:
   * a replica keeps the optimistic visual and forwards the request to the host as `hit {dmg: 0, st, dur}`
   * (`ENEMY_STATUS_BITS`), throttled per enemy for the continuous callers.
   */
  applyStatus(id: number, status: EnemyStatusKind, dps: number, duration: number, attacker?: string): void { return Status.applyStatus(this, id, status, dps, duration, attacker); }

  /** Authority: put `e` into 전소 for `duration` s (event, scream, ember burst). */
  incinerate(e: Enemy, duration: number): void { return Status.incinerate(this, e, duration); }

  /**
   * Replica: forward a status to the host as a damage-less `HitRequest` (`st` bits + `dur`). Repeats of the same
   * bits inside STATUS_REQUEST_INTERVAL are dropped (the flamethrower / arc call `applyStatus` every tick).
   */
  requestStatus(e: Enemy, bits: number, duration: number): void { return Status.requestStatus(this, e, bits, duration); }

  /** Host: apply the status bits a client attached to its hit (`HitRequest.st` / `dur`); the wire carries no dps, so the defaults are the constants. */
  applyStatusBits(e: Enemy, bits: number, dur: number | undefined, from?: string): void { return Status.applyStatusBits(this, e, bits, dur, from); }

  /**
   * Radial damage credited to `by` (turret, mine, rocket). Same falloff as `applyExplosion`.
   * On a replica this plays the local FX and forwards an `ExplodeRequest` (the host credits the requester).
   */
  /**
   * Phase 7: live authority switch (mid-mission host migration; `net:hostChanged` → this). `true` promotes every replica
   * into a simulated enemy seeded from its last wire sample and resumes the spawner / wave director; `false` demotes the
   * simulation into replicas that the new host's first full `es` overwrites. Outside a running mission only the flag
   * changes (the next `world:ready` re-reads `ctx.isAuthority` anyway).
   */
  setAuthority(authority: boolean): void {
    if (authority === this.authority) return;
    const ctx = this.ctx;
    this.authority = authority;
    this.multiplayer = ctx.isMultiplayer;
    if (!ctx.world?.ready) return;
    if (authority) this.promote(); else this.demote();
  }

  /** Replicas → simulated enemies. */
  private promote(): void {
    const ctx = this.ctx;
    let maxId = 0;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active) continue;
      maxId = Math.max(maxId, e.id);
      if (e.state === 'dead') continue;                 // corpses are adopted as they are (registered from `ee corpse`)
      const s = this.replicaMgr.latestOf(e);
      const st = s ? s.st : e.state;
      if (s) e.hp = Math.min(e.maxHp, Math.max(0.1, s.hp));
      const aware = st !== 'idle' && st !== 'wander';
      e.aware = aware;
      e.state = aware ? 'chase' : 'idle';
      e.stateTime = 0; e.wanderTimer = 1 + Math.random() * 2;
      e.spawnPos.copy(e.position);
      e.guardPos.copy(e.position); e.escortOf = null; e.leash = ROGUE_AI.leash;
      e.target = null; e.targetTimer = 0; e.perceptionTimer = Math.random() * 0.3; e.hasLOS = false; e.lostTimer = 0;
      e.roguePhase = 0; e.chargePhase = 0; e.spitPhase = 0; e.toxicPhase = 0; e.swellTimer = 0; e.dug = 0;
      e.airborne = false; e.leaping = false; e.vy = 0;
      e.burstLeft = 0; e.throwTimer = 0; e.reloadTimer = 0; e.magRounds = ROGUE_MAG_ROUNDS;
      e.hasMoveTarget = false; e.hasFacePoint = false; e.hasCover = false;
      e.velocity.set(0, 0, 0);
      e.relentless = false;
      e.investigating = false; e.shotPhase = 0; e.barrierOwner = null; e.barrierUntil = -Infinity;   // Phase 12
      e.lastDamager = 'ai';                               // whoever hurt it before belongs to the old host — no kill credit here
      e.netBuf?.clear();
      // status holds (0.35 s from the wire) become real durations
      if (e.incapTimer > 0) e.incinerate(Math.max(e.incapTimer, 1.5));
      if (e.burnTimer > 0) { e.burnDps = Math.max(e.burnDps, FLAME_AFTERBURN_DPS); e.burnTimer = Math.max(e.burnTimer, 1); e.burnTick = BURN_TICK; }
      if (e.slowTimer > 0) { e.slowTimer = Math.max(e.slowTimer, 1); if (e.slowFactor >= 1) e.slowFactor = SHOCK_SLOW_FACTOR; }
      if (e.shockTimer > 0) e.shockTimer = Math.min(e.shockTimer, SHOCK_SPARK_TIME);
    }
    this.nextId = Math.max(this.nextId, maxId + PROMOTE_ID_GAP);
    this.nextShellId += 1000;
    // Phase 9: fresh delta cache → our first `es` is a keyframe, with a seq the clients cannot confuse with the old host's
    this.snapCache.reset(this.replicaMgr.lastSeq + PROMOTE_SEQ_GAP);
    this.replicaMgr.clear();
    this.lures.clear();
    this.grenades?.setAuthorityAll(true);
    this.snapTimer = 0;
    this.spawner.resume();
    this.waves.reset();
    // 2026-09-13: 탈출 디펜스 웨이브 제거 — 승격된 호스트도 웨이브를 다시 이어 붙이지 않는다 (`waves.prime` 을 부르지 않는다)
    this.targets.refresh(ctx);
  }

  /** Simulated enemies → replicas (the next full snapshot from the new host takes over). */
  private demote(): void {
    const now = this.ctx.time;
    this.waves.stop();
    this.lures.clear();
    this.grenades?.setAuthorityAll(false);
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead') continue;
      e.throwTimer = 0; e.reloadTimer = 0;
      e.target = null; e.hasMoveTarget = false; e.hasFacePoint = false;
      e.chargePhase = 0; e.spitPhase = 0; e.toxicPhase = 0; e.roguePhase = 0; e.airborne = false; e.leaping = false;
      e.velocity.set(0, 0, 0);
      this.replicaMgr.adopt(e, now);
    }
  }

  applyAreaDamage(center: THREE.Vector3, radius: number, damage: number, by?: string): number { return Dmg.applyAreaDamage(this, center, radius, damage, by); }

  /**
   * `EnemyManagerRef.pushBack` (실드 배쉬 knockback; Phase 12 cast-only, contract since 2026-09-11 C-1). Shove enemies
   * away from `center`: every alive combatant within `radius` gets a horizontal impulse of `speed` m/s (falling off
   * linearly to 40 % at the rim) away from the centre, or along `dir` — the same `velocity` nudge an explosion applies
   * (a charging behemoth is **not** shoved). Authority: applies it, returns how many were pushed. Replica: sends one
   * `HitRequest { dmg: 0, kb }` per enemy in range and returns how many requests went out (X-6).
   */
  pushBack(center: THREE.Vector3, radius: number, speed: number, dir?: THREE.Vector3): number { return Dmg.pushBack(this, center, radius, speed, dir); }

  /**
   * Phase 9: other folders name the local player by its peer id (`ctx.net.localId ?? 'local'`); the kill-credit rules
   * key on `'local'`, so fold our own id back before it lands in `lastDamager` / `burnAttacker`.
   */
  normalizeAttacker(by: string): TargetId { return Dmg.normalizeAttacker(this, by); }

  reset(): void { return Pool.reset(this); }

  /* ── debug hooks (window.__game.getSystem('enemies')) ─────────────────── */
  /** Spawn one enemy at `position` (authority only). `chase` makes it hunt immediately. Returns the entity or null. */
  debugSpawn(type: EnemyType, position: THREE.Vector3 | { x: number; y?: number; z: number }, chase = false): Enemy | null {
    if (!this.authority || !this.ctx.world?.ready) return null;
    const world = this.ctx.world;
    _v.set(position.x, 0, position.z);
    _v.y = world.getHeightAt(_v.x, _v.z);
    if (type === 'rogue' || type === 'rogue_boss') {
      return this.spawnRogue(type, _v, 0, _v, type === 'rogue_boss' ? ROGUE_AI.bossWeapon : ROGUE_AI.weapons[0], null);
    }
    return this.spawn(type, _v, 0, chase, false);
  }
  /** Live artillery shells. */
  get shellCount(): number { return this.shells?.count() ?? 0; }
  /** Live rogue grenades (Phase 7). */
  get grenadeCount(): number { return this.grenades?.count() ?? 0; }
  /** Position of a live grenade thrown by rogue `id` (debug), or null. */
  debugGrenade(id: number): THREE.Vector3 | null { return this.grenades?.findByOwner(id) ?? null; }
  /** true while this client simulates the enemies (debug / smoke). */
  get isAuthority(): boolean { return this.authority; }
  /** true in a 시뮬레이션 훈련장 world (no spawning). */
  get isTrainingWorld(): boolean { return this.training; }
  /**
   * Phase 9 (debug / smoke): encode the next snapshot through the live delta cache exactly as the host send would
   * (advances `seq`, updates the cache). `force` = keyframe.
   */
  debugSnapshot(force = false): EnemySnapshot { return encodeSnapshot(this.active, this.ctx.time, this.snapCache, force); }
  /** Phase 9 (debug / smoke): feed a snapshot into the replica path (only meaningful after `setAuthority(false)`). */
  debugApplySnapshot(msg: EnemySnapshot): void { if (this.replica) this.replicaMgr.onSnapshot(msg); }
  /** Phase 9 (debug / smoke): delta-cache diagnostics + the replica's last seq / ignored-unknown count. */
  get debugSnapshotState(): { seq: number; cached: number; forceFull: boolean; lastFull: boolean; replicaSeq: number; ignoredUnknown: number; replicaLastFull: boolean } {
    return { seq: this.snapCache.seq, cached: this.snapCache.size, forceFull: this.snapCache.forceFull, lastFull: this.snapCache.lastFull, replicaSeq: this.replicaMgr.lastSeq, ignoredUnknown: this.replicaMgr.ignoredUnknown, replicaLastFull: this.replicaMgr.lastFull };
  }
  /** Wire animation hint (`EnemyWire.a`) enemy `id` would be sent with right now (debug / smoke), −1 when unknown. */
  debugHint(id: number): number { const e = this.byId.get(id); return e ? animHint(e) : -1; }
  /** Position of live shell `sid` (debug), or null. */
  debugShell(sid: number): THREE.Vector3 | null { return this.shells?.find(sid)?.position ?? null; }
  /**
   * Phase 11 (debug / smoke): the 행성 생태계 in force plus the numbers derived from it, or null with no planet.
   * `cap` is the ambient population ceiling at the current threat.
   */
  get debugEcology(): { bugs: Partial<Record<EnemyType, number>>; pressure: number; rogues: number; boss: boolean; maxArtillery: number; maxBehemoth: number; gatherDensity: number; threat: number; cap: number } | null {
    const eco = this.eco;
    if (!eco) return null;
    return {
      bugs: eco.bugs, pressure: eco.pressure, rogues: eco.rogues, boss: eco.boss,
      maxArtillery: eco.maxArtillery, maxBehemoth: eco.maxBehemoth, gatherDensity: eco.gatherDensity,
      threat: this.spawner.threat, cap: this.spawner.cap,
    };
  }
  /** Phase 11 (debug / smoke): the ambient population ceiling right now (`(12 + 24 × threat) × eco.pressure`). */
  get debugAmbientCap(): number { return this.spawner.cap; }
  /** Phase 11 (debug / smoke): one ambient patrol composition for `threat` through the live ecosystem. Spawns nothing. */
  debugAmbientGroup(threat: number): EnemyType[] { return ambientGroup(threat, this.eco).slice(); }
  /** Phase 11 (debug / smoke): one extraction-wave composition through the live ecosystem. Spawns nothing. */
  debugWaveGroup(index: number, count: number): EnemyType[] { return waveGroup(index, count, this.eco).slice(); }
  /** Phase 12 (debug / smoke): x-ray overlay state of enemy `id` (built overlay count, visible now, expiry). */
  debugXray(id: number): { overlays: number; visible: boolean; until: number } | null { return Status.debugXray(this, id); }
  /** Phase 12 (debug / smoke): enemies currently drawn through walls. */
  get xrayCount(): number { return this.xray.count; }
  /** Phase 12 (debug / smoke): feed a `shotq` through the host path as if peer `from` sent it (authority needed, no session). */
  debugShotReport(msg: ShotReport, from: PeerId): void { this.onShotReport(msg, from, true); }
  /**
   * 2026-09-09 (debug / smoke): 로그 강하 상태 — 진행 중인 강하, 이번 레이드에 굴린 횟수 / 실제로 부른 횟수.
   * `rolls` 는 `structure:investigated` 로 굴린 구역 수(실패 포함)이고 `calls` 는 성공해서 부른 강하 수다.
   */
  get debugRogueDrops(): { pending: RogueDropView[]; rolls: number; calls: number } {
    return { pending: this.rogueDrops.views().slice(), rolls: this.rogueDrops.rolls, calls: this.rogueDrops.calls };
  }
  /** 2026-09-09 (debug / smoke): `structure:investigated` 없이 굴림 경로를 그대로 태운다 (구역당 1회 규칙 포함). */
  debugInvestigate(zoneId: string, position: THREE.Vector3): void { this.rogueDrops.onInvestigated(zoneId, position); }
  /**
   * 2026-09-11 (debug / smoke): 판정 없이 네임드 `type` 을 세운다 (헤비면 SMG 호위 포함). `at` 이 없으면 플레이어 앞 40 m.
   * 권한만. `enemy:namedSpawned` 는 나가지만 이번 레이드의 굴림 기록은 건드리지 않는다.
   */
  debugSpawnNamed(type: NamedRogueType, at?: { x: number; z: number }): Enemy | null { return this.named.debugSpawn(type, at); }
  /** 2026-09-11 (debug / smoke): 이번 레이드의 네임드 굴림 — 확률 · 굴린 값 · 뽑힌 종류 · 자리 · 호위 수. */
  debugNamedRoll(): NamedRollResult { return this.named.debugRoll(); }
  /** Phase 11 (debug / smoke): rogues placed as crate guards right now (boss included). */
  debugGuardCount(): { rogues: number; boss: boolean } {
    let rogues = 0; let boss = false;
    for (const e of this.active) {
      if (!e.active || e.state === 'dead') continue;
      if (e.type === 'rogue') rogues++;
      else if (e.type === 'rogue_boss') { rogues++; boss = true; }
    }
    return { rogues, boss };
  }

  /* ── client → host requests (authority only) ───────────────────────────── */
  /** `hit` from a client: damage (as before) and / or the status bits (`st` + `dur`, 2026-09-06; `dmg` may be 0 for a status-only request). */
  private onHitRequest(msg: HitRequest, from: string): void { return Dmg.onHitRequest(this, msg, from); }

  private onExplodeRequest(p: readonly number[], r: number, dmg: number, from: string): void { return Dmg.onExplodeRequest(this, p, r, dmg, from); }

  /* ── SpawnHost ─────────────────────────────────────────────────────────── */
  aliveCount(): number { return Pool.aliveCount(this); }

  countAlive(type: EnemyType): number { return Pool.countAlive(this, type); }

  ensureCapacity(n: number, cap: number): number { return Pool.ensureCapacity(this, n, cap); }

  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean): Enemy | null { return Pool.spawn(this, type, position, yaw, chase, relentless); }

  /* ── RogueSpawnHost ────────────────────────────────────────────────────── */
  spawnRogue(type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null): Enemy | null { return Pool.spawnRogue(this, type, position, yaw, guardPos, weaponId, escortOf); }

  /* ── ReplicaHost ───────────────────────────────────────────────────────── */
  find(id: number): Enemy | undefined { return Pool.find(this, id); }

  /** Pool → active with an explicit id (host-assigned on the authority, host's id on replicas). Silent. */
  acquire(id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null { return Pool.acquire(this, id, type, position, yaw); }

  release(e: Enemy): void { return Pool.release(this, e); }

  bloodBurst(point: THREE.Vector3, count: number, dir: THREE.Vector3 | null): void { return RFx.bloodBurst(this, point, count, dir); }

  acidVisual(from: THREE.Vector3, target: CombatTarget, shooterId: number): void { return RFx.acidVisual(this, from, target, shooterId); }

  acidVisualAt(from: THREE.Vector3, to: THREE.Vector3, shooterId: number): void { return RFx.acidVisualAt(this, from, to, shooterId); }

  rogueShotVisual(id: number, from: THREE.Vector3, to: THREE.Vector3, hit: boolean): void { return RFx.rogueShotVisual(this, id, from, to, hit); }

  shellVisual(sid: number, from: THREE.Vector3, target: THREE.Vector3, flight: number): void { return RFx.shellVisual(this, sid, from, target, flight); }

  shellInterceptedRemote(sid: number, p: THREE.Vector3): void { return RFx.shellInterceptedRemote(this, sid, p); }

  shellLandedRemote(sid: number, p: THREE.Vector3): void { return RFx.shellLandedRemote(this, sid, p); }

  chargeVisual(id: number, target: THREE.Vector3): void { return RFx.chargeVisual(this, id, target); }

  toxicVisual(id: number, p: THREE.Vector3): void { return RFx.toxicVisual(this, id, p); }

  corpseSpawnedRemote(id: number, type: EnemyType, p: THREE.Vector3, weaponId: string | undefined, opts?: CorpseWireOpts): void { return RFx.corpseSpawnedRemote(this, id, type, p, weaponId, opts); }

  corpseGoneRemote(id: number): void { return RFx.corpseGoneRemote(this, id); }

  grenadeVisual(id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number): void { return RFx.grenadeVisual(this, id, p, v, fuse); }

  grenadeHitRemote(p: THREE.Vector3): void { return RFx.grenadeHitRemote(this, p); }

  despawn(e: Enemy): void { return Pool.despawn(this, e); }

  private disposePools(): void { return Pool.disposePools(this); }

  /* ── EnemyHost ─────────────────────────────────────────────────────────── */
  alertNear(position: THREE.Vector3, radius: number, source: Enemy | null): void { return Alert.alertNear(this, position, radius, source); }

  /** Strongest lure covering `pos`: own distraction list merged with the authoritative gadget beacon. */
  lureFor(pos: THREE.Vector3, out: THREE.Vector3): number { return Alert.lureFor(this, pos, out); }

  /** Spit at an explicit point (smoke return fire / deployables) — the glob still hurts whoever it lands on. */
  fireAcidAt(from: THREE.Vector3, aimFeet: THREE.Vector3, shooter: Enemy): void { return Atk.fireAcidAt(this, from, aimFeet, shooter); }

  emberBurst(position: THREE.Vector3, count: number): void { return Atk.emberBurst(this, position, count); }

  /* ── Phase 7: rogue grenades ───────────────────────────────────────────── */
  /** Authority: lob a grenade from the rogue's off hand onto `target` (feet), `ee grenade` to the others. */
  throwGrenade(e: Enemy, target: THREE.Vector3): boolean { return Atk.throwGrenade(this, e, target); }

  /* ── GrenadeHost ───────────────────────────────────────────────────────── */
  /**
   * Fuse ran out. Authority: ROGUE_GRENADE_DAMAGE with linear falloff over ROGUE_GRENADE_RADIUS to every alive player
   * (local directly, remote via `dmg {kb}`, suspended via `ghost:damage`) and to enemies of the other faction, blast
   * noise, `ee grenadeHit`. Everyone: audio, shake near the local player.
   */
  onGrenadeExploded(p: THREE.Vector3, authority: boolean, owner: number): void { return Atk.onGrenadeExploded(this, p, authority, owner); }

  /* ── status effects (burning / slow / 전소 / shocked) ──────────────────── */
  private updateStatuses(dt: number): void { return Status.updateStatuses(this, dt); }

  /**
   * A shot was heard. Wakes bugs (hearing) and, for those that cannot see through the smoke it came out of,
   * records a suspicion point they answer with very inaccurate fire. Gunfire also acts as a weak lure.
   */
  private onGunshot(position: THREE.Vector3, radius: number): void { return Alert.onGunshot(this, position, radius); }

  alertHearing(position: THREE.Vector3, radius: number): void { return Alert.alertHearing(this, position, radius); }

  /**
   * 2026-09-11 (적 ↔ 드론): `world:noise` (지상 드론 질주). 들을 수 있는 거리 안의 아직 아무도 인지하지 못한 적이 그
   * 소리 쪽을 조사한다(`ai/Investigate`). 표적은 주지 않는다 — 드론이 보이면 `pickTarget` 이 고른다. 권한 전용.
   */
  onWorldNoise(position: THREE.Vector3, radius: number): void { return Alert.onWorldNoise(this, position, radius); }

  /** 2026-09-11 (debug / smoke): 적이 지금 노릴 수 있는 드론 프록시 — id · 밑면 고도(m). */
  get debugDroneTargets(): Array<{ id: string; altitude: number }> {
    return this.targets.drones.map((t) => ({ id: t.droneId ?? '', altitude: t.droneAltitude }));
  }

  /**
   * Phase 4 target selection. Bugs: nearest of (alive players, rogues within sight radius) — equal priority.
   * Rogues: the nearest alive player within ROGUE_RANGE; otherwise a bug within ROGUE_AI.bugRange, else the nearest player.
   */
  pickTarget(e: Enemy): CombatTarget | null { return Alert.pickTarget(this, e); }

  fireAcid(from: THREE.Vector3, shooter: Enemy, target: CombatTarget): void { return Atk.fireAcid(this, from, shooter, target); }

  hitTarget(e: Enemy, damage: number, shake = 0, target: CombatTarget | null = e.target): void { return Dmg.hitTarget(this, e, damage, shake, target); }

  bitePitch(type: EnemyType): number { return Atk.bitePitch(this, type); }

  /** Rogue hitscan shot (authority): occlusion, player capsules, enemy hitboxes, damage, FX, audio, events, wire. */
  fireGun(e: Enemy, target: CombatTarget, aimError: number, damageMul: number, opts?: RogueShotOpts): boolean { return Atk.fireGun(this, e, target, aimError, damageMul, opts); }

  /** Tracer + muzzle flash sprite (no lights) + rifle report at the muzzle. */
  shotFx(from: THREE.Vector3, to: THREE.Vector3, hit: number): void { return Atk.shotFx(this, from, to, hit); }

  /** Artillery: shell `sid` toward the target's predicted position, landing after SHELL_FLIGHT_TIME. */
  fireShell(e: Enemy, target: CombatTarget): boolean { return Atk.fireShell(this, e, target); }

  /* ── ShellHost ─────────────────────────────────────────────────────────── */
  onShellLanded(sid: number, p: THREE.Vector3): void { return Atk.onShellLanded(this, sid, p); }

  onShellIntercepted(sid: number, p: THREE.Vector3, local: boolean): void { return Atk.onShellIntercepted(this, sid, p, local); }

  /* ── behemoth ──────────────────────────────────────────────────────────── */
  chargeHit(e: Enemy, target: CombatTarget, damage: number, knockDir: THREE.Vector3): void { return Dmg.chargeHit(this, e, target, damage, knockDir); }

  onChargeStarted(e: Enemy, target: THREE.Vector3): void { return RFx.onChargeStarted(this, e, target); }

  /* ── AcidHost ──────────────────────────────────────────────────────────── */
  damageTargetAcid(target: CombatTarget, amount: number, from: THREE.Vector3, shooterId: number, slow: AcidSlow): void { return Dmg.damageTargetAcid(this, target, amount, from, shooterId, slow); }

  /**
   * Phase 9: does a 배리어 stand between `from` and the target's chest? If so the barrier takes the block damage
   * (`ImplantsRef.damageBarrier`) and the caller deals none. One pure raycast per call — call it per hit, never per tick.
   */
  barrierBlocks(from: THREE.Vector3, target: CombatTarget): boolean { return Dmg.barrierBlocks(this, from, target); }

  /**
   * Route damage to a target. Local player → `ctx.player.takeDamage` + `enemy:attacked` (+ slow / shake).
   * Remote player → `dmg` message to that peer (net applies it there) and, when `announce`, an `ee attack` to everyone
   * else so they hear the bite (the victim mirrors `enemy:attacked` from it).
   * Phase 4: an enemy target (`target.enemy`) takes `takeDamage(…, 'ai')` — no kill credit, faction clash toast.
   * Phase 7: `kbDir` / `kbSpeed` = knockback (behemoth charge, grenade blast): local → `applyKnockback`, remote →
   * `dmg.kb`; a **suspended** member (host-simulated ghost) gets `ghost:damage {id, amount, from, kb}` on the bus
   * instead of a `dmg` message.
   * Phase 12: `melee` = a bite / leap / charge contact. Before it lands on a player the raised 배리어 of that player
   * gets to absorb it (`ImplantsRef.absorbFrontalAttack`): the local carrier's shield is deducted by implants right
   * there, a peer's carrier gets `ee barrierHit` (its own shield takes it) and no `dmg`. Ranged attacks (rifle,
   * shell, acid, grenade) keep the `raycastBarrier` path of their callers.
   */
  applyDamage(target: CombatTarget, amount: number, from: THREE.Vector3, id: number, type: EnemyType, slow: AcidSlow | null, shake: number, announce: boolean, kbDir: THREE.Vector3 | null = null, kbSpeed = 0, melee = false): void { return Dmg.applyDamage(this, target, amount, from, id, type, slow, shake, announce, kbDir, kbSpeed, melee); }

  /**
   * Phase 12: does the player target's raised shield face the attacker at `from` and take this melee hit? True = the
   * caller applies nothing more. Local owner: implants deducted its shield inside `absorbFrontalAttack`. Peer owner:
   * `ee barrierHit` to that peer alone (no `dmg`, no `ee attack` — the peer plays the bite on its shield itself).
   * A suspended member's shield state is whatever the host last mirrored; if implants says it absorbed, it absorbed.
   */
  absorbedByShield(target: CombatTarget, from: THREE.Vector3, amount: number, id: number): boolean { return Dmg.absorbedByShield(this, target, from, amount, id); }

  /** Phase 12 (ReplicaHost): the host says enemy `id` bit **my** raised shield — the local shield takes it, bite FX at `p`. */
  barrierHitRemote(id: number, p: THREE.Vector3, amount: number): void { return Dmg.barrierHitRemote(this, id, p, amount); }

  /* ── Phase 12: 배리어 충돌 (EnemyHost) ─────────────────────────────────── */
  /**
   * Called from `ai/EnemyAI.integrate` after every grounded enemy moved: `ImplantsRef.resolveBarrierCollision` pushes
   * the body out of any raised shield and names the carrier. On contact the enemy hunts the carrier for
   * BARRIER_RETARGET_S (`pickTarget` honours `barrierOwner`), wakes up if it was idle, and `implant:barrierBumped`
   * fires at most every BARRIER_BUMP_INTERVAL per enemy (implants sparks / audio thuds from it).
   */
  resolveBarrier(e: Enemy): void { return Dmg.resolveBarrier(this, e); }

  /* ── Phase 12: 총알 추적 ───────────────────────────────────────────────── */
  /**
   * `shotq` from a client (host only): validate and run the shooter's report as if it were local, credited to `from`.
   * `force` (debug / smoke) skips the session gate but keeps the authority one and the validation.
   */
  private onShotReport(msg: ShotReport, from: PeerId, force = false): void { return Alert.onShotReport(this, msg, from, force); }

  /**
   * The alert routine (authority). Every alive simulated enemy that has **no perceived target** (unaware, not
   * incapacitated / staggered / fleeing / a wave bug) and sits within `ENEMY_SHOT_ALERT_DIST` of the bullet path
   * (closest approach of its body centre to origin → origin + dir × range) or `ENEMY_SHOT_IMPACT_DIST` of the
   * impact, and that could **not** perceive the shooter by the normal rule (`canPerceive`, no cone — it would spot the
   * shooter on its own next tick anyway), starts investigating the origin (`ai/Investigate.ts`) → `enemy:shotAlerted`
   * once. An enemy already investigating only refreshes its origin. The perception test is throttled per enemy.
   */
  alertShot(origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null, shooter: TargetId): void { return Alert.alertShot(this, origin, dir, range, hit, shooter); }

  /** First bug ↔ rogue engagement within CLASH_RADIUS of the local player (throttled) → `enemy:factionClash`. */
  noteClash(position: THREE.Vector3): void { return Alert.noteClash(this, position); }

  /** Replica: optimistic gore/audio for a local shot, then ask the host to apply it. */
  requestHit(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void { return Dmg.requestHit(this, e, amount, part, hitPoint, hitDir); }

  onEnemyDamaged(e: Enemy, amount: number, part: HitPart, hitPoint: THREE.Vector3 | undefined, hitDir: THREE.Vector3 | undefined): void { return Dmg.onEnemyDamaged(this, e, amount, part, hitPoint, hitDir); }

  onEnemyKilled(e: Enemy, countKill: boolean): void { return Dmg.onEnemyKilled(this, e, countKill); }

  /**
   * Authority: register the `corpse:<id>` interactable at the body's **resting** position and mirror it to the
   * clients. Called from `onEnemyKilled` for a ground kill (same frame, as before) and from the update loop once a
   * mid-air body lands or `CORPSE_LAND_TIMEOUT` runs out.
   * Phase 10: the lootable roll (`CORPSE_LOOT_CHANCE`) happens here, on its own seeded stream — `rollCorpse` is only
   * ever called afterwards, by `Corpse.interact()`, so its stream is untouched.
   */
  registerCorpse(e: Enemy): void { return Dmg.registerCorpse(this, e); }

  acidBurst(e: Enemy): void { return Atk.acidBurst(this, e); }

  /** Toxic burst (authority): TOXIC_DAMAGE with falloff to players and enemies of both factions, green FX, event, wire. */
  toxicBurst(e: Enemy): void { return Atk.toxicBurst(this, e); }

  toxicFx(p: THREE.Vector3): void { return Atk.toxicFx(this, p); }

  playAudio(id: string, position: THREE.Vector3, volume = 1, pitch = 1): void { return RFx.playAudio(this, id, position, volume, pitch); }

  /* ── helpers ───────────────────────────────────────────────────────────── */
  private fleeFrom(position: THREE.Vector3, radius: number): void { return Alert.fleeFrom(this, position, radius); }
}

// CORPSE_LIFETIME is applied per entity (`Enemy.corpseLife`); re-exported here for smoke scripts.
export { CORPSE_LIFETIME };
