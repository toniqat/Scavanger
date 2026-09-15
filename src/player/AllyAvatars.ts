/**
 * src/player/AllyAvatars.ts — **안드로이드 분대원의 몸** (2026-09-15, 계약 `shared/allies.ts`).
 *
 * 이 파일이 답하는 질문: *`ctx.allies` 가 말하는 안드로이드가 화면에서 어떻게 보이는가.*
 *
 * allies/ 는 메시를 만들지 않는다 — 명단 · FSM · 동기화만 하고 `getBodies()` 로 **읽기 전용 몸 상태**를 내놓는다.
 * 여기서 그 목록을 매 프레임 읽어 한 기당 `SoldierModel` 하나(안드로이드 외형)를 맞춰 준다: 자리 · 방향 · 자세 ·
 * 장비 모습 · 발소리 · 총구 섬광 · 쓰러진 기를 일으키는 상호작용까지. 원격 플레이어와 같은 몸 풀(`SoldierPool`)을
 * 쓰므로 함선 ↔ 레이드를 오가도 몸을 다시 짓지 않는다.
 *
 * **광원을 절대 늘리지 않는다** — 총구 섬광은 `core/fx` 의 고정 개수 풀(`FlashPool`)을 빌려 쓰고, 안드로이드 바이저 ·
 * 관절은 발광 머티리얼이다 (CLAUDE.md §4.5).
 *
 * 몸 상태 객체(`AllyBodyView`)와 그 벡터는 allies/ 가 재사용한다 — **읽고 바로 쓰고 보관하지 않는다.**
 */
import * as THREE from 'three';
import {
  ALLY_FLAGS, FOOTSTEP_MIN_INTERVAL_S, NET_SLOT_COLORS, PLAYER_REVIVE_HOLD, PLAYER_REVIVE_RANGE,
  type AllyBodyView, type AllyId, type AllyMode, type AllyPose, type AllyStateId, type GameContext,
  type Interactable, type PeerId, type WeaponClass, type WeaponDef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, wrapAngle } from '@/core/util/MathUtil';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, type SoldierPose } from './SoldierModel';
import { buildHeldWeapon, type WeaponLook } from './GearLook';
import { resolveArmorDef } from './RemoteAvatar';
import type { SoldierPool } from './SoldierPool';
import { STRIDE_MIN_SPEED } from './PlayerController';

const EMPTY_BODIES: readonly AllyBodyView[] = [];
/** 총성이 이어질 때 반동 맥동 간격 (원격 아바타의 `FIRE_PULSE_INTERVAL` 과 같은 뜻). */
const FIRE_PULSE_INTERVAL = 0.11;
/** 소생 홀드가 끝난 뒤 상호작용을 다시 걸지 않는 시간 (스냅샷이 일어난 상태를 실어 올 때까지). */
const REVIVE_DONE_SUPPRESS = 1.5;
/** 총구 섬광의 세기 · 크기 · 수명 · 거리 — `weapons/fx/WeaponFx.muzzleFlash` 와 같은 값 (같은 풀을 빌려 쓴다). */
const FLASH = { intensity: 7, size: 0.45, life: 0.045, distance: 7 } as const;

const _up = new THREE.Vector3(0, 1, 0);
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spark = new THREE.Vector3();

/**
 * 총성 id — `weapons/WeaponDefaults.shotSoundId` 와 **같은 표**다. weapons/ 는 다른 폴더의 내부라 부를 수 없고
 * (CLAUDE.md §4.1), 이 표를 `shared` 로 옮기는 것은 계약 변경이라 이번 묶음에서 하지 않는다 — 소리 id 가 늘어나면
 * 두 곳을 같이 고친다 (docs/TODO 후보).
 */
