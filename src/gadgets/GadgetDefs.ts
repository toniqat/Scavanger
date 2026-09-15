import {
  GADGET_BARRICADE_HP, GADGET_BARRICADE_RECOVER_TIME, GADGET_CLOAK_DURATION, GADGET_CLOAK_SHARE_RADIUS,
  GADGET_DEFUSE_TIME, GADGET_DOME_HP, GADGET_DOME_RADIUS,
  GADGET_LURE_DURATION, GADGET_LURE_RADIUS, GADGET_MINE_RADIUS, GADGET_SMOKE_DURATION, GADGET_SMOKE_RADIUS,
  GADGET_TURRET_DURATION, GADGET_TURRET_HP, GADGET_TURRET_RANGE,
  GADGET_BARRICADE_RADIUS, GADGET_DEFIB_RANGE, GADGET_JUMPPAD_HP, GADGET_JUMPPAD_RADIUS, GADGET_LURE_HP, GADGET_MINE_HP,
  type DeployableKind, type GadgetDef, type GadgetId,
} from '@/shared';
/* 2026-09-11: 원격 지뢰 · 드론 */
import {
  DRONE_AIR_HP, DRONE_AIR_RANGE, DRONE_GROUND_HP, DRONE_GROUND_RANGE, DRONE_RECOVER_HOLD_S,
  GADGET_REMOTE_MINE_HP, GADGET_REMOTE_MINE_RADIUS,
} from '@/shared';
/* 2026-09-15 (가젯 개편, 사용자 결정): 돔 실드 회수 시간 · 화염 지대 수치 통합 (아래 「화염 통합」 주석) */
import { GADGET_DOME_RECOVER_TIME, GRENADE_INCENDIARY_DURATION, GRENADE_INCENDIARY_RADIUS } from '@/shared';

/**
 * 특수 가젯 정의. Owned by `src/gadgets/` — `items/` only references them through `ItemDef.gadgetId`,
 * and everyone else reads them via `ctx.gadgets.getDefs()`.
 *
 * `radius` is the gameplay radius the gadget advertises (blast / cloud / cloak share / turret range);
 * physical trigger and collider sizes are private tuning constants in `GadgetSystem` / `Deployable`.
 *
 * **2026-09-15 (가젯 개편, 사용자 결정) — `description` 에는 숫자를 적지 않는다.** 사거리 · 지속 · 내구도 ·
 * 사용 시간은 툴팁의 **스펙 줄**이 이 정의(`duration` · `hp` · `radius` · `recoverTime`)와 아이템 def 에서
 * 읽어 그린다. 설명은 「무엇을 하는 물건인가」만 말한다 — 같은 숫자를 두 곳에서 말하면 표를 고칠 때 글이
 * 따라오지 않는다 (2026-09-12 「설명 글에 툴팁이 이미 보여 주는 숫자를 적지 않는다」와 같은 근거).
 * 필드 값 자체는 그대로다 (툴팁이 그것을 읽는다).
 */
