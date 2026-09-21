import * as THREE from 'three';
import type { RogueShotOpts } from './Enemy';
import {
  CORPSE_LAND_TIMEOUT, CORPSE_LIFETIME, FLAME_AFTERBURN_DPS, MAP_SIZE,
  NET_ENEMY_SNAPSHOT_HZ, PLAYER_HEIGHT, ROGUE_MAG_ROUNDS, ENEMY_AI_LOD_HALF_M, ENEMY_AI_LOD_MAX_STEP_S, ENEMY_AI_LOD_QUARTER_M, ENEMY_ANIM_LOD_FREEZE_M, ENEMY_ANIM_LOD_HALF_M, viewZoomK, SHOCK_SLOW_FACTOR, getPlanet, planetThreat,
  type EnemyEvent, type EnemyFaction, type EnemyHit, type EnemyManagerRef, type EnemyRef, type EnemySnapshot, type EnemyStatusKind, type EnemyType, type GameContext, type GameSystem,
  type HitRequest, type InterceptableRef, type PeerId, type PlanetEcosystem, type ShotReport, type WorldRef,
  /* appended (2026-09-09): the rogue drop contract */
  type RogueDropView,
  /* appended (2026-09-10): enemy grenades, read by the HUD danger indicators */
  type GrenadeView,
  /* appended (2026-09-11): the named rogue debug hooks */
  type NamedRogueType,
  /* appended (2026-09-13): the per-planet humanoid faction contract */
  type HumanoidSpawnOpts,
  /* appended (2026-09-15, B-16): enemy fire zones, read by the HUD */
  type FireZoneInfo,
} from '@/shared';
import { Enemy, type EnemyHost, type HitPart } from './Enemy';
import { HUMANOID_WEAPONS, ROGUE_AI } from './EnemyTypes';
import { SpatialGrid } from './SpatialGrid';
import { CombatTarget, TargetList, type TargetId } from './Targets';
import { updateEnemyAI } from './ai/EnemyAI';
import { LureField } from './ai/Lures';
import { BloodFX } from './fx/BloodFX';
import { EnemyXray } from './fx/Xray';
import { AcidProjectiles, type AcidHost, type AcidSlow } from './fx/AcidProjectile';
import { ShellProjectiles, type ShellHost } from './fx/ShellProjectile';
import { RogueGrenades, type GrenadeHost } from './fx/RogueGrenade';
import { AmbientSpawner, ambientGroup, waveGroup, type SpawnHost } from './Spawner';
import { WaveDirector } from './WaveDirector';
/* appended (2026-09-18): bug nests — eggs · anchors · the garrison · refill */
import { NestDirector } from './NestDirector';
import { EnemyReplica, type ReplicaHost } from './net/Replica';
import { animHint, encodeSnapshot, SnapshotCache } from './net/HostSync';
import { CorpseManager, type CorpseWireOpts } from './Corpses';
import type { RogueSpawnHost } from './RogueGuards';
import { placeSiteGroups, type SitePlacement } from './SiteGroups';
/* appended (2026-09-15, B-16): the empty fire zone list used when there is no pool */
import { EMPTY_FIRE_ZONES } from './model';
/* appended (2026-09-14): tutorial-only enemies — fixed spots · fixed types (`Tutorial.ts`) */
import { placeTutorialEnemies, type TutorialPlacement } from './Tutorial';
/* appended (2026-09-15): the tutorial bug chain spawn · per-stretch aggro release · the liftoff fire window */
import { onTutorialCheckpoint, onTutorialFell, onTutorialLiftoff, updateTutorialScript } from './Tutorial';
import { RogueDropDirector, type RogueDropHost } from './RogueDrop';
import { NamedRogueDirector, type NamedRollResult } from './named/Director';
import { isNamedAiType } from './ai/named';   // 2026-09-20: a named rogue is never reduced by the AI LOD, nor by the animation LOD
/* appended (2026-09-13): the dig-in spawn · the sandworm */
import { BURROW_EMERGE_S } from '@/shared';
import { SandwormDirector } from './sandworm/Director';
import { BurrowFx } from './fx/BurrowFx';
import * as Burrow from './parts/Burrow';
import { raySphere, rayCapsule, standingTopY } from './RayTests';
/* appended (2026-09-14): bug difficulty (planet threat) */
import { bugThreatTuning, type BugThreatTuning } from './factionTables';
import { ambientOptsOf, artilleryDigInChance, maxArtilleryOf, maxBehemothOf, threatEcosystem } from './Spawner';
import { carryCorpse } from './ai/Ride';
/* appended (2026-09-21, TODO A-18 phase 2): enemy pathfinding */
import { EnemyNavState, describeNav } from './ai/NavMove';
import { beginTraverse } from './ai/Traverse';
import type { NavLinkKind } from '@/shared';
import { BODY_RAY_VERTICAL, namedBodyNormal, namedBodyRay } from './models/named';

import { BURN_TICK, FLEE_DURATION, PROMOTE_ID_GAP, PROMOTE_SEQ_GAP, SHOCK_SPARK_TIME, EMPTY_GRENADES, _aim, _c, _dir, _eye, _hc, _hd, _hp, _kb, _m, _sd, _sh, _so, _to, _v, _v2, _zero, queryBuf } from './model';
/** The folder's shared vocabulary (constants · types · scratch) lives in `model.ts` — re-exported here for the existing import paths. */
export * from './model';
import * as Dmg from './parts/Damage';
import * as Atk from './parts/Attacks';
import * as Alert from './parts/Alerts';
import * as Status from './parts/Status';
import * as Pool from './parts/Pool';
import * as RFx from './parts/RemoteFx';
/* appended (2026-09-16): removing an emptied corpse */
import * as CorpseEmpty from './parts/CorpseEmpty';
/* appended (2026-09-15, the result screen rework): the cause-of-death thumbnail · enemy names */
import { enemyDisplayNameOf, renderEnemyPortrait } from './models/Portrait';
/* appended (2026-09-15, android squadmates): the target · damage · cover queries */
import type { AllyBodyView, CoverSpot } from '@/shared';
import { pickCoverSpot, type CoverQuery } from '@/shared';
import { COVER_EYE, COVER_MAX_RANGE_FRAC, COVER_MIN_TARGET_DIST, COVER_SEARCH_RADIUS, STAND_EYE } from './ai/RogueCover';
import { ENEMY_WALL_STANDOFF } from '@/shared';

/**
 * The radius a gunshot is heard within (m). A person (`weapon:fired` · `net:remoteFired`) and an android
 * (`ally:fired`) use **the same value** — an android fires the same guns, so an enemy has no reason to hear it
 * differently. An algorithmic constant, so not a csv one.
 */
const GUNSHOT_NOISE_R = 55;
const _allyDir = new THREE.Vector3();
const _allyHit = new THREE.Vector3();
const _coverFrom = new THREE.Vector3();
const _coverThreat = new THREE.Vector3();
const _debugSpot: CoverSpot = { cover: new THREE.Vector3(), pop: new THREE.Vector3(), hasPop: false, score: 0 };

export class EnemySystem implements GameSystem, EnemyManagerRef, EnemyHost, SpawnHost, RogueSpawnHost, RogueDropHost, AcidHost, ShellHost, ReplicaHost, GrenadeHost {
  readonly name = 'enemies';
  ctx!: GameContext;
  /* ── Phase 12: shot tracking · the recon x-ray (EnemyManagerRef) ─────── ── */
  /**
   * A local shot was fired (weapons calls this for every one). Authority: run the alert routine; a joined client
   * forwards it to the host as `shotq` instead (replicas have no AI). No-op in the training range.
   */
  reportShot(origin: THREE.Vector3, dir: THREE.Vector3, range: number, hit: THREE.Vector3 | null): void { return Alert.reportShot(this, origin, dir, range, hit); }