function allyShotSound(def: WeaponDef | null): string {
  if (!def) return 'shot_rifle';
  if (def.ammoType === 'energy') return 'shot_energy';
  if (def.pellets && def.pellets > 1) return 'shot_shotgun';
  switch (weaponClassOfDef(def)) {
    case 'SR': return 'shot_sniper';
    case 'SMG': return 'shot_smg';
    case 'PISTOL': return 'shot_pistol';
    case 'SG': return 'shot_shotgun';
    default: return 'shot_rifle';
  }
}

/** `items/WeaponDefs.weaponClassOf` 와 같은 한 줄 (그 폴더를 import 하지 않기 위해 여기 둔다). */
function weaponClassOfDef(def: WeaponDef): WeaponClass {
  return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
}

/** 나이·자세와 무관하게 읽을 수 있는, 스모크가 직접 쓰는 몸 상태 (`debugAllyBody`). */
export interface DebugAllyBody {
  id: AllyId; name: string; bay: number; slot: number;
  mode: AllyMode; state: AllyStateId; pose: AllyPose;
  position: THREE.Vector3; velocity: THREE.Vector3;
  yaw: number; pitch: number;
  hp: number; maxHp: number; shield: number; maxShield: number;
  downHp: number; downed: boolean; dead: boolean; hidden: boolean;
  flags: number;
  weaponDefId: string | null; armorDefId: string | null; bagDefId: string | null;
  carrying: PeerId | null;
  lookAt: THREE.Vector3 | null;
  stridePhase: number; moveBlend: number;
}

/** 소생 상호작용 하나 — 몸을 따라다니게 자기 좌표를 들고 있다. */
interface ReviveEntry { interactable: Interactable; position: THREE.Vector3 }

/**
 * 한 기의 그려지는 몸. 아무것도 시뮬레이션하지 않는다 — 자리 · 플래그는 전부 `AllyBodyView` 에서 오고, 여기서는
 * 스냅샷 사이를 부드럽게 잇는 감쇠 블렌드만 가진다 (원격 아바타와 같은 구조).
 */
export class AllyAvatar {
  readonly model: SoldierModel;
  readonly root: THREE.Group;
  /**
   * 아바타마다 **새 소켓 객체**를 손 소켓 안에 단다 — 몸은 풀에서 온 것일 수 있고, 소켓 정체성으로 부착물을 기억하는
   * 다른 폴더가 죽은 몸에 붙인 것을 살아 있다고 믿지 않게 한다 (`RemoteAvatar` 와 같은 이유).
   */
  readonly weaponSocket: THREE.Object3D;
  seenFrame = 0;