export const GADGET_DEFS: readonly GadgetDef[] = [
  {
    id: 'cloakVeil',
    name: '은폐 장막',
    description: '사용 즉시 자신과 주변 아군을 은폐시킨다. 사격·질주·구르기는 은폐를 깨뜨린다.',
    use: 'self',
    deployable: null,
    duration: GADGET_CLOAK_DURATION,
    hp: 0,
    radius: GADGET_CLOAK_SHARE_RADIUS,
    recoverTime: 0,
    icon: '◌',
    color: '#9fd8ff',
  },
  {
    /**
     * 2026-09-15 (사용자 결정): 던진 자리에 **돔 실드 개체**가 서고 그 둘레로 방어막이 켜진다.
     * 개체를 꾹 누르면 회수되고(`GADGET_DOME_RECOVER_TIME`), 방어막이 깎인 만큼이 **아이템 내구도**로 남는다
     * (`wearsItemDurability` — 최대 hp 는 여기 `hp` 가 아니라 그 아이템의 `ItemDef.durabilityMax`).
     */
    id: 'domeShield',
    name: '돔 실드',
    description: '던진 자리에 방어막 발생기를 세운다. 돔은 적의 발사체만 막고, 발생기를 꾹 누르면 회수된다.',
    use: 'throw',
    deployable: 'domeShield',
    duration: 0,
    hp: GADGET_DOME_HP,
    radius: GADGET_DOME_RADIUS,
    recoverTime: GADGET_DOME_RECOVER_TIME,
    wearsItemDurability: true,
    icon: '⌒',
    color: '#6fe0ff',
  },
  {
    id: 'barricade',
    name: '바리케이드',
    description: '조준한 자리에 대형 차폐물을 설치한다. 총알과 벌레를 모두 막고, 누구나 꾹 눌러 회수할 수 있다.',
    use: 'place',
    deployable: 'barricade',
    duration: 0,
    hp: GADGET_BARRICADE_HP,
    radius: GADGET_BARRICADE_RADIUS,
    recoverTime: GADGET_BARRICADE_RECOVER_TIME,
    /* 2026-09-15 (사용자 결정): 돔 실드와 같은 규칙 — 맞은 만큼이 아이템 내구도로 남아 작업대 수리가 필요해진다. */
    wearsItemDurability: true,
    icon: '▤',
    color: '#c9a227',
  },
  {
    id: 'lureGrenade',
    name: '유인 수류탄',
    description: '착탄점에서 소음을 내 주변의 벌레를 끌어당긴다. 원거리 적은 이쪽을 쏜다.',
    use: 'throw',
    deployable: 'lure',
    duration: GADGET_LURE_DURATION,
    hp: GADGET_LURE_HP,
    radius: GADGET_LURE_RADIUS,
    recoverTime: 0,
    icon: '♪',
    color: '#ffd166',
  },
  {
    id: 'smokeGrenade',
    name: '연막탄',
    description: '연막을 피워 적의 시야를 가린다. 연막 안에서 사격하면 그 위치로 부정확한 대응사격이 날아온다.',
    use: 'throw',
    deployable: 'smoke',
    duration: GADGET_SMOKE_DURATION,
    hp: 0,
    radius: GADGET_SMOKE_RADIUS,
    recoverTime: 0,
    icon: '☁',
    color: '#b9c3cc',
  },
  {
    id: 'mine',
    name: '지뢰',
    description: '설치 후 활성화되고, 밟으면 폭발한다. 피아를 구분하지 않는다. 드론 위에 올리면 적에게만 반응한다.',
    use: 'place',
    deployable: 'mine',
    duration: 0,
    hp: GADGET_MINE_HP,
    radius: GADGET_MINE_RADIUS,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '◉',
    color: '#ff5a3c',
  },
  {
    /* 2026-09-15 (사용자 결정): 이름은 「포탑 설치」 → **자동 사격 포탑** (items.csv 의 아이템 이름도 같이 바뀐다). */
    id: 'turret',
    name: '자동 사격 포탑',
    description: '조준한 자리에 자동 포탑을 세운다. 사거리 안의 적을 알아서 쏘지만 사선의 아군도 맞는다. 꾹 눌러 회수.',
    use: 'place',
    deployable: 'turret',
    duration: GADGET_TURRET_DURATION,
    hp: GADGET_TURRET_HP,
    radius: GADGET_TURRET_RANGE,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '⌖',
    color: '#7cf07a',
  },
  {
    id: 'defib',
    name: '제세동기',
    description: '쓰러진 아군을 즉시 회복시킨다. 좌클릭을 꾹 눌러 충전한 뒤 대상을 겨누고 놓는다.',
    use: 'target',
    deployable: null,
    duration: 0,
    hp: 0,
    radius: GADGET_DEFIB_RANGE,
    recoverTime: 0,
    icon: '⚡',
    color: '#ff5f8f',
  },
  {
    id: 'jumpPad',
    name: '점프대',
    description: '밟으면 높이 튀어오르고, 달리면서 밟으면 전방으로 크게 도약한다. 꾹 눌러 회수.',
    use: 'place',
    deployable: 'jumpPad',
    duration: 0,
    hp: GADGET_JUMPPAD_HP,
    radius: GADGET_JUMPPAD_RADIUS,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '⇧',
    color: '#5fd7ff',
  },
  /* ── 2026-09-11 ── */
  {
    id: 'remoteMine',
    name: '원격 지뢰',
    description: '설치하면 잠시 뒤 무장된다. 손에 들고 우클릭하면 내가 설치한 것이 한꺼번에 터진다. 밟아도 터지지 않고, 부서지면 불발로 사라진다. 꾹 눌러 회수하거나 드론 위에 올릴 수 있다.',
    use: 'place',
    deployable: 'remoteMine',
    duration: 0,
    hp: GADGET_REMOTE_MINE_HP,
    radius: GADGET_REMOTE_MINE_RADIUS,
    recoverTime: GADGET_DEFUSE_TIME,
    icon: '▣',
    color: '#ff9f40',
  },
  {
    id: 'droneGround',
    name: '지상 드론',
    description: '바닥에 내려놓는 정찰 드론. 손에 들고 R 을 꾹 누르면 드론 시점으로 조종한다. 달리면 빠르지만 소리가 나 적이 알아챈다. 위에 지뢰를 올릴 수 있다.',
    use: 'drone',
    deployable: null,
    duration: 0,
    hp: DRONE_GROUND_HP,
    radius: DRONE_GROUND_RANGE,
    recoverTime: DRONE_RECOVER_HOLD_S,
    icon: '⛭',
    color: '#8fd18a',
  },
  {
    id: 'droneAir',
    name: '공중 드론',
    description: '공중에 띄우는 정찰 드론. 손에 들고 R 을 꾹 누르면 조종한다 — Space 상승 · C 하강. 연결이 끊겨도 제자리에 떠 있고, 갈고리를 걸 수 있다.',
    use: 'drone',
    deployable: null,
    duration: 0,
    hp: DRONE_AIR_HP,
    radius: DRONE_AIR_RANGE,
    recoverTime: DRONE_RECOVER_HOLD_S,
    icon: '✈',
    color: '#7fc8ff',
  },
];

