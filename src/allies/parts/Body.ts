/**
 * src/allies/parts/Body.ts — one unit's **body**. A mutable object implementing `AllyBodyView` (the contract).
 *
 * The contract side is all `readonly`, so other folders only read and this folder alone writes these fields. The
 * simulation-only fields (the bag · the task · burst state · interpolation buffers) live here too — one unit's state
 * scattered across several Maps always leaks on host migration.
 */
import * as THREE from 'three';
import { Random } from '@/shared';
import type {
  AllyBodyView, AllyEquip, AllyId, AllyMode, AllyPose, AllyStateId, AllyBagRef, CoverSpot, ItemInstance, Obstacle, PeerId,
  WeightState,
} from '@/shared';
import type { AllyRequestKind } from '../model';

export class Ally implements AllyBodyView {
  readonly id: AllyId;
  name: string;
  bay: number;
  slot: number;
  /** true = a unit from the serverless cheat roster. */
  local: boolean;

  mode: AllyMode = 'dormant';
  state: AllyStateId = 'dormant';
  pose: AllyPose = 'dormant';
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  hp = 1;
  maxHp = 1;
  shield = 0;
  maxShield = 0;
  downHp = 0;
  downed = false;
  dead = false;
  hidden = true;
  flags = 0;
  weaponDefId: string | null = null;
  armorDefId: string | null = null;
  bagDefId: string | null = null;
  carrying: PeerId | null = null;
  lookAt: THREE.Vector3 | null = null;
  stridePhase = 0;
  moveBlend = 0;

  /* ── FSM ── */
  /** Priority of the current state (a lower proposal is pushed back). */
  statePrio = 0;
  /** The pending transition — the user's decision 「행동까지 0.5~2초 지연」. */
  pendingState: AllyStateId | null = null;
  pendingPrio = 0;
  /** Remaining delay (s). */
  pendingT = 0;
  /** Time spent in the current state (s). */
  stateT = 0;
  /**
   * The **single act** of this state entry (the way-out ping · the contract objective ping) has already been done.
   * `Fsm.enter` lowers it. Without it: after placing the ping and closing the request, `act` keeps running for the
   * length of the transition delay and clears the request again, and a re-confirmation (`confirmExtract`) that came
   * in between is lost whole — that was what 「두 번째 탈출 핑에 콘솔을 안 누른다」 really was.
   */
  oneShot = false;
  /** A per-unit random stream — seeded from the id so three units never move on the same beat. */
  readonly rand: Random;

  /* ── Gear · bag ── */
  readonly equip: AllyEquip = { primary: null, armor: null, bag: null };
  bag: AllyBagRef | null = null;
  /** uids of the base kit — a **bound thing**: never dropped, never left in a corpse, never sent to the stash. */
  readonly kitUids = new Set<string>();
  /** Has the bag changed since the last `ally bag` went out. */
  bagDirty = false;
  /** What a replica knows it carries, from the last `ally bag` (host migration · debug). */
  wireItems: ItemInstance[] = [];
  /**
   * The last measured weight state · time left until it is measured again (s) — weighing builds an array, so it is
   * not done every frame.
   */
  weightState: WeightState = 'normal';
  weightT = 0;
  /** Time left until the crate candidates are scanned again (s) — the contents preview is not cheap. */
  lootScanT = 0;