  private bodyYaw: number;
  private shown = false;
  private disposed = false;
  private sprintBlend = 0;
  private crouchBlend = 0;
  private proneBlend = 0;
  private downedBlend = 0;
  private aimBlend = 0;
  private carryBlend = 0;
  private recoil = 0;
  private firePulse = 0;
  /** 감춰진 동안 자세를 한 번 중립으로 되돌렸다 (사망 → 시체가 대신 선다). */
  private poseReset = false;
  private lastStepIdx = 0;
  private stepAt = -Infinity;
  private weaponLook: WeaponLook | null = null;
  private weaponDefId: string | null = null;
  private armorLookId: string | null = null;
  private greyed = false;

  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
  };

  constructor(view: AllyBodyView, parent: THREE.Object3D, private readonly pool: SoldierPool) {
    const accent = NET_SLOT_COLORS[view.slot] ?? SOLDIER_DEFAULT_ACCENT;
    this.model = pool.acquire(accent);
    this.model.setAndroidLook(true);
    this.root = this.model.root;
    this.root.name = `AllySoldier:${view.id}`;
    this.weaponSocket = new THREE.Object3D();
    this.weaponSocket.name = 'AllyWeaponSocket';
    this.model.weaponSocket.add(this.weaponSocket);
    this.bodyYaw = view.yaw;
    this.lastStepIdx = Math.floor(view.stridePhase / Math.PI);
    this.root.position.copy(view.position);
    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    this.root.visible = false;
    parent.add(this.root);
  }

  /** 카메라가 보는 몸인가 (스모크 · 이름표). */
  get isShown(): boolean { return this.shown; }
  get isGreyed(): boolean { return this.greyed; }
  /** 지금 그리는 자세 값 (스모크 전용, 읽기 전용). */
  get poseView(): Readonly<SoldierPose> { return this.pose; }
  /** 손에 든 총의 def id (없으면 null). */
  get heldWeaponId(): string | null { return this.weaponDefId; }
  /** 업힌 몸이 매달리는 어깨 소켓 (`PlayerRef.setCarriedBy`). */
  get shoulderSocket(): THREE.Object3D { return this.model.shoulderSocket; }

  /** 머리 높이 월드 좌표 (이름표 · 디버그). */
  getHeadPosition(out: THREE.Vector3): THREE.Vector3 {
    const lie = Math.min(1, this.proneBlend);
    let h = THREE.MathUtils.lerp(1.7, 1.3, this.crouchBlend);
    h = THREE.MathUtils.lerp(h, 0.5, lie);
    if (this.pose.dead > 0) h = THREE.MathUtils.lerp(h, 0.5, this.pose.dead);
    return out.copy(this.root.position).setY(this.root.position.y + h);
  }

  /** 총구의 월드 좌표를 `out` 에 쓴다 (총이 없으면 false). */
  muzzleWorld(out: THREE.Vector3): boolean {
    const look = this.weaponLook;
    if (!look || !look.group.parent) return false;
    look.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(look.muzzle.matrixWorld);
    return true;
  }

  update(dt: number, ctx: GameContext, v: AllyBodyView): void {
    if (this.disposed) return;
    // 숨어 있어도 자리는 맞춰 둔다 — 소켓 · 핑이 읽는다 (원격 아바타와 같은 규약)
    this.root.position.copy(v.position);
    const dead = v.dead || v.pose === 'dead';
    const visible = !v.hidden && !dead && (v.flags & ALLY_FLAGS.HIDDEN) === 0;
    if (visible !== this.shown) { this.shown = visible; this.model.setVisible(visible); }
    if (!visible) {
      this.model.setSilhouette(false);
      // 사망 = 시체 오브젝트(`game/Corpses`)가 대신 서 있다 — 여기서는 자세를 한 번 되돌려 다음에 다시 쓸 수 있게 둔다
      if (dead && !this.poseReset) { this.poseReset = true; this.model.resetPose(); }
      return;
    }
    this.poseReset = false;

    /* 잠든 슬롯 몸 = 힘이 꺼진 상태 — 원격 분대원의 「정지」와 같은 회색 + 흐린 바이저를 그대로 쓴다 */
    const dormant = v.pose === 'dormant';
    if (dormant !== this.greyed) { this.greyed = dormant; this.model.setGreyed(dormant); }
    const downed = v.downed || v.pose === 'downed';
    this.model.setSilhouette(!dormant);

    this.syncArmor(ctx, v);
    const carry = v.pose === 'carry';
    const wantWeapon = !downed && !dormant && !carry;
    this.syncWeapon(ctx, wantWeapon ? v.weaponDefId : null);

    const flags = v.flags;
    const aiming = (flags & ALLY_FLAGS.AIM) !== 0 && !downed && this.weaponLook !== null;
    const firing = (flags & ALLY_FLAGS.FIRE) !== 0 && !downed;
    const reloading = (flags & ALLY_FLAGS.RELOAD) !== 0 && !downed;
    const sprinting = (flags & ALLY_FLAGS.SPRINT) !== 0 && !downed && !carry;
    const crouching = v.pose === 'crouch' && !downed;

    this.sprintBlend = damp(this.sprintBlend, sprinting ? 1 : 0, 8, dt);
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, crouching ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, downed ? 1 : 0, 8, dt);
    this.downedBlend = damp(this.downedBlend, downed ? 1 : 0, 7, dt);
    this.carryBlend = damp(this.carryBlend, carry && !downed ? 1 : 0, 8, dt);

    if (firing && this.weaponLook) {
      this.firePulse -= dt;
      if (this.firePulse <= 0) { this.recoil = Math.min(1, this.recoil + 0.8); this.firePulse = FIRE_PULSE_INTERVAL; }
    } else {
      this.firePulse = 0;
    }
    this.recoil = damp(this.recoil, 0, 14, dt);

    // 몸 방향: 조준 · 사격 · 재장전 · 쓰러짐 · 잠듦은 `yaw` 를 보고, 그 밖에는 실제 이동 방향을 본다 (로컬 규칙과 같다)
    const vel = v.velocity;
    const speed = dormant ? 0 : Math.hypot(vel.x, vel.z);
    const faceYaw = aiming || firing || reloading || downed || dormant || carry;
    if (faceYaw || speed <= 0.4) this.bodyYaw = dampAngle(this.bodyYaw, v.yaw, downed ? 7 : 12, dt);
    else this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-vel.x, -vel.z), 12, dt);

    this.emitFootstep(ctx, v, sprinting);

    const p = this.pose;
    p.moveBlend = dormant ? 0 : v.moveBlend;
    p.sprint = this.sprintBlend;
    p.stridePhase = v.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.downed = this.downedBlend;
    p.aim = this.aimBlend;
    p.aimPitch = dormant ? 0 : v.pitch;
    p.torsoTwist = wrapAngle(v.yaw - this.bodyYaw);
    p.airborne = 0;
    p.verticalVel = 0;
    p.flinch = 0;
    p.hasWeapon = this.weaponLook !== null && !downed;
    p.twoHanded = this.weaponLook !== null;
    p.reloading = reloading && this.weaponLook !== null;
    p.recoil = this.recoil;
    p.carry = this.carryBlend;
    p.dead = 0;
    this.model.update(dt, ctx.time, p);
    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
  }

  /**
   * 원격 분대원과 **같은 기준**의 발소리 (`remote:footstep`): 보이는 몸 · 걸음 위상이 π 경계를 넘을 때 · 실제로
   * 움직이는 중. 거리 감쇠는 `audio/` 의 몫이다.
   */
  private emitFootstep(ctx: GameContext, v: AllyBodyView, sprinting: boolean): void {
    const idx = Math.floor(v.stridePhase / Math.PI);
    if (idx === this.lastStepIdx) return;
    this.lastStepIdx = idx;
    if (!this.shown || v.downed || v.dead || v.mode === 'dormant' || v.pose === 'dormant') return;
    if (Math.hypot(v.velocity.x, v.velocity.z) <= STRIDE_MIN_SPEED) return;
    if (ctx.time - this.stepAt < FOOTSTEP_MIN_INTERVAL_S) return;
    this.stepAt = ctx.time;
    ctx.bus.emit('remote:footstep', { position: v.position, sprinting, peerId: v.id });
  }

  private syncArmor(ctx: GameContext, v: AllyBodyView): void {
    const id = v.armorDefId ?? null;
    if (id === this.armorLookId) return;
    this.armorLookId = id;
    this.model.setArmor(id ? resolveArmorDef(ctx, id) : null);
  }

  private syncWeapon(ctx: GameContext, defId: string | null): void {
    if (defId === this.weaponDefId) return;
    if (this.weaponLook) { this.weaponLook.group.removeFromParent(); this.weaponLook.dispose(); this.weaponLook = null; }
    this.weaponDefId = defId;
    if (!defId) return;
    const def = ctx.loot?.getWeaponDef(defId) ?? ctx.loot?.getWeaponDef(defId.replace(/_g\d+$/, '')) ?? null;
    const look = buildHeldWeapon(def ? weaponClassOfDef(def) : 'AR');
    this.weaponSocket.add(look.group);   // SoldierModel 이 소켓 자식을 몸 렌더 순서로 올린다
    this.weaponLook = look;
  }

  /** 몸을 풀에 돌려준다 — 이 아바타가 소켓에 걸어 둔 것은 전부 먼저 뗀다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.weaponLook) { this.weaponLook.group.removeFromParent(); this.weaponLook.dispose(); this.weaponLook = null; }
    this.weaponDefId = null;
    this.weaponSocket.removeFromParent();
    this.pool.release(this.model);   // `resetForReuse` 가 안드로이드 외형 · 회색 · 자세를 되돌리고 씬에서 뗀다
  }
}

/**
 * 모든 안드로이드 몸의 수명 관리자 (`RemotePlayerSystem` 이 들고 있다): 몸 만들기 / 돌려주기 · 쓰러진 기의 소생
 * 상호작용 · 총구 연출 · 업힘 소켓 질의.
 */
