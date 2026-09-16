/**
 * src/allies/parts/Body.ts — 한 기의 **몸**. `AllyBodyView`(계약)를 그대로 구현하는 가변 객체다.
 *
 * 계약 쪽은 전부 `readonly` 이므로 다른 폴더는 읽기만 하고, 이 폴더만 여기 필드를 쓴다. 시뮬레이션 전용 필드
 * (가방 · 목표 · 연사 상태 · 보간 버퍼)도 같이 산다 — 한 기의 상태가 여러 Map 으로 흩어지면 호스트 승계에서 반드시 샌다.
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
  /** true = 서버 없는 치트 명단의 한 기. */
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
  /** 지금 상태의 우선순위 (더 낮은 제안은 밀린다). */
  statePrio = 0;
  /** 대기 중인 전이 — 사용자 결정의 「행동까지 0.5~2초 지연」. */
  pendingState: AllyStateId | null = null;
  pendingPrio = 0;
  /** 남은 지연 (s). */
  pendingT = 0;
  /** 지금 상태에 머문 시간 (s). */
  stateT = 0;
  /**
   * 이번 상태 진입에서 **한 번만 하는 일**(탈출구 핑 · 계약 목표 핑)을 이미 했다. `Fsm.enter` 가 내린다.
   * 없으면: 핑을 찍고 요청을 닫은 뒤에도 전이 지연 동안 `act` 가 계속 돌아 요청을 다시 지우고, 그 사이에 들어온
   * 재확인(`confirmExtract`)이 통째로 날아간다 — 「두 번째 탈출 핑에 콘솔을 안 누른다」 의 정체였다.
   */
  oneShot = false;
  /** 기마다 다른 난수 — 세 기가 똑같은 박자로 움직이지 않게 id 로 시드한다. */
  readonly rand: Random;

  /* ── 장비 · 가방 ── */
  readonly equip: AllyEquip = { primary: null, armor: null, bag: null };
  bag: AllyBagRef | null = null;
  /** 기본 킷의 uid — **묶인 물건**이라 떨구지도 시체에 남기지도 창고로 보내지도 않는다. */
  readonly kitUids = new Set<string>();
  /** 마지막으로 `ally bag` 을 보낸 뒤 가방이 바뀌었나. */
  bagDirty = false;
  /** 리플리카가 마지막 `ally bag` 으로 아는 소지품 (호스트 승계 · 디버그). */
  wireItems: ItemInstance[] = [];
  /** 마지막으로 잰 무게 상태 · 다시 잴 때까지 남은 시간 (s) — 무게 계산은 배열을 만들므로 매 프레임 재지 않는다. */
  weightState: WeightState = 'normal';
  weightT = 0;
  /** 상자 후보를 다시 훑을 때까지 남은 시간 (s) — 내용물 미리보기는 싸지 않다. */
  lootScanT = 0;

  /* ── 이동 ── */
  readonly dest = new THREE.Vector3();
  hasDest = false;
  /** 뛰는가 (하네스 밖 · 구조 · 업기). */
  running = false;
  /** 막힘 감지 — 같은 자리에 오래 있으면 옆으로 비킨다. */
  stuckT = 0;
  readonly lastPos = new THREE.Vector3();
  /** 비켜 가는 방향 (+1 오른쪽 / −1 왼쪽) 과 남은 시간. */
  sideSign = 1;
  sideT = 0;
  /** 회피용 근처 장애물 — 매 프레임 질의하면 배열이 계속 생기므로 주기마다만 새로 받는다. */
  nearObs: Obstacle[] = [];
  obsT = 0;

  /* ── 자유 탐색 (2026-09-16 사용자 결정 「분대장 범위 안을 자유롭게 탐색」) ── */
  /** 지금 향하는 순찰 지점 (`hasRoamDest` 가 false 면 값은 의미 없다). */
  readonly roamDest = new THREE.Vector3();
  hasRoamDest = false;
  /** 도착해 주위를 둘러보는 남은 시간 (s). 0 이 되면 다음 지점을 고른다. */
  roamPauseT = 0;
  /** 지금 잡은 관심 지점(구조물 · 엄폐물)의 중심 — 없으면 무작위 순찰이다. */
  readonly roamPoi = new THREE.Vector3();
  hasRoamPoi = false;
  /** 관심 지점을 다시 고를 때까지 남은 시간 (s) — 월드 질의는 싸지 않다. */
  roamPoiT = 0;

  /* ── 교전 거리 (무기에서 잰다 — 무기가 바뀔 때만 다시 잰다) ── */
  /** 지금 무기로 붙는 거리 (m). `engageFor` 가 채운다. */
  engageRange = 0;
  /** `engageRange` 를 잰 무기의 def id (바뀌면 다시 잰다). */
  engageDefId: string | null = null;

  /* ── 시선 ── */
  readonly lookVec = new THREE.Vector3();

  /* ── 전투 ── */
  targetEnemyId: number | null = null;
  burstLeft = 0;
  fireCd = 0;
  reloadT = 0;
  magLeft = 0;
  magSize = 1;
  lastEnemyPingAt = -Infinity;
  /** 엄폐 자리 (재사용 객체 — `pickCoverSpot` 이 값만 쓴다). */
  readonly cover: CoverSpot = { cover: new THREE.Vector3(), pop: new THREE.Vector3(), hasPop: false, score: 0 };
  hasCover = false;
  /** 몸을 내밀고 있는가 (연사 중). */
  poppedOut = false;

  /* ── 명령 · 요청 ── */
  /** 지금 맡은 요청의 종류 (없으면 null). */
  taskKind: AllyRequestKind | null = null;
  taskBy: PeerId | null = null;
  readonly taskAt = new THREE.Vector3();
  taskDefId: string | null = null;
  taskAmmoType: string | null = null;
  taskTargetId: string | null = null;
  /** 건네려고 집어 든 물건의 uid. */
  deliverUid: string | null = null;
  deliverPinged = false;
  deliverWaitT = 0;
  /** 가자 핑 자리에서 머무는 남은 시간 · 주의 핑 남은 시간. */
  moveHoldT = 0;
  watchT = 0;
  readonly watchPos = new THREE.Vector3();
  hasWatch = false;

  /* ── 루팅 ── */
  lootContainerId: string | null = null;
  lootTier = 1;
  lootTakeT = 0;
  pickupId: string | null = null;

  /* ── 짐 · 탈출 ── */
  /** 「조금 무거움」으로 탈출 핑을 이미 한 번 찍었다 (레이드당 1회, 다시 무장되지 않는다). */
  lightPingDone = false;
  /** 「무거움」 탈출 핑 — 가벼움/보통으로 돌아오면 다시 무장된다. */
  heavyPingArmed = true;
  extractPadId: string | null = null;
  extractPingAt = -Infinity;
  extractRequester: PeerId | null = null;
  /** 같은 사람이 확인 창 안에 다시 「탈출하고 싶다」 했다 → 호출 버튼을 누른다. */
  confirmExtract = false;
  /**
   * 2026-09-16 (사용자 결정): PC 가 탈출구 핑을 찍고 「탈출하고 싶다」를 말했다 — 그 핑 자리로 간다.
   * `hasExtractPing` 이 false 면 좌표는 의미 없다.
   */
  readonly extractPingPos = new THREE.Vector3();
  hasExtractPing = false;

  /* ── 구조 ── */
  rescueTarget: PeerId | null = null;
  reviveHoldT = 0;
  /** 업고 뛰는 목적지. */
  readonly carryDest = new THREE.Vector3();
  hasCarryDest = false;

  /* ── 채팅 중복 억제 ── */
  readonly lastSaid = new Map<string, number>();

  /* ── 리플리카 보간 ── */
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

  /** 레이드 · 함선 사이를 오갈 때의 초기화 (명단에서 빠지지 않는다 — 몸만 비운다). */
  resetSim(): void {
    this.velocity.set(0, 0, 0);
    this.hasDest = false;
    this.running = false;
    this.stuckT = 0;
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

  /** 가방 + 장착 장비 전부 (무게 계산 · 시체 · 창고 이관). */
  carried(): ItemInstance[] {
    const out: ItemInstance[] = [];
    if (this.equip.primary) out.push(this.equip.primary);
    if (this.equip.armor) out.push(this.equip.armor);
    if (this.equip.bag) out.push(this.equip.bag);
    if (this.bag) for (const it of this.bag.items()) out.push(it);
    else for (const it of this.wireItems) out.push(it);
    return out;
  }

  /** 레이드에서 주운 것만 (기본 킷은 묶인 물건이라 빠진다). */
  loot(): ItemInstance[] {
    return this.carried().filter((it) => !this.kitUids.has(it.uid));
  }
}
