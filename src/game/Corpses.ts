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
  type CorpseItemWire, type CorpsesRef, type GameContext, type Interactable, type ItemInstance,
  type PlayerCorpse, type PlayerCorpseWire,
} from '@/shared';
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
  readonly position = new THREE.Vector3();
  readonly group = new THREE.Group();
  emptied = false;
  private readonly model: SoldierModel;

  constructor(
    private readonly ctx: GameContext,
    readonly id: string,
    readonly ownerId: string,
    readonly ownerName: string,
    position: THREE.Vector3,
    readonly yaw: number,
    readonly diedAt: number,
    /** 사망 시점의 전부. 컨테이너를 처음 만들 때만 쓰인다. */
    readonly items: ItemInstance[],
    slot: number,
  ) {
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
    return {
      id: this.id, owner: this.ownerId, name: this.ownerName,
      p: [this.position.x, this.position.y, this.position.z], yaw: this.yaw, at: this.diedAt,
      items: itemsToWire(this.items),
    };
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
    out.push(ex ? { defId: it.defId, qty: it.qty, ex } : { defId: it.defId, qty: it.qty });
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

  constructor(private readonly ctx: GameContext) {}

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
  }
}