/**
 * **아이템이 없는 내부 정의.** `getDefs()` · 퀵슬롯 · 콘솔 어디에도 나오지 않고 `use()` 는 거절한다
 * (`isInternalGadget` — 아이템 매칭이 없으면 소모 없이 통과하는 옛 병렬 개발 규칙 때문에, 막지 않으면 공짜로 쓸 수 있다).
 *
 * ## 화염 통합 (2026-09-15, 사용자 결정)
 *
 * 화염 지대를 만드는 길이 **둘**이었다 — 던지는 가젯 `화염수류탄`(아이템 `gad_incendiary`, `GADGET_INCENDIARY_*`
 * 반경 5 · 10 초)과 G-10 소이 수류탄이 터진 자리의 내부 가젯 `grenadeFire`(`GRENADE_INCENDIARY_*` 반경 3.5 · 6 초).
 * 이제 하나다:
 *
 * - **아이템 `gad_incendiary` 가 사라진다** (items.csv · alias → `grenade_incendiary`). 살아남는 것은
 *   **「화염 수류탄」 `grenade_incendiary`** 이고 **폭발과 화염 지대를 동시에** 한다 (폭발은 weapons `Grenade`
 *   의 `GRENADE_INCENDIARY_BLAST_*`, 지대는 여기).
 * - **살아남는 수치는 `GRENADE_INCENDIARY_*`** 다 — 「폭발 + 지대」 한 벌로 튜닝된 값이고 폭발 수치
 *   (`GRENADE_INCENDIARY_BLAST_*`)와 같은 묶음이기 때문이다. `GADGET_INCENDIARY_RADIUS` ·
 *   `GADGET_INCENDIARY_DURATION` 은 **은퇴**(리드가 csv 를 정리한다). 초당 피해 `GADGET_INCENDIARY_DPS` 는
 *   지대 전체의 값이라 **그대로 산다**.
 * - **가젯 id 는 `incendiary` 하나로 남는다** — `GadgetId` 는 계약이라 `grenadeFire` 도 타입에 그대로 있지만
 *   (`airstrike` · `secondary` 와 같은 은퇴 표시) **정의는 없다**. 그래서 `deployable: 'fire'` 를 만드는 정의가
 *   정확히 하나가 되고, `gadgetForKind('fire')` 가 모호하지 않게 답한다.
 * - 그 모호함을 풀려고 만들었던 **배치물 id 의 `-gf` 표식은 필요 없어졌다** (`deployableIdFor` 는 늘 `-g`,
 *   `defForWire` 는 `kind` 만 본다 — 옛 `-gf` id 를 받아도 같은 정의로 풀리므로 호환도 그대로다).
 */
