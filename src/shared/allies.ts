/**
 * src/shared/allies.ts — **안드로이드 분대원** (`ctx.allies`). 2026-09-15 사용자 결정 —
 * docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」.
 *
 * 이 파일이 답하는 질문: *사람이 아닌 분대원을 누가 굴리고, 다른 폴더는 무엇을 읽는가.*
 *
 * ## 누가 무엇을 가지나
 * - **분대원 자격** = 릴레이 로비의 봇 멤버 (`LobbyPlayer.bot`, `net.ts` 끝 절). 공용 함선 조종실의 안드로이드 슬롯(bay)
 *   `ANDROID_BAY_COUNT` 칸 중 하나에서 나온다 — 분대장이 `ALLY_BAY_HOLD_S` 꾹 → `lobby:android`. 같은 슬롯을 다시 꾹 = 탈퇴.
 *   사람이 합류해 인원이 넘치면 **가장 늦게 들어온 안드로이드**가 슬롯으로 돌아간다 (릴레이가 판정, `lobby:androidReturned`).
 *   개발 치트 `/android 1|0` 은 서버 없이 **로컬 명단**에 한 기를 넣고 뺀다 (개인 함선에서도 보이고 솔로 레이드에 같이 간다).
 * - **시뮬레이션** = 권위(솔로 · 로비 호스트)의 `allies/`. 리플리카는 `ally state` 스냅샷을 보간해 같은 `AllyBodyView` 를 채운다.
 *   호스트가 바뀌면 새 호스트가 마지막 스냅샷 · `ally bag` 에서 이어받는다.
 * - **몸** = player/ 가 `getBodies()` 를 매 프레임 읽어 `SoldierModel`(안드로이드 외형)로 그린다 — 잠든 슬롯 몸 · 강하 포드 ·
 *   쓰러짐 · 업기 · 총구 섬광 · 소생 상호작용(`revive:ally:<id>`)까지. allies/ 는 메시를 만들지 않는다.
 * - **적** = enemies/ 가 `getCombatBodies()` 를 표적 목록의 곁가지로 넣고, 맞히면 `damage()` 를 부른다 (권위에서만).
 * - **명령** = 새 입력이 없다. 핑(`ping:placedV3`) · 의사소통 휠(`comms:sent`) · 인벤토리 요청(`inventory:itemRequested`,
 *   원격은 `allyq item`)을 듣는다.
 *
 * ## 규칙 (사용자 결정)
 * - 체력 = 사람 × `ALLY_HP_MUL`. 사람처럼 **쓰러지고** PC 가 일으킬 수 있다 (구조 드롭 대상은 아니다). 안드로이드도 쓰러진 PC 를
 *   일으킨다. 2026-09-16 사용자 결정: **사람과 안드로이드가 모두 쓰러지거나 죽어야** 레이드 실패다 (안드로이드가 한 기라도 서 있으면 일으키러 온다). 다른 모든 인원 셈(프레즌스 · prune · 유예)에서 안드로이드는 여전히 사람이 아니다.
 * - 하네스 기준 = **분대장**. 요청(회복 · 실드 · 탄약 · 아이템 · 상자 · 탈출 · 계약)은 **먼저 온 하나**를 받고
 *   `ALLY_REQUEST_COOLDOWN_S` 동안 다른 요청을 무시한다. 이동(`attack` 저쪽으로 가자) · 주의(`caution`) 핑은 분대장 것만 따른다.
 * - 상태가 바뀌면 행동까지 `ALLY_REACT_MIN_S` … `ALLY_REACT_MAX_S` 의 무작위 지연 — 무거운 행동(`ALLY_STATE_WEIGHT`)일수록 길다.
 * - **무한 탄약** (탄창 · 재장전은 있다). 투척물 · 가젯은 쓰지 않는다. 가방의 탄약 · 회복약은 PC 에게 건네는 용도다.
 * - 장비는 매 레이드 **기본 킷**(`ANDROID_KIT`)으로 시작한다. 기본 킷은 **묶인 물건**이다 — 떨구지도, 건네지도, 시체에 남기지도,
 *   창고로 보내지도 않는다 (그러지 않으면 매 레이드 공짜 장비가 생긴다). 레이드에서 주운 것(`raidFound`)만 오가고, 탈출하면
 *   분대장 창고로 간다 (`ally deposit` → `inventory:allyDeposit`).
 * - 공용 함선 전용이다 (개인 함선 슬롯 없음). 로비가 없는 곳에서는 치트 명단만 있다.
 */
import type * as THREE from 'three';
import type { PeerId } from './net';
import type { ItemInstance, PlayerDamageSource } from './types';

/** 안드로이드 id. 로비 봇이면 `LobbyPlayer.id` (`androidIdOf(lobby.code, bay)`), 치트 명단이면 `androidIdOf('local', bay)`. */
export type AllyId = string;