  /* ── Movement ── */
  readonly dest = new THREE.Vector3();
  hasDest = false;
  /**
   * Is it running — the sprint flag `player/` draws from (`ALLY_FLAGS.SPRINT`, raised in `Fsm.act`). Every state
   * that has somewhere urgent to be sets it: getting back to the harness (`Fsm.follow`), closing on a target and
   * running to the designated enemy's last spot (`parts/Combat`), holding position beside the leader during a
   * `주의` (`parts/Commands.act`), the `앞장서라` walk out (`Commands.act`, `a.running = lead`), all three
   * extraction moves (walking to a pinged way out · the call button · boarding), the approach of a hand-over
   * (`parts/Support`) and every rescue move (`parts/Rescue` — to the body, carrying, the carry run). The free
   * search **walks** (`Roam.act` lowers it every frame).
   */
  running = false;
  /**
   * Stuck detection (`Nav.step`) — the time into the current window, the travel asked for inside it, and where the
   * window started. Too little net travel against what was asked → it sidesteps.
   */
  stuckT = 0;
  stuckWant = 0;
  readonly stuckFrom = new THREE.Vector3();
  /** The sidestep direction (+1 right / −1 left) and the time left on it. */
  sideSign = 1;
  sideT = 0;
  /**
   * Nearby obstacles for avoidance — querying every frame would keep making arrays, so they are refreshed once a
   * period only.
   */
  nearObs: Obstacle[] = [];
  obsT = 0;

  /* ── Free search (2026-09-16 user's decision 「분대장 범위 안을 자유롭게 탐색」) ── */
  /** The patrol spot it is heading for (the value is meaningless while `hasRoamDest` is false). */
  readonly roamDest = new THREE.Vector3();
  hasRoamDest = false;
  /** Time left looking around after arriving (s). At 0 it picks the next spot. */
  roamPauseT = 0;
  /** Centre of the point of interest it holds (a structure · a cover object) — with none it is a random patrol. */
  readonly roamPoi = new THREE.Vector3();
  hasRoamPoi = false;
  /** Time left until the point of interest is picked again (s) — a world query is not cheap. */
  roamPoiT = 0;

  /* ── Engage range (measured from the weapon — re-measured only when the weapon changes) ── */
  /** The distance (m) it closes to with the current weapon. `engageFor` fills it. */
  engageRange = 0;
  /** Def id of the weapon `engageRange` was measured from (a change re-measures it). */
  engageDefId: string | null = null;

  /* ── Look point ── */
  readonly lookVec = new THREE.Vector3();

  /* ── Combat ── */
  targetEnemyId: number | null = null;
  burstLeft = 0;
  fireCd = 0;
  reloadT = 0;
  magLeft = 0;
  magSize = 1;
  lastEnemyPingAt = -Infinity;
  /** The cover spot (a reused object — `pickCoverSpot` writes its values only). */
  readonly cover: CoverSpot = { cover: new THREE.Vector3(), pop: new THREE.Vector3(), hasPop: false, score: 0 };
  hasCover = false;
  /** Is it leaning out (mid-burst). */
  poppedOut = false;

  /* ── Orders · requests ── */
  /** Kind of the request it has taken (null with none). */
  taskKind: AllyRequestKind | null = null;
  taskBy: PeerId | null = null;
  readonly taskAt = new THREE.Vector3();
  taskDefId: string | null = null;
  taskAmmoType: string | null = null;
  taskTargetId: string | null = null;
  /** uid of the thing it picked up to hand over. */
  deliverUid: string | null = null;
  deliverPinged = false;
  deliverWaitT = 0;
  /** Time left holding at the `가자` ping spot · time left on the `주의` ping. */
  moveHoldT = 0;
  watchT = 0;
  readonly watchPos = new THREE.Vector3();
  hasWatch = false;

  /* ── Looting ── */
  lootContainerId: string | null = null;
  lootTier = 1;
  lootTakeT = 0;
  pickupId: string | null = null;
  /**
   * Giving up on a crate · ground item it cannot reach (`parts/Loot.stalled`): the closest it has come to the target
   * of this job, and how long since that last improved.
   */
  jobBestD = Infinity;
  jobStallT = 0;
  /** Containers it gave up on this raid — autonomous looting never picks one again (a fresh ping still may). */
  readonly unreachable = new Set<string>();