  /**
   * The recon x-ray: red through-wall silhouette for these enemies (simulated or replica) for `seconds`; a second call
   * extends. Unknown ids are ignored; `seconds <= 0` hides the listed ones (`[]` + 0 is a no-op).
   */
  setXray(ids: readonly number[], seconds: number): void { return Status.setXray(this, ids, seconds); }
  /* ── appended (2026-09-09): rogue drops (`RogueDrop.ts` owns all of it) ── */
  /**
   * **Host only**: drops a rogue squad in (announced → landing after `ROGUE_DROP_ETA_S` → advancing on the structure).
   * The **squad's head count** decides how many and whether a boss comes. false when the same `dropId` is already
   * running, or this is not the host.
   */
  callRogueDrop(dropId: string, position: THREE.Vector3): boolean { return this.rogueDrops.call(dropId, position); }
  /** The drops in progress (for the HUD warning · the off-screen arrow). */
  getRogueDrops(): readonly RogueDropView[] { return this.rogueDrops.views(); }
  /** 2026-09-10: enemy grenades in the air — the HUD danger indicators read them alongside friendly ones. */
  getEnemyGrenades(): readonly GrenadeView[] { return this.grenades?.getViews() ?? EMPTY_GRENADES; }
  /**
   * 2026-09-15 (B-16): the live enemy incendiary fire zones — both the authority's zones and a replica's visual ones
   * (`ee grenadeHit.k`), all `hostile`.
   * The HUD calls it every frame — `RogueGrenades` reuses the array and the per-slot objects.
   */
  getFireZones(): readonly FireZoneInfo[] { return this.grenades?.getFireZones() ?? EMPTY_FIRE_ZONES; }
  /** 2026-09-15 (the result screen rework): the enemy face thumbnail on the cause-of-death row — drawn once by its own offscreen renderer and cached (`models/Portrait`). */
  renderPortrait(enemyType: string, sizePx: number): string | null { return renderEnemyPortrait(enemyType, sizePx); }
  /** 2026-09-15 (the result screen rework): an enemy type's display name (`models/Portrait`). null for an unknown type. */
  enemyDisplayName(enemyType: string): string | null { return enemyDisplayNameOf(enemyType); }
  /** Rogue drops — the roll record · pod FX · the landing spawn (host authority; it does nothing in the training range). */
  readonly rogueDrops = new RogueDropDirector();
  /** 2026-09-11: named rogues — one roll per raid · the spot · the spawn · `enemy:namedSpawned` (`named/Director.ts`). */
  readonly named = new NamedRogueDirector();
  /** 2026-09-13: the sandworm — the per-raid roll · its omen · the eruption · spitting · poison · syncing (`sandworm/Director.ts`). */
  readonly sandworm = new SandwormDirector();
  /** 2026-09-13: the dig-in dust · clods · the omen ring (`fx/BurrowFx.ts`). */
  burrowFx: BurrowFx | null = null;
  /** 2026-09-13: ctx.time of the last burrow camera shake (`parts/Burrow.burrowShake` dedupe) · how many went out (debug). */
  burrowShakeAt = -Infinity;
  burrowShakes = 0;
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
  /**
   * 2026-09-18 (bug nests): nest eggs (`bug_egg`) · nest anchors · the garrison leash · refill (user's decision
   * 「60 m 리시 · 초기 수 절반 · 재스폰 50/35/15 %」). Authority-only with no new wire — a replica sees only `ee spawn`.
   */
  readonly nests = new NestDirector();
  readonly spawner = new AmbientSpawner();
  readonly waves = new WaveDirector();
  readonly replicaMgr = new EnemyReplica(this);
  /** Noise beacons the bugs walk toward (`addDistraction`, gunfire). Merged with `ctx.gadgets.findDistraction`. */
  readonly lures = new LureField();
  /** ctx.time when the spatial grid was last rebuilt (so `queryNear` knows it can trust it). */
  private gridTime = -1;
  /**
   * 2026-09-20 (`docs/PERF.md` perf Phase 1, widened in Phase C): the camera position, read **once** at the top of
   * `update` and then shared by everything in the folder that needs the ear or the eye — the animation LOD, the AI
   * LOD and the footstep range gate (`EnemyHost.camPos` → `model.emitEnemyStep`). Beside it, the frame counter that
   * staggers the animation's half-rate band, so half the far bodies pose on one frame and the other half on the
   * next instead of every one of them stuttering together.
   */
  readonly camPos = new THREE.Vector3();
  private animFrame = 0;
  /**
   * 2026-09-20 (`docs/PERF.md` perf Phase C · B4): the AI LOD's frame counter (0..3) and the scratch list of
   * **anchors** — every position an enemy could act on this frame. Refilled with references (no allocation) at the
   * top of the AI pass; see `collectAiAnchors`.
   */
  private aiFrame = 0;
  /**
   * 2026-09-21 (TODO A-18 phase 2): what the pathfinding shares between bodies — the graph it was built for, the one flow-step
   * scratch, this frame's A* budget, the gate tokens (`ai/NavMove` · `ai/Gates`). Authority only; `beginFrame` runs at the top
   * of the AI pass, `Pool.reset` clears it.
   */
  readonly nav = new EnemyNavState();
  private readonly aiAnchors: THREE.Vector3[] = [];
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
  /** 2026-09-11 (C-14): seconds accumulated toward the next environmental hazard tick on enemies (`parts/Status.updateHazardDot`). */
  hazardTick = 0;
  lastClash = -Infinity;
  /** Current boss (authority) for debugging / HUD. */
  bossId = 0;
  /* ── 2026-09-13: the humanoid faction per planet (`SiteGroups.ts` · `RogueDrop.ts` · `named/Director.ts`) ── */
  /** This raid's target planet threat (1..3, set on `world:ready` — no planet · the training range = 1). The index into the site faction · drop chance · named chance. */
  planetThreatLevel: 1 | 2 | 3 = 1;
  /**
   * 2026-09-14: this raid's bug difficulty (`bugThreatTuning(planetThreatLevel)`; the training range = the threat 1 row)
   * — every client fixes it on `world:ready`.
   * `Pool.acquire` multiplies a faction-bug's max hp by `hpMul` (a replica arrives at the same value, so no wire field
   * is needed).
   */
  bugTuning: BugThreatTuning = bugThreatTuning(1);
  /** 2026-09-14: the effective ecosystem = the planet's eco × bug difficulty (`threatEcosystem`) — read by patrols · waves · the sandworm. `eco` stays the planet's own. */
  private spawnEco: PlanetEcosystem | null = null;
  /** The next squad id (`allocSquadId`; `Pool.reset` puts it back to 1). */
  nextSquadId = 1;
  /** The record of site occupation at the raid's start (authority only, for debug · smokes — `debugSites()`). */
  sitePlacement: SitePlacement | null = null;
  /** `RogueSpawnHost.allocSquadId` — a new squad id, unique within this raid. */
  allocSquadId(): number { return this.nextSquadId++; }
  /* ── Phase 7 ── */
  /** The simulation training range: no spawner / waves / guards / initial population (set at `world:ready`). */
  training = false;
  /* ── 2026-09-14: tutorial-only enemies (`Tutorial.ts`) ── */
  /**
   * A tutorial raid (`ctx.missionMode === 'tutorial'`): only enemies at **fixed spots, of fixed types**, stand — rolls ·
   * patrols · the spawner · waves · site groups · raider drops · a named · the sandworm · shot tracking are all off, as
   * in the training range.
   * The one difference from the training range is that **there are enemies**. Fixed on `world:ready`.
   */
  tutorial = false;
  /** What this tutorial raid stood up (once, on the authority, for debug · smokes — `debugTutorial()`). */
  tutorialPlacement: TutorialPlacement | null = null;
  /**
   * 2026-09-14 (4th pass) — this raid's corpse lifetime (s). **In a tutorial raid a corpse never disappears.**
   * The fixed drops the tutorial lays out to teach with (the bug on the left · the android on the right) could not
   * survive 45 s at the pace of someone walking slowly while reading the objective panel, and read as 「there is no
   * drop」. What differs is the **rule**, not a number (it stays to the end of the raid, like the player corpses in
   * `ctx.corpses`), so no new csv value was made for it.
   * Both the body (`Enemy.corpseLife` — `Pool.acquire`) and the search spot (`CorpseManager.lifetime`) use this value.
   */
  get corpseLifetime(): number { return this.tutorial ? Infinity : CORPSE_LIFETIME; }
  /* ── Phase 11 ── */
  /** Ecosystem of the target planet this mission runs on (`world:ready.planet` → `PLANET_DEFS`), null = the default tables. */
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
    /** appended 2026-09-16: `ecorpseq emptied` refused (shape · sender · range · rate — `parts/CorpseEmpty`). */
    corpseEmptyRefused: 0,
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
    this.nests.bind(this);   // 2026-09-18: bug nests
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
        // 2026-09-14: the tutorial world — split off at the same place, by the same trick, as the training range (`ctx.missionMode` is set by game/ before the emit)
        this.tutorial = !this.training
          && (ctx.missionMode === 'tutorial' || (ctx.world as Partial<WorldRef> | null)?.mode === 'tutorial');
        // 2026-09-14 (4th pass): the corpse lifetime is decided per raid (the tutorial = never disappears). `reset()` has already run, so it binds to this raid alone.
        this.corpses.lifetime = this.corpseLifetime;
        // Phase 11: the target planet's ecosystem → spawner / waves / guards. Training keeps it null; so does a mission without a planet
        // (the ecosystem is host-side composition only — the `es` / `ee` wire and replica behaviour are untouched).
        // 2026-09-14: the tutorial has no planet either — handled like the training range, so the bug difficulty multiplier is ×1.
        const scripted = this.training || this.tutorial;
        const planetId = scripted ? null : (planet ?? ctx.world?.planet ?? ctx.missionPlanet ?? null);
        this.eco = scripted ? null : (getPlanet(planetId)?.eco ?? null);
        // 2026-09-13: planet threat → the site faction · raider drop chance · named chance. Every client fixes it (for a promoted host's drop roll)
        this.planetThreatLevel = planetThreat(planetId);
        // 2026-09-14: bug difficulty — the hp multiplier (`Pool.acquire`; a replica arrives at the same value) · the share of big bugs · the caps (the effective ecosystem). The training range = the threat 1 row.
        this.bugTuning = bugThreatTuning(scripted ? 1 : this.planetThreatLevel);
        this.spawnEco = threatEcosystem(this.eco, this.bugTuning);
        this.spawner.eco = this.spawnEco;
        this.spawner.tuning = this.bugTuning;
        this.waves.eco = this.spawnEco;
        if (this.training) return;
        // 2026-09-14: the tutorial — the list the world fixed is read **once**, stood up as it is, and that is all. No
        // rolls, no site groups, no named. With `ctx.world.tutorial` still a null stub the list is empty and it ends
        // quietly with 0 enemies.
        if (this.tutorial) {
          if (this.authority && ctx.world?.ready) {
            this.targets.refresh(ctx);
            this.tutorialPlacement = placeTutorialEnemies(this, ctx.world.tutorial?.enemySpawns() ?? []);
          }
          return;
        }
        if (this.authority && ctx.world?.ready) {
          this.targets.refresh(ctx);
          /* 2026-09-18 (bug nests): the eggs stand first, then the nest anchors · refill counts are rolled, and only then
             the garrison is laid out — the anchors have to exist for `initialPopulate`'s packs to bind as 「that nest's
             garrison」 (`NestDirector`'s header comment). */
          this.nests.eco = this.spawnEco;
          this.nests.tuning = this.bugTuning;
          this.nests.threat = this.spawner.threat;
          this.nests.onWorldReady();
          this.spawner.initialPopulate(this, playerSpawn, this.nests.anchors, (index, from) => this.nests.claimGarrison(index, this, from));
          // 2026-09-13: crate guards retired → site groups by planet threat (android · rogue · raider)
          const sites = placeSiteGroups(this, seed, this.planetThreatLevel);
          this.sitePlacement = sites;
          if (sites.boss) {
            this.bossId = sites.boss.id;
            ctx.bus.emit('enemy:bossSpawned', { id: sites.boss.id, type: sites.boss.type, position: sites.boss.position });
          }
          // 2026-09-11: the named — once per raid, after the site placement (it is rolled only on world:ready, so a promoted host never rolls again)
          this.named.roll(planetId);
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
      bus.on('weapon:fired', ({ origin }) => this.onGunshot(origin, GUNSHOT_NOISE_R)),
      bus.on('net:remoteFired', ({ origin }) => this.onGunshot(origin, GUNSHOT_NOISE_R)),
      bus.on('grenade:exploded', ({ position }) => this.onGunshot(position, 80)),
      /* 2026-09-15 (android squadmates): an android's round is heard **exactly like a person's gunshot** — the same
         noise radius + shot tracking (`alertShot`). The event fires on every client, so only the authority reacts
         (`onGunshot` · `alertShot` check the authority themselves, but there is no reason to run the vector maths on a
         replica too). The shooter is not a person's id, so it is `'ai'` — there is no 「it can already see the shooter」
         exception, and every unaware enemy nearby goes to investigate. */
      bus.on('ally:fired', ({ from, to }) => {
        if (!this.authority || this.training || !this.ctx.world?.ready) return;
        this.onGunshot(from, GUNSHOT_NOISE_R);
        _allyDir.subVectors(to, from);
        const range = _allyDir.length();
        if (range < 1e-3) return;
        _allyDir.multiplyScalar(1 / range);
        _allyHit.copy(to);
        this.alertShot(from, _allyDir, range, _allyHit, 'ai');
      }),
      // 2026-09-13: extraction defence waves removed (user's decision) — `extraction:activated` no longer calls a wave
      bus.on('extraction:liftoff', ({ position }) => {
        if (!this.authority) return;
        /* 2026-09-15 (user's decision — 「처치하지 않은 안드로이드가 이륙하는 함선 안의 PC 를 실제로 쏜다」): a tutorial enemy
           does not flee. An 18 m flight would make the android beside the ship lower its gun and turn its back — the
           liftoff fire window opens instead (`Tutorial.ts`). */
        if (this.tutorial) { onTutorialLiftoff(this.tutorialPlacement); return; }
        this.fleeFrom(position, 18);
      }),
      /* 2026-09-15: per-stretch tutorial aggro release — on a checkpoint (`crawl` → the bugs · `supply` → the humanoids on the cliff) and on a fall (`Tutorial.ts`) */
      bus.on('tutorial:checkpoint', ({ id }) => { if (this.tutorial && this.authority) onTutorialCheckpoint(this, this.tutorialPlacement, id); }),
      bus.on('player:fell', ({ rule }) => { if (this.tutorial && this.authority) onTutorialFell(this, this.tutorialPlacement, rule); }),
      bus.on('enemy:waveStarted', ({ index, count }) => {
        this.wavesSeen = Math.max(this.wavesSeen, index + 1);
        if (this.hosting) this.ctx.net!.send({ t: 'ee', ev: 'wave', index, count }, 'others');
      }),
      // 2026-09-16: an emptied enemy corpse sinks and is removed — at once on the authority, by a request to the host from a replica (`parts/CorpseEmpty`)
      bus.on('crate:looted', ({ crateId }) => CorpseEmpty.onCorpseContainerLooted(this, crateId)),
      // 2026-09-16 (2nd pass): who is holding an enemy corpse's window open — an emptied corpse sinks after the last one closes it (`shared/corpseViewers`)
      CorpseEmpty.hookCorpseViews(this),
      // 2026-09-11 (enemies ↔ drones): the noise of a sprinting ground drone — it comes from the authority client only (`parts/Alerts.onWorldNoise`)
      bus.on('world:noise', ({ position, radius }) => this.onWorldNoise(position, radius)),
      // 2026-09-11: a replica emits `enemy:namedSpawned` the first time it sees a named through `ee spawn` (on the authority the spawn path does it directly)
      bus.on('enemy:spawned', ({ id, type }) => this.named.onSpawned(id, type)),
      // 2026-09-09: rogue drops — world/ emits it the first time a structure · platform container is investigated. Only the host rolls (once per zone).
      // 2026-09-14: the tutorial has no drops (investigating a structure rolls nothing — the training range is already blocked inside `RogueDrop`)
      bus.on('structure:investigated', ({ zoneId, position }) => { if (!this.tutorial) this.rogueDrops.onInvestigated(zoneId, position); }),
      // Phase 7: mid-mission host migration — the only place authority changes while a mission runs
      bus.on('net:hostChanged', ({ isLocalHost }) => this.setAuthority(isLocalHost)),
    );
    // 2026-09-13: the sandworm · the dig-in — registered **after** the `world:ready` subscription above, so it rolls once the reset · ecosystem maths are done
    this.burrowFx = new BurrowFx(ctx.scene);
    this.sandworm.bind(this);
    this.unsub.push(
      // 2026-09-14: the spit · eruption packs are drawn from the effective ecosystem (the planet threat's mid-size weights) — whether it appears at all (`ecoAllows`) is unchanged, since the multiplier is > 0
      // 2026-09-14: the tutorial rolls no sandworm either, like the training range (the `training` argument = 「a world with no procedural spawning」)
      bus.on('world:ready', ({ planet }) => this.sandworm.onWorldReady(planet ?? ctx.world?.planet ?? ctx.missionPlanet ?? null, this.spawnEco, this.training || this.tutorial)),
      bus.on('cheat:sandworm', ({ spitS, weak }) => { this.sandworm.debugForce({ ...(spitS === undefined ? {} : { spitS }), ...(weak ? { weak: true } : {}) }); }),
      // 2026-09-15 (the thumper): gadgets emits it on the host — the omen starts right there with no chance roll and no ground test (ignored when the raid already has one)
      bus.on('sandworm:summon', ({ position }) => { if (!this.training && !this.tutorial) this.sandworm.onSummon(position); }),
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
        if (msg.ev === 'rejoined' && this.hosting) this.sandworm.resync();   // 2026-09-13: the omen · the sandworm's max hp · the spit timing
      }),
      net.onMessage('intq', (msg) => {
        // a client's bullet hit shell `sid`: validate it still exists, pop it here and broadcast
        if (!this.hosting || !this.shells) return;
        _c.set(msg.p[0], msg.p[1], msg.p[2]);
        this.shells.interceptById(msg.sid, _c, true);
      }),
      // Phase 12: a client's bullet report — the host runs the same routine as for its own shots
      net.onMessage('shotq', (msg, from) => this.onShotReport(msg, from)),
      // 2026-09-16: a client emptied an enemy corpse — the host filters it, then broadcasts `ee corpseEmptied` (`parts/CorpseEmpty`)
      net.onMessage('ecorpseq', (msg, from) => CorpseEmpty.onCorpseEmptiedRequest(this, msg, from)),
      // 2026-09-09: rogue drops — a non-host takes the announcement · landing, emits the same events and draws only the pod (the enemies come over `es` / `ee`)
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
    // 2026-09-20: one camera read for the whole frame — the AI LOD, the animation LOD and the footstep range gate
    // (`model.emitEnemyStep`, via `EnemyHost.camPos`) all ask the same question and used to ask it separately.
    this.camPos.setFromMatrixPosition(ctx.camera.matrixWorld);

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
    // Rogue drops: the pod's fall FX runs everywhere, the landing spawn only on the host (it splits inside). 2026-09-14: off in the tutorial as in the training range.
    if (!this.training && !this.tutorial) this.rogueDrops.update(dt);
    if (!this.training && !this.tutorial) this.sandworm.update(dt);   // 2026-09-13: the omen shake runs everywhere; the trigger · eruption · sandworm tick are authority-only

    if (this.authority) {
      if (ctx.isGameplayPhase()) {
        // AI LOD (2026-09-20, `docs/PERF.md` perf Phase C · B4): a body far from everything it could act on ticks
        // every other / every fourth frame, spending the skipped frames' dt in one piece when it does.
        this.collectAiAnchors();
        // 2026-09-21 (A-18 phase 2): the frame's private-search budget · the graph identity · the gate sweep (twice a second)
        this.nav.beginFrame(world.nav ?? null, dt, this.active);
        const aiFrame = (this.aiFrame = (this.aiFrame + 1) & 3);
        const aiHalfD2 = ENEMY_AI_LOD_HALF_M * ENEMY_AI_LOD_HALF_M;
        const aiQuarterD2 = ENEMY_AI_LOD_QUARTER_M * ENEMY_AI_LOD_QUARTER_M;
        for (let i = 0; i < this.active.length; i++) {
          const e = this.active[i];
          if (this.aiSkip(e, aiHalfD2, aiQuarterD2, aiFrame, dt)) { e.aiDebt += dt; continue; }
          const step = dt + e.aiDebt;
          e.aiDebt = 0;
          updateEnemyAI(e, step, this);
        }
        Status.updateHazardDot(this, dt);   // 2026-09-11 (C-14): enemies inside the hazard zone — quiet damage (authority only)
        this.acid?.update(dt, this);
        this.shells?.update(dt, this);
        this.grenades?.update(dt);
        // 2026-09-14 (3rd pass): a tutorial bug waits underground — it rises where it stands as the player approaches (reusing the dig-in spawn)
        // 2026-09-15: + the chain spawn (the next bug 1 s after the first) · the liftoff fire window — `Tutorial.updateTutorialScript`
        if (this.tutorial) updateTutorialScript(this, this.tutorialPlacement, dt);
        // 2026-09-14: the tutorial has no patrols · waves — what the list says is all there is
        if (!this.training && !this.tutorial) {
          this.spawner.update(dt, this);
          this.waves.update(dt, this);
          // 2026-09-18: survivors per nest → a refill (host only, within the rolled count)
          this.nests.threat = this.spawner.threat;
          this.nests.update(dt, this);
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
    // 2026-09-16 (2nd pass): emptied corpses — the lifetime is cut once nobody is looking, and held while my own window is open (`parts/CorpseEmpty`)
    CorpseEmpty.updateEmptyCorpses(this);
    const slack = this.authority ? 0 : 1;   // replicas: the host's despawn normally arrives first
    // Animation LOD (2026-09-20): legs are ~10 cm on screen at 60 m. `camPos` was read at the top of the frame.
    const halfD2 = ENEMY_ANIM_LOD_HALF_M * ENEMY_ANIM_LOD_HALF_M;
    const freezeD2 = ENEMY_ANIM_LOD_FREEZE_M * ENEMY_ANIM_LOD_FREEZE_M;
    /*
     * 2026-09-20 (user's decision 「줌 배율로 LOD 거리 보정」): those two distances were decided as 「how big is this on
     * screen」 (`data/constants.csv`: 「legs are ~10 cm」), and that only holds at `CAMERA_BASE_FOV_DEG`. A scope narrows
     * `camera.fov` instead of touching `camera.zoom`, so through an 8× scope a body at 100 m is drawn the size it has
     * at ~12 m — and it used to slide along with frozen legs. One `tan` per frame corrects it (`shared/viewZoom`);
     * clamped to ≤ 1, so a wider-than-base view (the sprint kick, the slash widen) never *pushes* the bands out.
     * The **AI** LOD is deliberately left alone: it measures what a body can act on, and a scope changes none of that.
     */
    const lodK = Math.min(1, viewZoomK(ctx.camera.fov, ctx.camera.zoom));
    const lodK2 = lodK * lodK;
    const odd = (this.animFrame = (this.animFrame + 1) & 1);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      // 2026-09-11 (C-18): a corpse on the tram travels with it (on the authority and a replica alike) — the search spot (`corpse:<id>`) follows the body too
      if (e.state === 'dead' && (carryCorpse(e, world) || e.corpseDropped)) {
        const c = this.corpses.get(e.id);
        if (c) c.position.copy(e.position);
        if (e.deathLanded) e.corpseDropped = false;
      }
      e.animate(dt, this.poseSkip(e, halfD2, freezeD2, lodK2, (i & 1) === odd));
      // 2026-09-17: a corpse that has begun to sink cannot be searched any more (an emptied one and one at the end of its lifetime alike — `anim.fade` > 0 means sinking)
      if (e.state === 'dead') { const c = this.corpses.get(e.id); if (c) c.sinking = e.anim.fade > 0; }
      // Phase 10: a mid-air kill registers its corpse once the body has come to rest (or after CORPSE_LAND_TIMEOUT)
      if (e.corpsePending && this.authority && !this.resetting && (e.deathLanded || e.deathTimer >= CORPSE_LAND_TIMEOUT)) this.registerCorpse(e);
      if ((e.state === 'dead' && e.deathTimer >= e.corpseLife + slack) || (e.state === 'flee' && e.fleeTimer >= FLEE_DURATION)) this.despawn(e);
    }
    this.xray.tick(ctx.time);
    this.corpses.update(dt);
    this.fx?.update(dt, world);
    this.burrowFx?.update(ctx.time, dt);   // 2026-09-13
  }

  /**
   * Refill `aiAnchors` with every position an enemy could act on this frame — the AI LOD's distance is measured to
   * the **nearest** of them, never to the camera alone (`data/constants.csv` `ENEMY_AI_LOD_*`).
   *
   * The camera goes in first so anything on screen always ticks at full rate even with the local player dead; then
   * every present player (downed and riding ones included — a body someone is standing over is where the action
   * is), every android, every aggroable drone and the rover. That is 1–10 entries, so the per-body test below is a
   * handful of subtractions.
   */
  private collectAiAnchors(): void {
    const a = this.aiAnchors;
    a.length = 0;
    a.push(this.camPos);
    const t = this.targets;
    for (let i = 0; i < t.all.length; i++) { const c = t.all[i]; if (c.present && !c.isDead) a.push(c.position); }
    for (let i = 0; i < t.allies.length; i++) { const c = t.allies[i]; if (c.present && !c.isDead) a.push(c.position); }
    for (let i = 0; i < t.drones.length; i++) a.push(t.drones[i].position);
    for (let i = 0; i < t.vehicles.length; i++) a.push(t.vehicles[i].position);
  }

  /**
   * Whether this body's **AI tick** may be left out this frame (`data/constants.csv` `ENEMY_AI_LOD_*`). The skipped
   * frames' `dt` is not lost — `Enemy.aiDebt` carries it into the next tick — so the only thing a reduced body gives
   * up is one frame of reaction, at a distance past the longest reach of anything the LOD applies to (the artillery
   * bug's `ARTILLERY_AI maxRange`, 98 m — the named sniper's 320 m is longer, and a named rogue is never reduced).
   *
   * Never reduced, wherever it stands: the tutorial (scripted, and a dozen bodies at most), a corpse still falling
   * and a body in the air (a leap, a spat bug, a hunter's flip) — all three integrate gravity, and a coarser step
   * would land them somewhere else — and a named rogue, of which there is at most one per raid and whose own file
   * owns its timing. Nor is any body reduced on a frame that would push its tick past `ENEMY_AI_LOD_MAX_STEP_S`:
   * the carried `dt` keeps timers right but cannot keep what happens **once per tick**, so the tick has a ceiling
   * and the LOD fades out on its own when frames get long.
   */
  private aiSkip(e: Enemy, halfD2: number, quarterD2: number, frame: number, dt: number): boolean {
    if (this.tutorial) return false;
    if (e.aiDebt + dt * 2 > ENEMY_AI_LOD_MAX_STEP_S) return false;   // the tick this skip would build, not the debt so far
    if (e.state === 'dead' ? !e.deathLanded : (e.airborne || e.leaping || e.flipFalling)) return false;
    // 2026-09-21: a body on a ladder · a wall · a window sill moves by the tick — a coarser step would overshoot its legs (`ai/Traverse`)
    if (e.navTrav !== 0) return false;
    if (isNamedAiType(e.type)) return false;
    const a = this.aiAnchors;
    const p = e.position;
    let best = Infinity;
    for (let i = 0; i < a.length; i++) {
      const q = a[i];
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    if (best > quarterD2) return (frame & 3) !== e.aiPhase;
    if (best > halfD2) return (frame & 1) !== (e.aiPhase & 1);
    return false;
  }

  /**
   * Whether this body's **pose** may be left alone this frame (`data/constants.csv` `ENEMY_ANIM_LOD_*`). Its
   * position and facing are updated either way — only the joints stop.
   *
   * A body that is flashing from a hit, burning, shocked or dead is never skipped: those frames are the feedback a
   * player reads through a scope at 100 m, and there are only ever a handful of them at once.
   *
   * 2026-09-20: **nor is a named rogue** (`ai/named.isNamedAiType`, the same exemption the AI LOD makes). `animateRig`
   * is the only caller of `animateNamedRig`, and a named look file is not a function of `anim.time` the way the base
   * bug / rogue pose is: it **integrates `dt`** (`st.age`, `glintHold`, the prone blend, the rotor angle), so a
   * skipped frame is lost, not caught up. What it costs is gameplay, not polish — `SniperLook` writes the scope
   * glint there, the `glintTime` 1.4 s telegraph of a 150-damage shot the sniper takes out to `NAMED_SNIPER range`
   * 320 m, so past the 80 m freeze the telegraph was never drawn at all (and a replica's `ee glint` hold is consumed
   * inside that same function). At most one named rogue + its scan drone live in a raid, so the exemption costs nothing.
   */
  private poseSkip(e: Enemy, halfD2: number, freezeD2: number, lodK2: number, offFrame: boolean): boolean {
    const a = e.anim;
    if (e.state === 'dead' || a.hitFlash > 0.001 || a.writhe > 0.001 || a.spark > 0.001 || a.flip > 0.001) return false;
    // 2026-09-21: a body on a wall (authority `ai/Traverse` · replica hints 26–28) — a frozen pose there is a bug lying flat in mid-air
    if (e.navAloft || a.climb !== 0) return false;
    if (isNamedAiType(e.type)) return false;
    const dx = e.position.x - this.camPos.x, dy = e.position.y - this.camPos.y, dz = e.position.z - this.camPos.z;
    // `lodK2` is the camera zoom folded in (≤ 1) — the bands are screen size, not metres. See `update`.
    const d2 = (dx * dx + dy * dy + dz * dz) * lodK2;
    if (d2 > freezeD2) return true;
    return d2 > halfD2 && offFrame;
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
    this.burrowFx?.dispose(); this.burrowFx = null;   // 2026-09-13
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
        // 2026-09-11 (C-72): the axis height rule for a standing capsule lives in `RayTests.standingTopY` alone — the same expression is not written again here.
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

  startExtractionWaves(target: THREE.Vector3): void { if (!this.training && !this.tutorial) this.waves.start(target); }

  stopExtractionWaves(): void { this.waves.stop(); }

  killAll(): void { return Pool.killAll(this); }

  /* ── EnemyManagerRef: appended tactical-kit queries ────────────────────── */

  /**
   * Alive enemies within `radius` of `pos` (turrets, scans, explosions, lures).
   * Uses the per-frame spatial grid when it is fresh, else a linear scan — both allocation-free apart
   * from the returned array.
   *
   * 2026-09-18 (bug eggs): **the default is fighting bodies only** — `bug_egg` drops out. Almost every caller of this
   * query is asking 「what do I target · what threatens me」 (turret targets · mine contact · an android engaging · the
   * recon scan · a barrier bump), and an egg is none of those.
   * It is filtered **by default** so a caller cannot forget it. A query that does need the eggs (a deployable's blast
   * damage, where 「whatever it reaches, it breaks」) passes `includeProps: true`. The egg itself still breaks to
   * bullets · melee · grenades · `applyAreaDamage` (mines · ship calls) · `explode` — none of those paths come through
   * this query.
   */
  queryNear(pos: THREE.Vector3, radius: number, includeProps = false): EnemyRef[] {
    const out: EnemyRef[] = [];
    const r2 = radius * radius;
    const usable = this.gridTime === this.ctx.time && this.active.length > 24;
    if (usable) {
      queryBuf.length = 0;
      const n = this.grid.query(pos.x, pos.z, radius, queryBuf);
      for (let i = 0; i < n; i++) {
        const e = queryBuf[i];
        if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
        if (e.isEgg && !includeProps) continue;   // 2026-09-18: this query's default is **fighting bodies** (see the header)
        const dx = e.position.x - pos.x, dy = e.position.y + e.stats.height * 0.5 - pos.y, dz = e.position.z - pos.z;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
      }
      queryBuf.length = 0;
      return out;
    }
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (!e.active || e.state === 'dead' || e.state === 'flee') continue;
      if (e.isEgg && !includeProps) continue;
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
   * `incinerated` (2026-09-06): `duration` s of writhing on the spot — no movement / attacks, still damageable —
   * `isIncapacitated`, faster embers, `enemy:incinerated`; `dps` is ignored. `shocked`: `dps` is the **speed
   * multiplier** (0..1, `SHOCK_SLOW_FACTOR` = 55 % speed) for `duration` s, plus a cyan spark strobe and
   * `enemy:shocked` (emitted once per shock, not per tick — the arc calls this every frame).
   * `dps` 0 (or `duration` 0 for incineration) clears the effect. Visuals run everywhere; gameplay only on the authority:
   * a replica keeps the optimistic visual and forwards the request to the host as `hit {dmg: 0, st, dur}`
   * (`ENEMY_STATUS_BITS`), throttled per enemy for the continuous callers.
   */
  applyStatus(id: number, status: EnemyStatusKind, dps: number, duration: number, attacker?: string): void { return Status.applyStatus(this, id, status, dps, duration, attacker); }

  /** Authority: put `e` into the incinerated state for `duration` s (event, scream, ember burst). */
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
      /* 2026-09-17 · 2026-09-18: the artillery's firing stance · barrage prep · squad cooldown all start over on a new
         host — none of the three is on the wire. `nestOf` (the nest leash) is the same, so on a promoted host a nest bug
         becomes an ordinary bug (the same intent as `escortOf`). */
      e.shellPhase = 0; e.shellPhaseT = 0; e.shellPrepDone = false; e.squadCd = 0;
      e.nestOf = -1; e.nestReturning = false;
      e.airborne = false; e.leaping = false; e.vy = 0;
      // 2026-09-17: taking over a flipped hunter (including one still falling) finishes the rest of the flip on the ground — at least 1 s, not the hint's hold value (0.35 s)
      if (e.flipFalling || e.flipTimer > 0) { e.flipFalling = false; e.flipTimer = Math.max(e.flipTimer, 1); e.state = 'stagger'; e.staggerTimer = 0; }
      e.leapDamage = 0;
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
    // 2026-09-13: extraction defence waves removed — a promoted host does not splice the waves back in either (it never calls `waves.prime`)
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
      e.flipFalling = false; e.flipTimer = 0; e.leapDamage = 0;   // 2026-09-17: the new host's hint puts the flip back on
      e.velocity.set(0, 0, 0);
      this.replicaMgr.adopt(e, now);
    }
  }

  applyAreaDamage(center: THREE.Vector3, radius: number, damage: number, by?: string): number { return Dmg.applyAreaDamage(this, center, radius, damage, by); }

  /**
   * `EnemyManagerRef.pushBack` (the shield bash knockback; Phase 12 cast-only, contract since 2026-09-11 C-1). Shove enemies
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
  debugSpawn(type: EnemyType, position: THREE.Vector3 | { x: number; y?: number; z: number }, chase = false, opts?: HumanoidSpawnOpts): Enemy | null {
    if (!this.authority || !this.ctx.world?.ready) return null;
    const world = this.ctx.world;
    _v.set(position.x, 0, position.z);
    _v.y = world.getHeightAt(_v.x, _v.z);
    if (type === 'rogue' || type === 'rogue_boss') {
      return this.spawnRogue(type, _v, 0, _v, type === 'rogue_boss' ? ROGUE_AI.bossWeapon : ROGUE_AI.weapons[0], null, opts);
    }
    // 2026-09-13: the android · raider use the humanoid spawn path too (the gun = the first family on that faction's list, `opts` = site · squad · role)
    if (type === 'android' || type === 'raider') {
      return this.spawnRogue(type, _v, 0, _v, HUMANOID_WEAPONS[type][0] ?? 'ar', null, opts);
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
  /** true in a simulation training range world (no spawning). */
  get isTrainingWorld(): boolean { return this.training; }
  /** 2026-09-14: true in a tutorial world (enemies at fixed spots only — no rolls · patrols · waves · drops · named · sandworm). */
  get isTutorialWorld(): boolean { return this.tutorial; }
  /**
   * 2026-09-14 (debug / smoke): what this tutorial raid stood up — the bodies placed · the rows skipped · each one's
   * detection radius · its leash.
   * 2026-09-14 (3rd pass): `ambush` = how many bugs are still waiting underground (once the player enters the detection
   * radius one rises and moves over to `spawned`).
   * null outside the tutorial, or before the placement.
   */
  /** 2026-09-18 (bug nests): this raid's egg count · the refill roll per nest · the garrison · how many are alive now (authority only, debug · smokes). */
  debugNests(): { eggs: number; nests: Array<{ pad: number; anchorIndex: number; refillsLeft: number; garrison: number; alive: number }> } | null {
    if (!this.nests.placement) return null;
    return { eggs: this.nests.placement.eggs, nests: this.nests.debugState(this) };
  }

  debugTutorial(): { spawned: number; skipped: number; ambush: number; enemies: Array<{ id: number; type: EnemyType; alive: boolean; sense: number; leash: number; x: number; y: number; z: number }> } | null {
    const p = this.tutorialPlacement;
    if (!this.tutorial || !p) return null;
    const enemies = p.ids.map((id) => {
      const e = this.byId.get(id);
      return e
        ? { id, type: e.type, alive: e.isCombatant, sense: e.senseRadius, leash: e.homeLeash, x: e.position.x, y: e.position.y, z: e.position.z }
        : { id, type: 'scavenger' as EnemyType, alive: false, sense: 0, leash: 0, x: 0, y: 0, z: 0 };
    });
    return { spawned: p.spawned, skipped: p.skipped, ambush: p.ambush.length, enemies };
  }
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

  /* ── appended: 2026-09-21 (TODO A-18 phase 2 — enemy pathfinding; for `scripts/smoke-enemy-nav.mjs`) ── */
  /**
   * The pool's pathfinding at a glance: how many living bodies steer by the flow field / a private path / are on a special link /
   * were refused at a gate this tick, the token holders and queue per gate (index = `NavGate.id`), and the private searches run
   * over the last full second (the ceiling is `ENEMY_NAV_PLANS_PER_FRAME` × fps).
   */
  debugNav(): { ready: boolean; gates: number; flow: number; path: number; traversing: number; waiting: number; off: number; tokens: number[]; queues: number[]; plansLastSecond: number } {
    let flow = 0, path = 0, traversing = 0, waiting = 0, off = 0;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.state === 'dead') continue;
      if (e.navTrav !== 0) traversing++;
      else if (e.navMode === 1) flow++;
      else if (e.navMode === 2) path++;
      if (e.navWaitGate >= 0) waiting++;
      if (e.navOffT > 0) off++;
    }
    const st = this.nav;
    return { ready: st.graph !== null, gates: st.holders.length, flow, path, traversing, waiting, off, tokens: st.holders.slice(), queues: st.waiting.slice(), plansLastSecond: st.plansLastSecond };
  }
  /** One body's pathfinding state (`ai/NavMove.describeNav`), null for an unknown id. */
  debugNavOf(id: number): ReturnType<typeof describeNav> | null { const e = this.byId.get(id); return e ? describeNav(e) : null; }
  /**
   * Puts a body on a special link by hand — the same `ai/Traverse.beginTraverse` the flow field and a path call, without the
   * mask check. `ladder` needs `ladderId` (`WorldRef.getLadders`) and reads only `to.y` (above the body = up); `climb` · `window`
   * need `from` / `via` / `to`. Authority only. False = refused (unknown id · dead · no world · unknown ladder).
   */
  debugTraverse(id: number, link: { kind: NavLinkKind; from?: { x: number; y: number; z: number }; via?: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; ladderId?: string; windowId?: string }): boolean {
    const e = this.byId.get(id);
    const world = this.ctx.world;
    if (!e || e.state === 'dead' || !world || !this.authority) return false;
    const from = link.from ?? e.position, via = link.via ?? link.to;
    return beginTraverse(e, world, link.kind, _v.set(from.x, from.y, from.z), _v2.set(via.x, via.y, via.z), _to.set(link.to.x, link.to.y, link.to.z), link.ladderId ?? null, link.windowId ?? null);
  }
  /** Position of live shell `sid` (debug), or null. */
  debugShell(sid: number): THREE.Vector3 | null { return this.shells?.find(sid)?.position ?? null; }
  /**
   * Phase 11 (debug / smoke): the planet ecosystem in force plus the numbers derived from it, or null with no planet.
   * `cap` is the ambient population ceiling at the current threat.
   */
  get debugEcology(): { bugs: Partial<Record<EnemyType, number>>; pressure: number; rogues: number; boss: boolean; maxArtillery: number; maxBehemoth: number; gatherDensity: number; threat: number; cap: number; planetThreat: number; bugHpMul: number; effBugs: Partial<Record<EnemyType, number>>; effMaxArtillery: number; effMaxBehemoth: number } | null {
    const eco = this.eco;
    if (!eco) return null;
    // 2026-09-14: the fields above are the planet's own (planets.csv); `eff*` is the effective ecosystem with bug difficulty on top
    const eff = this.spawnEco ?? eco;
    return {
      bugs: eco.bugs, pressure: eco.pressure, rogues: eco.rogues, boss: eco.boss,
      maxArtillery: eco.maxArtillery, maxBehemoth: eco.maxBehemoth, gatherDensity: eco.gatherDensity,
      threat: this.spawner.threat, cap: this.spawner.cap,
      planetThreat: this.bugTuning.threat, bugHpMul: this.bugTuning.hpMul,
      effBugs: { ...eff.bugs }, effMaxArtillery: maxArtilleryOf(eff), effMaxBehemoth: maxBehemothOf(eff),
    };
  }
  /** Phase 11 (debug / smoke): the ambient population ceiling right now (`(12 + 24 × threat) × eco.pressure`). */
  get debugAmbientCap(): number { return this.spawner.cap; }
  /**
   * Phase 11 (debug / smoke): one ambient patrol composition for `threat` through the live ecosystem. Spawns nothing.
   * 2026-09-14: given a `planetThreat`, it rolls this planet's own ecosystem with **that threat's** bug difficulty on top (comparing threats on one planet).
   */
  debugAmbientGroup(threat: number, planetThreat?: number): EnemyType[] {
    const tuning = planetThreat === undefined ? this.bugTuning : bugThreatTuning(planetThreat);
    const eco = planetThreat === undefined ? this.spawnEco : threatEcosystem(this.eco, tuning);
    return ambientGroup(threat, eco, ambientOptsOf(tuning)).slice();
  }
  /** Phase 11 (debug / smoke): one extraction-wave composition through the live ecosystem. Spawns nothing. */
  debugWaveGroup(index: number, count: number): EnemyType[] { return waveGroup(index, count, this.spawnEco).slice(); }
  /**
   * 2026-09-14 (debug / smoke): one row of bug difficulty — the multipliers · bonuses, plus the artillery / behemoth caps
   * it gives on this planet and the artillery dig-in chance at ramp `rampThreat`. `planetThreat` omitted = this raid's
   * value.
   */
  debugBugTuning(planetThreat?: number, rampThreat = 0.7): BugThreatTuning & { maxArtillery: number; maxBehemoth: number; artilleryChance: number } {
    const tuning = planetThreat === undefined ? this.bugTuning : bugThreatTuning(planetThreat);
    const eco = planetThreat === undefined ? this.spawnEco : threatEcosystem(this.eco, tuning);
    return { ...tuning, maxArtillery: maxArtilleryOf(eco), maxBehemoth: maxBehemothOf(eco), artilleryChance: artilleryDigInChance(rampThreat, tuning.bigMul) };
  }
  /** Phase 12 (debug / smoke): x-ray overlay state of enemy `id` (built overlay count, visible now, expiry). */
  debugXray(id: number): { overlays: number; visible: boolean; until: number } | null { return Status.debugXray(this, id); }
  /** Phase 12 (debug / smoke): enemies currently drawn through walls. */
  get xrayCount(): number { return this.xray.count; }
  /** Phase 12 (debug / smoke): feed a `shotq` through the host path as if peer `from` sent it (authority needed, no session). */
  debugShotReport(msg: ShotReport, from: PeerId): void { this.onShotReport(msg, from, true); }
  /**
   * 2026-09-09 (debug / smoke): the rogue drop state — the drops in progress, and how many times this raid rolled /
   * actually called one. `rolls` is the number of zones rolled through `structure:investigated` (failures included) and
   * `calls` the number of drops the successes called.
   */
  get debugRogueDrops(): { pending: RogueDropView[]; rolls: number; calls: number } {
    return { pending: this.rogueDrops.views().slice(), rolls: this.rogueDrops.rolls, calls: this.rogueDrops.calls };
  }
  /** 2026-09-09 (debug / smoke): runs the roll path as it is, without a `structure:investigated` (the once-per-zone rule included). */
  debugInvestigate(zoneId: string, position: THREE.Vector3): void { this.rogueDrops.onInvestigated(zoneId, position); }
  /**
   * 2026-09-11 (debug / smoke): stands the named `type` up with no roll (the SMG escort included, for the Heavy). With
   * no `at`, 40 m in front of the player. Authority only. `enemy:namedSpawned` goes out, but this raid's roll record is
   * left alone.
   */
  debugSpawnNamed(type: NamedRogueType, at?: { x: number; z: number }): Enemy | null { return this.named.debugSpawn(type, at); }
  /** 2026-09-11 (debug / smoke): this raid's named roll — the chance · the rolled value · the type drawn · the spot · the escort count. */
  debugNamedRoll(): NamedRollResult { return this.named.debugRoll(); }
  /**
   * Phase 11 (debug / smoke): living humanoids right now. `rogues` counts `rogue` + `rogue_boss` (boss included) as before;
   * 2026-09-13 adds `androids` / `raiders` (named rogues and their escorts are counted by type — a heavy's escort is a raider).
   */
  debugGuardCount(): { rogues: number; boss: boolean; androids: number; raiders: number } {
    let rogues = 0; let boss = false; let androids = 0; let raiders = 0;
    for (const e of this.active) {
      if (!e.active || e.state === 'dead') continue;
      if (e.type === 'rogue') rogues++;
      else if (e.type === 'rogue_boss') { rogues++; boss = true; }
      else if (e.type === 'android') androids++;
      else if (e.type === 'raider') raiders++;
    }
    return { rogues, boss, androids, raiders };
  }
  /**
   * 2026-09-13 (debug / smoke): the site occupation at this raid's start — the threat · whether each site is occupied ·
   * the faction · the groups (squad id · indoor/outdoor · whether it has a leader · each member's id / type / role /
   * weapon / spawn spot) · the leader's id · where the spots came from (`world` = getSiteSpawnPoints, `fallback`).
   * A JSON-transferable copy. null off the authority, or before the roll.
   */
  debugSites(): { threat: number; source: string; bossId: number | null; humanoids: number; sites: Array<{ siteId: string; site: string; occupied: boolean; faction: string | null; groups: Array<{ squadId: number; place: string; faction: string; leader: boolean; planned: number; members: Array<{ id: number; type: EnemyType; role: string; weapon: string; x: number; y: number; z: number }> }> }> } | null {
    const p = this.sitePlacement;
    if (!p) return null;
    return {
      threat: p.threat, source: p.source, bossId: p.boss ? p.boss.id : null, humanoids: p.humanoids,
      sites: p.sites.map((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })) })) })),
    };
  }
  /** 2026-09-13 (debug / smoke): makes a raider drop treat the squad as `n` members (1..4) (null = the real count). A mission reset clears it. */
  debugSetDropSquad(n: number | null): void { this.rogueDrops.squadOverride = n; }
  /** 2026-09-13 (debug / smoke): the scheduled second wave of a raider drop · how many waves this raid has dropped. */
  get debugDropWaves(): { pending: Array<{ id: string; count: number; at: number }>; waves: number } {
    return { pending: this.rogueDrops.pendingWaves(), waves: this.rogueDrops.waves };
  }

  /* ── client → host requests (authority only) ───────────────────────────── */
  /** `hit` from a client: damage (as before) and / or the status bits (`st` + `dur`, 2026-09-06; `dmg` may be 0 for a status-only request). */
  private onHitRequest(msg: HitRequest, from: string): void { return Dmg.onHitRequest(this, msg, from); }

  private onExplodeRequest(p: readonly number[], r: number, dmg: number, from: string): void { return Dmg.onExplodeRequest(this, p, r, dmg, from); }

  /* ── SpawnHost ─────────────────────────────────────────────────────────── */
  aliveCount(): number { return Pool.aliveCount(this); }

  countAlive(type: EnemyType): number { return Pool.countAlive(this, type); }

  ensureCapacity(n: number, cap: number): number { return Pool.ensureCapacity(this, n, cap); }

  /** `emerge` (2026-09-13) > 0 = the bug digs up out of the ground over that many seconds. */
  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean, emerge = 0): Enemy | null { return Pool.spawn(this, type, position, yaw, chase, relentless, emerge); }

  /* ── RogueSpawnHost ────────────────────────────────────────────────────── */
  spawnRogue(type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null, opts?: HumanoidSpawnOpts): Enemy | null { return Pool.spawnRogue(this, type, position, yaw, guardPos, weaponId, escortOf, opts); }

  /* ── ReplicaHost ───────────────────────────────────────────────────────── */
  find(id: number): Enemy | undefined { return Pool.find(this, id); }

  /** Pool → active with an explicit id (host-assigned on the authority, host's id on replicas). Silent. */
  acquire(id: number, type: EnemyType, position: THREE.Vector3, yaw: number): Enemy | null { return Pool.acquire(this, id, type, position, yaw); }

  release(e: Enemy): void { return Pool.release(this, e); }

  bloodBurst(point: THREE.Vector3, count: number, dir: THREE.Vector3 | null, kind?: 'blood' | 'spark'): void { return RFx.bloodBurst(this, point, count, dir, kind); }

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

  /** 2026-09-16 (`ee corpseEmptied`): a corpse the host declared empty — its lifetime is cut and it sinks (`parts/CorpseEmpty`). */
  corpseEmptiedRemote(id: number): void { CorpseEmpty.applyCorpseEmptied(this, id); }

  /**
   * 2026-09-16 (debug / smoke): on the authority, turns the enemy corpse `id` into 「a corpse opened and emptied」 — the
   * same path as `crate:looted corpse:<id>`.
   * false with no dead body, when it is already empty, or off the authority.
   */
  debugEmptyCorpse(id: number): boolean { return CorpseEmpty.emptyCorpseAuthority(this, id); }

  grenadeVisual(id: number, p: THREE.Vector3, v: THREE.Vector3, fuse: number, kind?: import('@/shared').EnemyGrenadeKind): void { return RFx.grenadeVisual(this, id, p, v, fuse, kind); }

  grenadeHitRemote(p: THREE.Vector3, kind?: import('@/shared').EnemyGrenadeKind): void { return RFx.grenadeHitRemote(this, p, kind); }

  despawn(e: Enemy): void { return Pool.despawn(this, e); }

  /* ── 2026-09-13: the dig-in spawn · the sandworm (ReplicaHost / EnemyHost + debug) ─ ── */
  emergeSpawned(e: Enemy): void { Burrow.emergeFx(this, e); }

  burrowLanded(e: Enemy): void { Burrow.spatLandedFx(this, e); }

  onSandwormEvent(msg: EnemyEvent): void { this.sandworm.onWire(msg); }

  /** Debug / smoke: spawn `type` digging out of the ground for `seconds` (default `BURROW_EMERGE_S`). Authority only. */
  debugSpawnBurrow(type: EnemyType, position: { x: number; z: number }, seconds = BURROW_EMERGE_S): Enemy | null {
    const world = this.ctx.world;
    if (!this.authority || !world?.ready) return null;
    _v.set(position.x, world.getHeightAt(position.x, position.z), position.z);
    return this.spawn(type, _v, 0, false, false, seconds);
  }

  /** Debug / smoke / console: start the sandworm warning now (see `SandwormDirector.debugForce`). */
  debugSandworm(opts: { at?: { x: number; z: number }; spitS?: number; weak?: boolean } = {}): boolean { return this.sandworm.debugForce(opts); }

  /** Debug / smoke: sandworm plan (threat · base · last check) · warning · live worms · volley counters. */
  get debugSandwormState(): ReturnType<SandwormDirector['debugState']> { return this.sandworm.debugState(); }

  /** Debug / smoke (2026-09-15): evaluate the per-check appearance chance for a hypothetical member list (pure — no roll, no state). */
  debugSandwormChance(members: Parameters<SandwormDirector['debugChance']>[0], lure = false, threat?: number): ReturnType<SandwormDirector['debugChance']> { return this.sandworm.debugChance(members, lure, threat); }

  /** Debug / smoke (2026-09-15): forget that the event already happened this raid (so a `sandworm:summon` can be tested after a forced worm). */
  debugSandwormClearOnce(): void { this.sandworm.debugClearOnce(); }

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
   * Fuse ran out. Authority: ROGUE_GRENADE_DAMAGE with the shared two-step falloff (`shared/explosion`) over ROGUE_GRENADE_RADIUS to every alive player
   * (local directly, remote via `dmg {kb}`, suspended via `ghost:damage`) and to enemies of the other faction, blast
   * noise, `ee grenadeHit`. Everyone: audio, shake near the local player.
   */
  onGrenadeExploded(p: THREE.Vector3, authority: boolean, owner: number, kind: import('@/shared').EnemyGrenadeKind = 'frag'): void { return Atk.onGrenadeExploded(this, p, authority, owner, kind); }
  /** 2026-09-13 (`GrenadeHost`): an authority enemy fire zone burns for `tick` s — `parts/Attacks.onFireZoneTick`. */
  onFireZoneTick(p: THREE.Vector3, radius: number, owner: number, faction: EnemyFaction, tick: number): void { return Atk.onFireZoneTick(this, p, radius, owner, faction, tick); }

  /* ── status effects (burning / slow / incinerated / shocked) ─────────── */
  private updateStatuses(dt: number): void { return Status.updateStatuses(this, dt); }

  /**
   * A shot was heard. Wakes bugs (hearing) and, for those that cannot see through the smoke it came out of,
   * records a suspicion point they answer with very inaccurate fire. Gunfire also acts as a weak lure.
   */
  private onGunshot(position: THREE.Vector3, radius: number): void { return Alert.onGunshot(this, position, radius); }

  alertHearing(position: THREE.Vector3, radius: number): void { return Alert.alertHearing(this, position, radius); }

  /**
   * 2026-09-11 (enemies ↔ drones): `world:noise` (a ground drone sprinting). Enemies within earshot that nobody has made
   * aware yet go and investigate where the sound came from (`ai/Investigate`). It hands over no target — if the drone is
   * visible, `pickTarget` picks it. Authority only.
   */
  onWorldNoise(position: THREE.Vector3, radius: number): void { return Alert.onWorldNoise(this, position, radius); }

  /** 2026-09-11 (debug / smoke): the drone proxies an enemy may target right now — the id · the underside height (m). */
  get debugDroneTargets(): Array<{ id: string; altitude: number }> {
    return this.targets.drones.map((t) => ({ id: t.droneId ?? '', altitude: t.droneAltitude }));
  }

  /* ══ appended (2026-09-15): android squadmates ═════════════════════════════════════════════════════════ */
  /**
   * `EnemyManagerRef.applyAllyHit` — an android's round hit the enemy `enemyId` (authority only, no kill credit).
   * true when it was applied (`parts/Damage.applyAllyHit`).
   */
  applyAllyHit(enemyId: number, damage: number, point: THREE.Vector3, from: THREE.Vector3): boolean { return Dmg.applyAllyHit(this, enemyId, damage, point, from); }

  /** The debug-injected damage receiver — with null it goes to the real `ctx.allies.damage` (`debugAllyTargets`). */
  debugAllySink: Dmg.AllyDamageSink | null = null;

  /**
   * debug / smoke only: injects android bodies with no `ctx.allies`. `bodies` are `AllyBodyView`s as they are (the
   * smoke fills in the position · hp · `hidden` itself) and `onDamage` is called every time an enemy hits one of them.
   * Calling it with `null` takes them away.
   * It is the one path that lets the enemy side (targeting · firing · area damage · contact) be tested as it is while
   * allies/ is not there yet.
   */
  debugAllyTargets(bodies: readonly AllyBodyView[] | null, onDamage?: Dmg.AllyDamageSink | null): void {
    this.targets.allyOverride = bodies;
    this.debugAllySink = onDamage ?? null;
    this.targets.refresh(this.ctx);
  }

  /** debug / smoke only: the android proxies an enemy may target right now — the id · the position distances are measured from. */
  get debugAllyTargetList(): Array<{ id: string; x: number; z: number }> {
    return this.targets.allies.map((t) => ({ id: t.allyId ?? '', x: t.position.x, z: t.position.z }));
  }

  /**
   * debug / smoke only: runs the shared cover pick (`shared/cover.pickCoverSpot`) once with the humanoid numbers.
   * It asks only 「standing here, avoiding that threat, where do I hide」, with no enemy instance.
   */
  debugCoverSpot(from: readonly number[], threat: readonly number[], anchorRadius = Infinity): { cover: number[]; pop: number[]; score: number } | null {
    const world = this.ctx.world;
    if (!world?.ready || from.length < 3 || threat.length < 3) return null;
    _coverFrom.set(from[0], from[1], from[2]);
    _coverThreat.set(threat[0], threat[1], threat[2]);
    const q: CoverQuery = {
      from: _coverFrom, threat: _coverThreat, anchor: _coverFrom, anchorRadius,
      minThreatDist: COVER_MIN_TARGET_DIST, maxThreatDist: ROGUE_AI.range * COVER_MAX_RANGE_FRAC,
      bodyRadius: ENEMY_WALL_STANDOFF, chestHeight: COVER_EYE, threatEyeHeight: PLAYER_HEIGHT * 0.65,
      searchRadius: COVER_SEARCH_RADIUS, popEyeHeight: STAND_EYE,
    };
    if (!pickCoverSpot(world, q, _debugSpot)) return null;
    return {
      cover: [_debugSpot.cover.x, _debugSpot.cover.y, _debugSpot.cover.z],
      pop: [_debugSpot.pop.x, _debugSpot.pop.y, _debugSpot.pop.z],
      score: _debugSpot.score,
    };
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
   * Phase 9: does a barrier stand between `from` and the target's chest? If so the barrier takes the block damage
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
   * Phase 12: `melee` = a bite / leap / charge contact. Before it lands on a player the raised barrier of that player
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

  /* ── Phase 12: barrier bumps (EnemyHost) ────────────────────────────── ── */
  /**
   * Called from `ai/EnemyAI.integrate` after every grounded enemy moved: `ImplantsRef.resolveBarrierCollision` pushes
   * the body out of any raised shield and names the carrier. On contact the enemy hunts the carrier for
   * BARRIER_RETARGET_S (`pickTarget` honours `barrierOwner`), wakes up if it was idle, and `implant:barrierBumped`
   * fires at most every BARRIER_BUMP_INTERVAL per enemy (implants sparks / audio thuds from it).
   */
  resolveBarrier(e: Enemy): void { return Dmg.resolveBarrier(this, e); }

  /* ── Phase 12: shot tracking ────────────────────────────────────────── ── */
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