/** 로컬 플레이어를 가리키는 PeerId 대용 — 서버 없는 치트 솔로에서 `carrying` · 요청자 자리에 쓴다. 온라인이면 `ctx.net.localId`. */
export const ALLY_LOCAL_PEER: PeerId = 'local';

/** bay 순서의 표시 이름. 채팅 · 핑 · 분대 목록 · 이름표가 같은 이름을 쓴다. */
export const ANDROID_NAMES_KO: readonly string[] = ['안드로이드 알파', '안드로이드 베타', '안드로이드 감마'];
export function androidNameOf(bay: number): string {
  return ANDROID_NAMES_KO[bay] ?? `안드로이드 ${bay + 1}`;
}

/**
 * 매 레이드의 기본 킷 (아이템 def id — 수치가 아니라 이름이라 TS 에 둔다). 묶인 물건이다: 떨구기 · 건네기 · 시체 · 창고 어디로도
 * 나가지 않는다 (`raidFound` 가 없는 것 = 킷). 갈아낀 뒤 벗은 킷 장비는 그 자리에서 사라진다.
 */
export const ANDROID_KIT: Readonly<{ primary: string; armor: string; bag: string }> = {
  /** 아이템 def id 다 — 무기는 계열 id(`ar`)가 아니라 그 계열의 아이템(`wpn_ar`, `items/itemIdForWeapon`). */
  primary: 'wpn_ar',
  armor: 'armor_2',
  bag: 'bag_common',
};

/** `dormant` = 슬롯 캡슐 안 · `hub` = 함선을 걷는다 · `raid` = 레이드. */
export type AllyMode = 'dormant' | 'hub' | 'raid';
/** 와이어 순서 (`AllyWire.md`). 재정렬 금지. */
export const ALLY_MODES: readonly AllyMode[] = ['dormant', 'hub', 'raid'];

/**
 * FSM 상태. 함선: `dormant` · `emerge`(캡슐에서 나온다) · `retire`(캡슐로 돌아간다) · `hubIdle`(발사 포드 앞 대기 · 치트는 PC 곁).
 * 레이드: `follow`(하네스로 돌아간다) · `roam`(하네스 안 자유 탐색 — 2026-09-16) · `moveTo`(가자 핑) · `lead`(앞장서라) · `watch`(주의 핑) · `combat`(은엄폐) · `loot`(상자) · `pickup`(바닥 아이템) ·
 * `deliver`(요청자에게 떨궈 주기) · `dropJunk`(무거움 해소) · `seekExtract`(탈출구 탐색) · `callExtract`(콘솔 누르기) · `board`(착륙선 탑승) ·
 * `contract`(계약 목표 탐색) · `rescue`(쓰러진 PC 일으키기) · `carry`(재해 밖으로 업고 뛰기) · `downed` · `dead` · `aboard`(이륙선에 탔다).
 */
export type AllyStateId =
  | 'dormant' | 'emerge' | 'retire' | 'hubIdle'
  | 'idle' | 'follow' | 'moveTo' | 'lead' | 'watch' | 'combat'
  | 'loot' | 'pickup' | 'deliver' | 'dropJunk'
  | 'seekExtract' | 'callExtract' | 'board' | 'contract'
  | 'rescue' | 'carry' | 'downed' | 'dead' | 'aboard'
  | 'roam';
/** 와이어 순서 (`AllyWire.st`). 재정렬 금지 — 새 상태는 끝에 붙인다. */
export const ALLY_STATES: readonly AllyStateId[] = [
  'dormant', 'emerge', 'retire', 'hubIdle',
  'idle', 'follow', 'moveTo', 'lead', 'watch', 'combat',
  'loot', 'pickup', 'deliver', 'dropJunk',
  'seekExtract', 'callExtract', 'board', 'contract',
  'rescue', 'carry', 'downed', 'dead', 'aboard',
  /* 2026-09-16 (자유 탐색) — 새 상태는 반드시 끝에 붙인다 (와이어 인덱스). */
  'roam',
];

/** 그리는 자세 (player/ 가 `SoldierModel` 자세로 옮긴다). */
export type AllyPose = 'stand' | 'crouch' | 'downed' | 'dormant' | 'carry' | 'dead';
/** 와이어 순서 (`AllyWire.po`). 재정렬 금지. */
export const ALLY_POSES: readonly AllyPose[] = ['stand', 'crouch', 'downed', 'dormant', 'carry', 'dead'];

/** `AllyBodyView.flags` · `AllyWire.f` 비트. */
export const ALLY_FLAGS = { AIM: 1, FIRE: 2, RELOAD: 4, SPRINT: 8, HIDDEN: 16 } as const;

export interface AllyRosterEntry {
  readonly id: AllyId;
  /** 조종실 슬롯 0..ANDROID_BAY_COUNT-1. */
  readonly bay: number;
  /** 로비 슬롯 (색 · 발사 포드 · 스폰 간격). 치트 명단은 로컬 플레이어가 쓰지 않는 첫 슬롯. */
  readonly slot: number;
  readonly name: string;
  /** 들어온 시각 (ms) — 로비면 릴레이의 `LobbyPlayer.recruitedAt`. */
  readonly recruitedAt: number;
  /** true = 서버 없는 치트 명단의 한 기. */
  readonly local: boolean;
}