export class AllyAvatars {
  private readonly avatars = new Map<AllyId, AllyAvatar>();
  private readonly revives = new Map<AllyId, ReviveEntry>();
  /** id → 이 시각까지 소생 상호작용을 다시 걸지 않는다 (막 끝낸 홀드). */
  private readonly reviveSuppress = new Map<AllyId, number>();
  private frame = 0;
  /** 스모크 전용: 이 목록이 있으면 `ctx.allies.getBodies()` 대신 쓴다 (`debugAllyBodies`). */
  private debug: DebugAllyBody[] | null = null;
  /** `clear()` 에서도 상호작용 등록을 풀 수 있게 마지막 `update` 의 ctx 를 들고 있는다. */
  private reviveCtx: GameContext | null = null;

  constructor(private readonly scene: THREE.Object3D, private readonly pool: SoldierPool) {}

  /** 지금 그려지는 몸 수 (스모크 · 디버그). */
  get size(): number { return this.avatars.size; }
  getAvatar(id: AllyId): AllyAvatar | undefined { return this.avatars.get(id); }
  getAvatars(): ReadonlyMap<AllyId, AllyAvatar> { return this.avatars; }
  /** 지금 소생 상호작용이 걸린 기 (스모크). */
  getReviveTargets(): AllyId[] { return [...this.revives.keys()]; }
  has(id: AllyId): boolean { return this.avatars.has(id); }
  /** `id` 의 어깨 소켓 (업힌 로컬 플레이어가 매달리는 자리), 없으면 null. */
  socketOf(id: AllyId): THREE.Object3D | null { return this.avatars.get(id)?.shoulderSocket ?? null; }