  /* ── Load · extraction ── */
  /** It has already placed one extraction ping for 「조금 무거움」 (once per raid, never re-armed). */
  lightPingDone = false;
  /** The 「무거움」 extraction ping — re-armed on returning to 「가벼움」/「보통」. */
  heavyPingArmed = true;
  extractPadId: string | null = null;
  extractPingAt = -Infinity;
  extractRequester: PeerId | null = null;
  /** The same person said 「탈출하고 싶다」 again inside the confirm window → it presses the call button. */
  confirmExtract = false;
  /**
   * 2026-09-16 (user's decision): a PC placed a way-out ping and said 「탈출하고 싶다」 — it goes to that ping's spot.
   * The coordinates are meaningless while `hasExtractPing` is false.
   */
  readonly extractPingPos = new THREE.Vector3();
  hasExtractPing = false;

  /* ── Rescue ── */
  rescueTarget: PeerId | null = null;
  reviveHoldT = 0;
  /** Destination it carries a body to. */
  readonly carryDest = new THREE.Vector3();
  hasCarryDest = false;

  /* ── Chat repeat suppression ── */
  readonly lastSaid = new Map<string, number>();

  /* ── Replica interpolation ── */
  readonly wirePrev = new THREE.Vector3();
  readonly wireNext = new THREE.Vector3();
  wirePrevYaw = 0;
  wireNextYaw = 0;
  wireAt = 0;
  wireSpan = 0;

  constructor(id: AllyId, name: string, bay: number, slot: number, local: boolean) {
    this.id = id;
    this.name = name;
    this.bay = bay;
    this.slot = slot;
    this.local = local;
    this.rand = new Random(id);
  }

  /** Reset when crossing between a raid and the ship (it does not leave the roster — only the body is emptied). */
  resetSim(): void {
    this.velocity.set(0, 0, 0);
    this.hasDest = false;
    this.running = false;
    this.stuckT = 0;
    this.stuckWant = 0;
    this.stuckFrom.copy(this.position);
    this.sideT = 0;
    this.hasRoamDest = false;
    this.hasRoamPoi = false;
    this.roamPauseT = 0;
    this.roamPoiT = 0;
    this.engageRange = 0;
    this.engageDefId = null;
    this.targetEnemyId = null;
    this.burstLeft = 0;
    this.fireCd = 0;
    this.reloadT = 0;
    this.hasCover = false;
    this.poppedOut = false;
    this.taskKind = null;
    this.taskBy = null;
    this.taskDefId = null;
    this.taskAmmoType = null;
    this.taskTargetId = null;
    this.deliverUid = null;
    this.deliverPinged = false;
    this.deliverWaitT = 0;
    this.moveHoldT = 0;
    this.watchT = 0;
    this.hasWatch = false;
    this.lootContainerId = null;
    this.lootTakeT = 0;
    this.lootScanT = 0;
    this.weightState = 'normal';
    this.weightT = 0;
    this.pickupId = null;
    this.jobBestD = Infinity;
    this.jobStallT = 0;
    this.unreachable.clear();
    this.lightPingDone = false;
    this.heavyPingArmed = true;
    this.extractPadId = null;
    this.extractPingAt = -Infinity;
    this.extractRequester = null;
    this.confirmExtract = false;
    this.hasExtractPing = false;
    this.rescueTarget = null;
    this.reviveHoldT = 0;
    this.hasCarryDest = false;
    this.carrying = null;
    this.lookAt = null;
    this.lastSaid.clear();
    this.pendingState = null;
    this.pendingT = 0;
    this.stateT = 0;
    this.statePrio = 0;
    this.oneShot = false;
  }

  /** The bag plus everything equipped (weighing · the corpse · the stash deposit). */
  carried(): ItemInstance[] {
    const out: ItemInstance[] = [];
    if (this.equip.primary) out.push(this.equip.primary);
    if (this.equip.armor) out.push(this.equip.armor);
    if (this.equip.bag) out.push(this.equip.bag);
    if (this.bag) for (const it of this.bag.items()) out.push(it);
    else for (const it of this.wireItems) out.push(it);
    return out;
  }

  /** Only what was found in the raid (the base kit is a bound thing, so it is left out). */
  loot(): ItemInstance[] {
    return this.carried().filter((it) => !this.kitUids.has(it.uid));
  }
}