export const INTERNAL_GADGET_DEFS: readonly GadgetDef[] = [
  {
    id: 'incendiary',
    name: '화염 지대',
    description: '화염 수류탄이 터진 자리에 남는 불. 피아를 구분하지 않고 화상을 입힌다.',
    use: 'throw',
    deployable: 'fire',
    duration: GRENADE_INCENDIARY_DURATION,
    hp: 0,
    radius: GRENADE_INCENDIARY_RADIUS,
    recoverTime: 0,
    icon: '🔥',
    color: '#ff7a1a',
  },
];

const BY_ID = new Map<GadgetId, GadgetDef>([...GADGET_DEFS, ...INTERNAL_GADGET_DEFS].map((d) => [d.id, d]));
/** 공개 정의가 먼저, 내부 정의는 그 종류를 아무도 안 만들 때만 (지금은 `fire` 하나). */
const BY_KIND = new Map<DeployableKind, GadgetDef>();
for (const d of [...GADGET_DEFS, ...INTERNAL_GADGET_DEFS]) if (d.deployable && !BY_KIND.has(d.deployable)) BY_KIND.set(d.deployable, d);
const INTERNAL_IDS = new Set<GadgetId>(INTERNAL_GADGET_DEFS.map((d) => d.id));

export function gadgetDef(id: GadgetId): GadgetDef | undefined { return BY_ID.get(id); }
/** Every deployable kind is produced by exactly one gadget, so the reverse lookup is unambiguous. */
export function gadgetForKind(kind: DeployableKind): GadgetDef | undefined { return BY_KIND.get(kind); }
/** 아이템 없이 코드만 세우는 내부 가젯인가 (`use()` 가 거절한다). */
export function isInternalGadget(id: GadgetId): boolean { return INTERNAL_IDS.has(id); }

/**
 * 배치물 id. 2026-09-15 의 화염 통합으로 `fire` 를 만드는 정의가 하나뿐이 되어 **`-gf` 표식은 은퇴했다**
 * (그 전에는 `DeployableWire` 에 가젯 id 칸이 없어 화염수류탄과 G-10 화염을 id 로 갈라야 했다).
 * 인자 `gadget` 은 호출부를 그대로 두려고 남긴 것이고 id 모양에 영향을 주지 않는다.
 */
export function deployableIdFor(base: string, seq: number, gadget?: GadgetId): string {
  void gadget;
  return `${base}-g${seq}`;
}
/** 와이어의 배치물 → 그 정의. `kind` 하나로 정해진다 (옛 `-gf` id 도 같은 정의로 풀린다). */
export function defForWire(w: { id: string; kind: DeployableKind }): GadgetDef | undefined {
  return BY_KIND.get(w.kind);
}

/**
 * Deployables that hand an item back when someone finishes the recover interaction.
 * 2026-09-15: 돔 실드가 들어왔다 — 중앙 발생기를 꾹 눌러 회수하고 남은 hp 가 아이템 내구도로 간다.
 */
export const RECOVERABLE_KINDS: readonly DeployableKind[] = ['barricade', 'turret', 'jumpPad',
  /* 2026-09-11: 원격 지뢰는 밟아도 안 터지는 소유자 도구라 회수하면 아이템이 돌아온다 (바닥 지뢰는 해체 = 반환 없음 그대로) */
  'remoteMine',
  /* 2026-09-15 (사용자 결정) */
  'domeShield'];
export function isRecoverable(kind: DeployableKind): boolean { return RECOVERABLE_KINDS.includes(kind); }

/** Deployables enemies should attack when they block or annoy them. */
export const ENEMY_TARGET_KINDS: readonly DeployableKind[] = ['barricade', 'turret', 'lure', 'domeShield'];

/** Deployables that stop projectiles (dome shields only stop hostile ones). */
export const SOLID_KINDS: readonly DeployableKind[] = ['barricade', 'domeShield'];
