/**
 * src/game/Corpses.ts — **사망한 플레이어의 시체** (`ctx.corpses`, 2026-09-09).
 *
 * 이 파일이 답하는 질문: *플레이어가 완전히 죽었을 때 월드에 무엇이 남고, 그것을 어떻게 뒤지는가.*
 *
 * - 자동 부활이 사라졌으므로 죽은 자리에 **시체**가 선다. **레이드가 끝날 때까지 사라지지 않는다** —
 *   수명도, 거리 컬링도 없다 (사용자 결정: 최적화 대상에서 제외).
 * - 시체는 컨테이너 하나다: `Interactable` `pcorpse:<ownerId>:<n>` → `openContainerItemsSized(...)`.
 *   **가져가기**는 상자와 똑같이 기존 `cont` / `contq` 호스트 권한 경로를 탄다 (새 경로 없음).
 * - 메시는 절차 생성이다 — `SoldierModel` 을 죽은 자세로 한 번 굳혀 두고 다시는 갱신하지 않는다.
 *   (`@/player` 의 `SoldierModel` 은 game/ 이 쓰는 유일한 외부 폴더 심볼이다. 병사 모델을 두 번
 *   만들지 않기 위한 의도적인 예외 — 폴더 README 의 `알려진 한계` 참고.)
 */
import * as THREE from 'three';
import {
  NET_SLOT_COLORS, PLAYER_CORPSE_COLS, PLAYER_CORPSE_LOOT_RANGE, PLAYER_CORPSE_ROWS,
  recordRideLocal, restoreRideLocal, normalizeMealQuality,
  type CorpseItemWire, type CorpsesRef, type GameContext, type Interactable, type ItemInstance, type Obstacle,
  type PlayerCorpse, type PlayerCorpseWire, type TramDef, type WorldRef,
} from '@/shared';

/** `PlayerCorpseWire.ride` (C-63) — 전차에 실린 시체의 차량 로컬 좌표. */
type CorpseRideWire = NonNullable<PlayerCorpseWire['ride']>;

const _rideScratch = new THREE.Vector3();
const _shipQ = new THREE.Quaternion();
const _shipE = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * C-63: 탑승 중인 발판(`Obstacle`)이 어느 전차의 부품인가. 전차 부품은 전부 `TramDef.yaw` 와 **같은 값**을
 * `box.yaw` 로 받는다(`world/rails/parts/Tram.placeTram` 이 한 프레임에 같은 변수로 쓴다) — 그 가운데 가장 가까운 전차.
 */