  /** 이번 프레임에 그릴 몸 목록 — 스모크 주입이 있으면 그것, 없으면 `ctx.allies`. */
  private bodiesOf(ctx: GameContext): readonly AllyBodyView[] {
    if (this.debug) return this.debug as unknown as readonly AllyBodyView[];
    return ctx.allies?.getBodies() ?? EMPTY_BODIES;
  }

  update(dt: number, ctx: GameContext): void {
    this.frame++;
    this.reviveCtx = ctx;
    const bodies = this.bodiesOf(ctx);
    for (let i = 0; i < bodies.length; i++) {
      const v = bodies[i];
      if (!v || typeof v.id !== 'string') continue;
      const av = this.ensure(v);
      av.seenFrame = this.frame;
      av.update(dt, ctx, v);
      this.syncRevive(ctx, v);
    }
    // 목록에서 사라진 몸은 풀로 돌려보낸다
    if (this.avatars.size > bodies.length) {
      for (const [id, av] of this.avatars) if (av.seenFrame !== this.frame) this.remove(id);
    }
  }

  private ensure(v: AllyBodyView): AllyAvatar {
    let av = this.avatars.get(v.id);
    if (!av) {
      av = new AllyAvatar(v, this.scene, this.pool);
      this.avatars.set(v.id, av);
    }
    return av;
  }

  private remove(id: AllyId): void {
    this.unregisterRevive(id);
    const av = this.avatars.get(id);
    if (!av) return;
    this.avatars.delete(id);
    av.dispose();
  }