/**
 * 한 기의 **읽기 전용 몸 상태** — player(그리기) · enemies(표적) · ui(분대 목록 · 이름표 · 지도)가 매 프레임 읽는다.
 * 객체와 벡터는 재사용된다: 읽고 바로 쓰고 보관하지 않는다.
 */
export interface AllyBodyView {
  readonly id: AllyId;
  readonly name: string;
  readonly bay: number;
  readonly slot: number;
  readonly mode: AllyMode;
  readonly state: AllyStateId;
  readonly pose: AllyPose;
  /** 발 위치 (월드). 함선에서는 함선 원점 좌표 (함선 내부는 원점에 지어진다). */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** 몸 방향 — 원격 플레이어 스냅샷과 같은 규약. */
  readonly yaw: number;
  readonly pitch: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly shield: number;
  readonly maxShield: number;
  /** 쓰러져 있는 동안의 출혈 풀 (쓰러지지 않았으면 0). */
  readonly downHp: number;
  readonly downed: boolean;
  readonly dead: boolean;
  /** 그리지 않는다 — 강하 포드 안 · 이륙한 함선 안 · `ALLY_FLAGS.HIDDEN`. */
  readonly hidden: boolean;
  /** `ALLY_FLAGS` 비트. */
  readonly flags: number;
  /** 손에 든 주무기 def id (GearLook), 없으면 null. */
  readonly weaponDefId: string | null;
  readonly armorDefId: string | null;
  readonly bagDefId: string | null;
  /** 업고 있는 사람의 PeerId (서버 없는 치트 솔로는 `ALLY_LOCAL_PEER`), 없으면 null. */
  readonly carrying: PeerId | null;
  /** 시선 · 조준점 (주의 핑 · 교전 상대). 없으면 null. */
  readonly lookAt: THREE.Vector3 | null;
  /** 걸음 위상 0..1 · 이동 블렌드 0..1 (원격 아바타와 같은 뜻). */
  readonly stridePhase: number;
  readonly moveBlend: number;
}

export interface AllyEquip {
  primary: ItemInstance | null;
  armor: ItemInstance | null;
  bag: ItemInstance | null;
}

/** 소지품 보기 — 리플리카도 마지막 `ally bag` 으로 안다 (호스트 승계 · 시체 · 디버그). */
export interface AllyLoadoutView {
  readonly equip: Readonly<AllyEquip>;
  readonly items: readonly ItemInstance[];
  readonly cols: number;
  readonly rows: number;
  /** kg — 사람과 같은 무게 식 (`InventoryRef.weightInfoFor`). */
  readonly weight: number;
  readonly capacity: number;
}

/** `ctx.allies` (owner: allies/AllySystem). */
export interface AlliesRef {
  /** 내 분대의 안드로이드 (bay 순). 로비면 봇 멤버, 없으면 치트 명단. */
  readonly roster: readonly AllyRosterEntry[];
  /** 이 클라이언트가 안드로이드를 굴리는가 (솔로 · 로비 호스트). */
  readonly simulating: boolean;
  /** 이 클라이언트가 아는 모든 몸 — 공용 함선의 잠든 슬롯 몸 포함. 재사용 배열. */
  getBodies(): readonly AllyBodyView[];
  getBody(id: AllyId): AllyBodyView | null;
  /** 적이 노릴 수 있는 몸 — 레이드 · 쓰러지지도 죽지도 않음 · 보인다. 재사용 배열. enemies 가 매 프레임 부른다. */
  getCombatBodies(): readonly AllyBodyView[];
  getLoadout(id: AllyId): AllyLoadoutView | null;
  /**
   * 피해를 넣는다 (enemies — 권위에서만). 실드 → 체력 → 쓰러짐 → 출혈 끝에 사망. 리플리카에서 부르면 무시한다.
   * `source` = 사람과 같은 피해 출처 (적 개체 id 등).
   */
  damage(id: AllyId, amount: number, source?: PlayerDamageSource, from?: THREE.Vector3): void;
  /**
   * 쓰러진 안드로이드를 일으킨다 — 로컬 플레이어의 소생 홀드 완료(player/) · 제세동기(gadgets/). 권위면 바로, 아니면 `allyq revive`.
   * 요청이 나갔거나 적용됐으면 true.
   */
  requestRevive(id: AllyId, opts?: { defib?: boolean }): boolean;
  /** 이 사람을 업고 있는 안드로이드의 몸 (player/ 가 업힘을 건다), 없으면 null. */
  carrierOf(peer: PeerId): AllyBodyView | null;
  /** 개발 치트 `/android 1|0` — 결과 한 줄(한국어). 콘솔이 부른다. */
  devSetAndroid?(on: boolean): string;
}