function tramOfCarrier(world: WorldRef, c: Obstacle): TramDef | null {
  if (!c.box) return null;
  const trams = world.getTrams();
  let best: TramDef | null = null, bestD = Infinity;
  for (let i = 0; i < trams.length; i++) {
    const t = trams[i];
    if (Math.abs(t.yaw - c.box.yaw) > 1e-6) continue;
    const d = (t.position.x - c.position.x) ** 2 + (t.position.z - c.position.z) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
import { SoldierModel, SOLDIER_DEFAULT_ACCENT, type SoldierPose } from '@/player';

/** 굳어 있는 죽은 자세 (한 번 damp 를 몰아 돌린 뒤 다시는 건드리지 않는다). */
const DEAD_POSE: SoldierPose = {
  moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
  verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 1,
  prone: 1, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
};
/** 죽은 자세를 수렴시키기 위해 생성 시 한 번만 돌리는 큰 스텝 (프레임마다 도는 애니메이션이 아니다). */
const SETTLE_STEPS = 6;
const SETTLE_DT = 0.5;

/**
 * 한 구의 시체. `Interactable` 이자 `PlayerCorpse` 다. 아이템 목록은 첫 상호작용에서 컨테이너로 넘어가고,
 * 그 뒤로는 컨테이너 캐시가 진실이다 (`crate:looted` 로 비었음을 통보받는다).
 */
export class PlayerCorpseObject implements Interactable, PlayerCorpse {
  readonly radius = PLAYER_CORPSE_LOOT_RANGE;
  /** 2026-09-11 (C-4): 빛기둥 · 정찰 분류가 id 접두어 대신 이것을 먼저 본다. */
  readonly kind = 'playerCorpse' as const;
  readonly position = new THREE.Vector3();
  readonly group = new THREE.Group();
  emptied = false;
  private readonly model: SoldierModel;
  /* ── 2026-09-11 (C-18): 달리는 전차 위의 시체는 전차에 실려 간다 ─────────────────────────────────────
   * 플레이어 · 적과 같은 식(`@/shared` 의 `ride.ts`)이다. 생성 직후 발밑의 **움직이는 발판**(`Obstacle.velocity`)을
   * 한 번 찾아(`boardCarrier`) 차량 로컬 좌표로 적어 두고, 매 프레임 차량의 **지금** 변환으로 다시 푼다
   * (`followCarrier`). `carrier` 는 `SpatialHash` 안의 살아 있는 `Obstacle` 이라 전차가 움직이면 같이 바뀐다.
   * 시체는 스스로 움직이지 않으므로 유지 판정(`rideContains`)도 하차 관성도 없다 — 레이드가 끝날 때까지 탄다. */
  private carrier: Obstacle | null = null;
  private readonly rideLocal = new THREE.Vector3();
  /** 탄 순간의 차량 `box.yaw`(수학 규약)와 시체 yaw(three.js 규약) — 곡선 구간에서 몸도 같이 돈다. */
  private rideCarrierYaw0 = 0;
  private rideYaw0 = 0;
  private yawNow: number;
  /**
   * 2026-09-13 (탈출 개편): 탈출 함선 데크에 실린 시체 — 메시 그룹이 함선 `root` 의 **자식**이라 기울기까지 같이 움직이고,
   * 매 프레임 그 월드 자리가 곧 상호작용 위치다. 전차(`carrier`)와 달리 발판 질의가 없다(함선 데크는 월드 발판이 아니다).
   * 함선과 함께 떠나면 extraction 이 `removeCorpse` 로 치운다.
   */
  private shipParent: THREE.Object3D | null = null;

  constructor(
    private readonly ctx: GameContext,
    readonly id: string,
    readonly ownerId: string,
    readonly ownerName: string,
    position: THREE.Vector3,
    yaw: number,
    readonly diedAt: number,
    /** 사망 시점의 전부. 컨테이너를 처음 만들 때만 쓰인다. */
    readonly items: ItemInstance[],
    slot: number,
  ) {
    this.yawNow = yaw;
    this.position.copy(position);
    this.group.name = `PlayerCorpse:${id}`;
    this.group.position.copy(position);
    this.group.rotation.y = yaw;
    this.model = new SoldierModel(NET_SLOT_COLORS[slot] ?? SOLDIER_DEFAULT_ACCENT);
    // 시체는 어둡게 — 살아 있는 분대원과 한눈에 구분된다
    this.model.setGreyed(true);
    for (let i = 0; i < SETTLE_STEPS; i++) this.model.update(SETTLE_DT, 0, DEAD_POSE);
    this.group.add(this.model.root);
  }

  /** 지금 몸이 향한 방향 (three.js `rotation.y` 규약). 전차에 실린 시체는 곡선에서 바뀐다. */
  get yaw(): number { return this.yawNow; }

  /** true = 움직이는 발판에 실려 가는 중 (스모크 · 디버그용). */
  get riding(): boolean { return this.carrier !== null; }

  /**
   * 발밑에 움직이는 발판(`velocity` 가 있는 장애물 — 전차 데크)이 있으면 탄다. 생성 직후 한 번만 부른다.
   * 발판 동점은 `getStandingObstacle` 이 움직이는 쪽을 먼저 고른다(C-38).
   */
  boardCarrier(world: WorldRef | null): void {
    if (this.carrier || !world?.ready) return;
    const o = world.getStandingObstacle(this.position.x, this.position.z, this.position.y);
    if (!o || !o.velocity) return;
    this.carrier = o;
    recordRideLocal(o, this.position, this.rideLocal);
    this.rideCarrierYaw0 = o.box ? o.box.yaw : 0;
    this.rideYaw0 = this.yawNow;
  }

  /**
   * C-63: 와이어의 `ride`(보낸 쪽에서 탄 전차 · 차량 로컬 좌표 · 차량 기준 yaw)로 탄다. `p` 대신 **내 전차의 지금
   * 변환**으로 로컬 좌표를 풀어 자리를 잡는다 — 보간 지연 때문에 후미 끝의 시체가 `p` 로는 전차 밖에 떨어지던 틈.
   * 모르는 전차 id · 풀린 자리에 그 전차의 발판이 없으면 아무것도 안 하고 false (호출부가 예전 `boardCarrier` 로).
   * 이미 서 있는 시체에 다시 불러도 된다: 같은 전차의 같은 로컬 좌표면 결과가 `followCarrier` 와 같다.
   */
  boardFromWire(world: WorldRef | null, ride: CorpseRideWire | undefined): boolean {
    if (!world?.ready || !ride || typeof ride.tram !== 'string' || !Array.isArray(ride.local)) return false;
    const [lx, ly, lz] = ride.local;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) return false;
    let tram: TramDef | null = null;
    for (const t of world.getTrams()) if (t.id === ride.tram) { tram = t; break; }
    if (!tram) return false;
    // TramDef 틀: position = 차체 중심(y = 데크 윗면), yaw = 로컬 +X → 월드 (cos, sin) — `shared/ride` 와 같은 규약
    const cs = Math.cos(tram.yaw), sn = Math.sin(tram.yaw);
    const p = _rideScratch.set(
      tram.position.x + lx * cs - lz * sn,
      tram.position.y + ly,
      tram.position.z + lx * sn + lz * cs,
    );
    const o = world.getStandingObstacle(p.x, p.z, p.y);
    if (!o || !o.velocity) return false;
    this.position.copy(p);
    this.carrier = o;
    recordRideLocal(o, this.position, this.rideLocal);
    this.rideCarrierYaw0 = o.box ? o.box.yaw : 0;
    this.yawNow = Number.isFinite(ride.yaw) ? ride.yaw - tram.yaw : this.yawNow;
    this.rideYaw0 = this.yawNow;
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yawNow;
    return true;
  }

  /**
   * C-63: 지금 탄 전차가 있으면 `PlayerCorpseWire.ride` 로 (사망 본인의 `spawn` · 호스트의 `sync` — 둘 다 **지금**
   * 탑승 상태에서 계산한다). 차량 기준 yaw = 시체 yaw(three.js) + 전차 yaw(수학 규약) — 탑승 중에는 불변이다.
   */
  rideWire(): CorpseRideWire | undefined {
    const c = this.carrier, world = this.ctx.world;
    if (!c || !world?.ready) return undefined;
    const tram = tramOfCarrier(world, c);
    if (!tram) return undefined;
    const cs = Math.cos(tram.yaw), sn = Math.sin(tram.yaw);
    const dx = this.position.x - tram.position.x, dz = this.position.z - tram.position.z;
    return {
      tram: tram.id,
      local: [dx * cs + dz * sn, this.position.y - tram.position.y, -dx * sn + dz * cs],
      yaw: this.yawNow + tram.yaw,
    };
  }

  /** 2026-09-13: true = 탈출 함선 데크에 실려 있다 (스모크 · 디버그용). */
  get onShip(): boolean { return this.shipParent !== null; }

  /**
   * 2026-09-13 (`CorpsesRef.attachCorpse`): `parent` 로컬 `local`(생략 = 지금 월드 자리)에 눕히고 그 변환을 따라간다.
   * null = 지금 월드 자리에 내려놓는다. 전차 탑승은 풀린다 (한 번에 한 탈것).
   */
  attachToParent(parent: THREE.Object3D | null, local?: THREE.Vector3): void {
    if (parent) {
      this.carrier = null;
      parent.updateWorldMatrix(true, false);
      if (local) this.group.position.copy(local).applyMatrix4(parent.matrixWorld);
      this.group.rotation.set(0, this.yawNow, 0);
      this.group.updateMatrixWorld(true);
      parent.attach(this.group);   // keeps the world transform, then rides the parent
      this.shipParent = parent;
      this.group.getWorldPosition(this.position);
      return;
    }
    if (!this.shipParent) return;
    this.shipParent = null;
    this.ctx.scene.attach(this.group);
    this.group.getWorldPosition(this.position);
  }

  /** 매 프레임: 탄 차량의 **지금** 변환으로 자리(= 상호작용 위치)와 방향을 다시 푼다. 안 탔으면 아무것도 안 한다. */
  followCarrier(): void {
    if (this.shipParent) {
      // 2026-09-13: the mesh hangs off the ship — read back where that put it
      this.group.getWorldPosition(this.position);
      this.group.getWorldQuaternion(_shipQ);
      this.yawNow = _shipE.setFromQuaternion(_shipQ, 'YXZ').y;
      return;
    }
    const c = this.carrier;
    if (!c) return;
    restoreRideLocal(c, this.rideLocal, this.position);
    this.group.position.copy(this.position);
    // box.yaw 는 로컬 +X → 월드 (cos, sin) 규약이고 메시 rotation.y 는 그 부호가 반대다 (`world/rails` 의 `rotation.y = −yaw`)
    this.yawNow = this.rideYaw0 - ((c.box ? c.box.yaw : 0) - this.rideCarrierYaw0);
    this.group.rotation.y = this.yawNow;
  }

  getPrompt(): string | null {
    return this.emptied ? '비어 있음' : `${this.ownerName}의 유해 뒤지기`;
  }

  canInteract(): boolean {
    const ctx = this.ctx;
    if (this.emptied || !ctx.isGameplayActive()) return false;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return false;
    return !!ctx.inventory && typeof ctx.inventory.openContainerItemsSized === 'function';
  }

  interact(): void {
    const inv = this.ctx.inventory;
    if (this.emptied || !inv || typeof inv.openContainerItemsSized !== 'function') return;
    inv.openContainerItemsSized(this.id, this.items, this.position,
      PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS, `${this.ownerName}의 유해`);
  }

  /** `PlayerCorpseWire` 로 (호스트의 `pcorpse sync` · 사망 본인의 `spawn`). */
  toWire(): PlayerCorpseWire {
    const wire: PlayerCorpseWire = {
      id: this.id, owner: this.ownerId, name: this.ownerName,
      p: [this.position.x, this.position.y, this.position.z], yaw: this.yaw, at: this.diedAt,
      items: itemsToWire(this.items),
    };
    const ride = this.rideWire();   // C-63: 생략 = 탑승 없음
    if (ride) wire.ride = ride;
    return wire;
  }

  dispose(): void {
    this.model.dispose();
    this.group.removeFromParent();
  }
}

/** `ItemInstance[]` → 와이어 (내구도 · 장전 · 소켓은 `ex` 로 실린다 — 굴림이 아니라 실측이다). */
export function itemsToWire(items: readonly ItemInstance[]): CorpseItemWire[] {
  const out: CorpseItemWire[] = [];
  for (const it of items) {
    if (!it) continue;
    const ex = (it.durability !== undefined || it.ammoInMag !== undefined || it.sockets !== undefined)
      ? { durability: it.durability, ammoInMag: it.ammoInMag, sockets: it.sockets }
      : undefined;
    const w: CorpseItemWire = ex ? { defId: it.defId, qty: it.qty, ex } : { defId: it.defId, qty: it.qty };
    if (typeof it.raidFound === 'number') w.rf = it.raidFound;   // 2026-09-12: 아이템 회수 계약 표식은 아이템과 함께 간다
    const q = normalizeMealQuality(it.quality);   // 2026-09-13: 요리 품질도 (0 = 생략)
    if (q > 0) w.q = q;
    out.push(w);
  }
  return out;
}

/**
 * 레이드에 서 있는 모든 시체. `ctx.corpses` 로 게시된다 (`GameFlowSystem` 이 만들고 소유한다).
 * 호스트는 **남의 시체도 `items` 채로** 들고 있어야 늦게 합류한 사람에게 `pcorpse sync` 로 답할 수 있다.
 */
export class PlayerCorpseManager implements CorpsesRef {
  private readonly corpses = new Map<string, PlayerCorpseObject>();
  /** 주인별 시체 번호 (`pcorpse:<owner>:<n>`) — 같은 사람이 여러 번 죽으면 시체도 여러 구다. */
  private readonly seq = new Map<string, number>();
  /**
   * C-63: 와이어로 들어온 `ride` 를 시체 id 별로 잠깐 들고 있다가 `add` 가 소비한다. 시체를 세우는 호출부
   * (`parts/CorpseNet.applyCorpseWire`)는 위치 · yaw 만 넘기므로, 이 관리자가 같은 `pcorpse` 메시지를 **따로 구독해**
   * `ride` 만 받아 둔다 (인벤토리의 `CorpseLoot` 도 같은 메시지를 따로 듣는다). 핸들러 순서와 무관하게 맞는다:
   * 먼저 들으면 여기 적어 두고 `add` 가 쓰며, `add` 가 먼저 돌았으면 이미 선 시체를 그 자리에서 다시 태운다.
   */
  private readonly pendingRide = new Map<string, CorpseRideWire>();
  private netUnsub: (() => void) | null = null;

  constructor(private readonly ctx: GameContext) {
    this.hookNet();
  }

  /** `pcorpse` 의 `ride` 만 따로 듣는다 (한 번). `ctx.net` 이 늦게 생기면 `update` 가 다시 부른다. */
  private hookNet(): void {
    const net = this.ctx.net;
    if (this.netUnsub || !net || typeof net.onMessage !== 'function') return;
    this.netUnsub = net.onMessage('pcorpse', (msg) => {
      if (msg.ev === 'spawn') this.noteWireRide(msg.corpse);
      else if (msg.ev === 'sync') for (const w of msg.corpses ?? []) this.noteWireRide(w);
    });
  }

  /** C-63: 와이어 한 구의 `ride` — 이미 선 시체면 곧바로 다시 태우고, 아니면 `add` 가 쓰게 적어 둔다. */
  noteWireRide(w: PlayerCorpseWire): void {
    if (!w || typeof w.id !== 'string' || !w.ride) return;
    const known = this.corpses.get(w.id);
    if (known) { known.boardFromWire(this.ctx.world, w.ride); return; }
    if (this.pendingRide.size > 64) this.pendingRide.clear();   // 세워지지 않은 와이어가 쌓이지 않게
    this.pendingRide.set(w.id, w.ride);
  }

  getCorpses(): readonly PlayerCorpse[] { return [...this.corpses.values()]; }

  get(id: string): PlayerCorpse | null { return this.corpses.get(id) ?? null; }

  latestOf(ownerId: string): PlayerCorpse | null {
    let best: PlayerCorpseObject | null = null;
    for (const c of this.corpses.values()) {
      if (c.ownerId !== ownerId) continue;
      if (!best || c.diedAt >= best.diedAt) best = c;
    }
    return best;
  }

  /** 다음 시체 id. */
  nextId(ownerId: string): string {
    const n = (this.seq.get(ownerId) ?? 0) + 1;
    this.seq.set(ownerId, n);
    return `pcorpse:${ownerId}:${n}`;
  }

  /** 이미 아는 id 면 무시하고 기존 것을 돌려준다 (`'all'` 로 보낸 자기 메시지의 되돌아옴 방지). */
  add(id: string, ownerId: string, ownerName: string, position: THREE.Vector3, yaw: number,
    diedAt: number, items: ItemInstance[], slot: number): PlayerCorpseObject {
    const known = this.corpses.get(id);
    if (known) return known;
    // 밖에서 온 id 도 시퀀스에 반영해 두어야 우리 쪽 번호가 겹치지 않는다
    const n = Number(id.slice(id.lastIndexOf(':') + 1));
    if (Number.isFinite(n)) this.seq.set(ownerId, Math.max(this.seq.get(ownerId) ?? 0, n));
    const c = new PlayerCorpseObject(this.ctx, id, ownerId, ownerName, position, yaw, diedAt, items, slot);
    // 2026-09-11 (C-63): 와이어가 탄 전차를 알려 줬으면 그 전차의 지금 변환으로 태우고, 아니면(모르는 id 포함) 예전처럼
    // 발밑 발판을 찾는다 (C-18: 전차 위에서 죽었으면 전차에 실린다)
    const ride = this.pendingRide.get(id);
    if (ride) this.pendingRide.delete(id);
    if (!c.boardFromWire(this.ctx.world, ride)) c.boardCarrier(this.ctx.world);
    this.corpses.set(id, c);
    this.ctx.scene.add(c.group);
    this.ctx.interactables.register(c);
    this.ctx.bus.emit('corpse:playerSpawned', {
      id, ownerId, ownerName, position: c.position.clone(), yaw,
    });
    return c;
  }

  /** `crate:looted` / `pcorpse emptied`: 프롬프트만 바뀐다 — 메시는 레이드가 끝날 때까지 남는다. */
  markEmptied(id: string): boolean {
    const c = this.corpses.get(id);
    if (!c || c.emptied) return false;
    c.emptied = true;
    this.ctx.bus.emit('corpse:playerEmptied', { id, ownerId: c.ownerId });
    return true;
  }

  /** 2026-09-13 (`CorpsesRef.attachCorpse`, caller: extraction): 시체를 탈출 함선에 싣는다 / 내린다. */
  attachCorpse(id: string, parent: THREE.Object3D | null, local?: THREE.Vector3): boolean {
    const c = this.corpses.get(id);
    if (!c) return false;
    c.attachToParent(parent, local);
    return true;
  }

  /**
   * 2026-09-13 (`CorpsesRef.removeCorpse`, caller: extraction): 함선과 함께 떠난 시체를 레이드에서 치운다. 안의 아이템도
   * 사라진다 — 인벤토리의 컨테이너 캐시에 남은 같은 id 는 더 이상 열 길이 없다(상호작용이 사라졌다).
   */
  removeCorpse(id: string): boolean {
    const c = this.corpses.get(id);
    if (!c) return false;
    this.ctx.interactables.unregister(id);
    c.dispose();
    this.corpses.delete(id);
    this.pendingRide.delete(id);
    return true;
  }

  /** 매 프레임 (`GameFlowSystem.update`): 전차에 실린 시체를 차량의 지금 자리로. 타지 않은 시체는 비용이 없다. */
  update(): void {
    if (!this.netUnsub) this.hookNet();
    for (const c of this.corpses.values()) c.followCarrier();
  }

  /** `pcorpse sync` 로 내보낼 전체 목록 (호스트만 보낸다). */
  syncWire(): PlayerCorpseWire[] { return [...this.corpses.values()].map((c) => c.toWire()); }

  /** 미션 리셋: interactable 해제 + 지오메트리 · 머티리얼 dispose. */
  clear(): void {
    for (const c of this.corpses.values()) {
      this.ctx.interactables.unregister(c.id);
      c.dispose();
    }
    this.corpses.clear();
    this.seq.clear();
    this.pendingRide.clear();
  }
}