  /** 미션 리셋 · 함선 진입: 모든 몸을 풀로 돌려보낸다 (다음 프레임에 명단에서 다시 만들어진다). */
  clear(): void {
    for (const id of [...this.revives.keys()]) this.unregisterRevive(id);
    this.reviveSuppress.clear();
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
  }

  /* ─────────────────────────── 소생 상호작용 ─────────────────────────── */
  /**
   * 쓰러졌지만 죽지 않은 기마다 `revive:ally:<id>` 를 건다 — 사람 분대원과 **같은 홀드 시간 · 사거리 · 진행 UI**.
   * 완료하면 `ctx.allies.requestRevive(id)` 한 줄이고, 권위 판정(거리 · 상태)은 allies/ 가 다시 본다.
   */
  private syncRevive(ctx: GameContext, v: AllyBodyView): void {
    const suppressed = (this.reviveSuppress.get(v.id) ?? 0) > ctx.time;
    const want = v.downed && !v.dead && !v.hidden && v.mode === 'raid' && !suppressed;
    const entry = this.revives.get(v.id);
    if (want && !entry) this.registerRevive(ctx, v);
    else if (!want && entry) this.unregisterRevive(v.id);
    if (!suppressed && this.reviveSuppress.has(v.id)) this.reviveSuppress.delete(v.id);
    const live = this.revives.get(v.id);
    if (live) live.position.copy(v.position);
  }

  private registerRevive(ctx: GameContext, v: AllyBodyView): void {
    const id = v.id;
    const name = v.name;
    const entry: ReviveEntry = { interactable: null as unknown as Interactable, position: v.position.clone() };
    entry.interactable = {
      id: `revive:ally:${id}`,
      position: entry.position,
      radius: PLAYER_REVIVE_RANGE,
      holdTime: PLAYER_REVIVE_HOLD,
      getPrompt: () => `${name} 일으키기`,
      canInteract: () => {
        const me = ctx.player;
        const body = ctx.allies?.getBody(id) ?? this.debugBody(id);
        return !!me && !me.isDead && !me.isDowned && ctx.isGameplayActive() && !!body && body.downed && !body.dead;
      },
      interact: () => {
        ctx.allies?.requestRevive(id);
        ctx.bus.emit('ui:notify', { text: `${name} 부활`, kind: 'success', duration: 2 });
        ctx.bus.emit('audio:play', { id: 'stim', position: entry.position, volume: 0.8 });
        this.reviveSuppress.set(id, ctx.time + REVIVE_DONE_SUPPRESS);
        this.unregisterRevive(id);
      },
    };
    this.revives.set(id, entry);
    ctx.interactables.register(entry.interactable);
  }

  private unregisterRevive(id: AllyId): void {
    const entry = this.revives.get(id);
    if (!entry) return;
    this.revives.delete(id);
    this.reviveCtx?.interactables.unregister(entry.interactable.id);
  }

  /* ─────────────────────────── 연출 ─────────────────────────── */
  /**
   * `ally:fired` — 총구 섬광 · 예광탄 · 총성. 피해는 권위가 이미 넣었다 (연출뿐). 섬광은 고정 개수 풀을 빌려 쓰므로
   * **씬의 광원 개수가 바뀌지 않는다**.
   */
  onFired(ctx: GameContext, id: AllyId, from: THREE.Vector3, to: THREE.Vector3, weaponDefId: string | null): void {
    // 벡터는 allies/ 가 재사용한다 — 먼저 복사한다
    _from.copy(from);
    _to.copy(to);
    const av = this.avatars.get(id);
    if (av && av.isShown) av.muzzleWorld(_from);
    const def = weaponDefId ? ctx.loot?.getWeaponDef(weaponDefId) ?? ctx.loot?.getWeaponDef(weaponDefId.replace(/_g\d+$/, '')) ?? null : null;
    const color = def?.tracerColor ?? 0xffd08a;
    _dir.copy(_to).sub(_from);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1); else _dir.normalize();
    const fx = FxManager.get();
    if (fx) {
      const len = _from.distanceTo(_to);
      fx.tracers.add(_from, _to, color, 0.035, len / 420 + 0.045, 420);
      fx.flashes.flash(_from, color, FLASH.intensity, FLASH.size, FLASH.life, FLASH.distance);
      _spark.copy(_from).addScaledVector(_dir, 0.1);
      ParticleBurst.sparks(fx.additive, _spark, _dir, 3, 9, color);
    }
    ctx.bus.emit('audio:play', { id: allyShotSound(def), position: _from, volume: 0.85, pitch: 0.95 + Math.random() * 0.1 });
  }

  /* ─────────────────────────── 업힘 ─────────────────────────── */
  /** `peer` 를 업고 있는 안드로이드 id (없으면 null). 스모크 주입 몸도 센다. */
  carrierOf(ctx: GameContext, peer: PeerId): AllyId | null {
    if (this.debug) {
      for (const b of this.debug) if (b.carrying === peer && !b.dead) return b.id;
      return null;
    }
    return ctx.allies?.carrierOf(peer)?.id ?? null;
  }

  /* ─────────────────────────── 디버그 (스모크) ─────────────────────────── */
  /**
   * 스모크 전용: `ctx.allies.getBodies()` 를 이 목록으로 **갈아끼운다** (`null` = 원래대로). allies/ 가 아직
   * 없어도 몸 · 자세 · 소생 · 업힘을 그대로 검사할 수 있다.
   */
  debugAllyBodies(views: DebugAllyBody[] | null): void {
    this.debug = views;
  }

  /** 스모크 전용: 기본값이 채워진 몸 하나를 주입 목록에 넣고 돌려준다 (돌려받은 객체를 그 자리에서 고친다). */
  debugAllyBody(opts: Partial<DebugAllyBody> & { id: string }): DebugAllyBody {
    const body: DebugAllyBody = {
      id: opts.id,
      name: opts.name ?? '안드로이드 알파',
      bay: opts.bay ?? 0,
      slot: opts.slot ?? 1,
      mode: opts.mode ?? 'raid',
      state: opts.state ?? 'follow',
      pose: opts.pose ?? 'stand',
      position: opts.position ?? new THREE.Vector3(),
      velocity: opts.velocity ?? new THREE.Vector3(),
      yaw: opts.yaw ?? 0,
      pitch: opts.pitch ?? 0,
      hp: opts.hp ?? 500, maxHp: opts.maxHp ?? 500,
      shield: opts.shield ?? 0, maxShield: opts.maxShield ?? 0,
      downHp: opts.downHp ?? 0,
      downed: opts.downed ?? false,
      dead: opts.dead ?? false,
      hidden: opts.hidden ?? false,
      flags: opts.flags ?? 0,
      weaponDefId: opts.weaponDefId ?? null,
      armorDefId: opts.armorDefId ?? null,
      bagDefId: opts.bagDefId ?? null,
      carrying: opts.carrying ?? null,
      lookAt: opts.lookAt ?? null,
      stridePhase: opts.stridePhase ?? 0,
      moveBlend: opts.moveBlend ?? 0,
    };
    if (!this.debug) this.debug = [];
    this.debug.push(body);
    return body;
  }

  /** 스모크 전용: 주입한 몸 하나 / 전부를 뺀다. */
  debugAllyClear(id?: AllyId): void {
    if (!this.debug) return;
    if (id === undefined) { this.debug = null; return; }
    this.debug = this.debug.filter((b) => b.id !== id);
    if (this.debug.length === 0) this.debug = null;
  }

  private debugBody(id: AllyId): AllyBodyView | null {
    if (!this.debug) return null;
    for (const b of this.debug) if (b.id === id) return b as unknown as AllyBodyView;
    return null;
  }
}
