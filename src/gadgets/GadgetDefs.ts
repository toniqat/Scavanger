import {
  GADGET_BARRICADE_HP, GADGET_BARRICADE_RECOVER_TIME, GADGET_CLOAK_DURATION, GADGET_CLOAK_SHARE_RADIUS,
  GADGET_DEFUSE_TIME, GADGET_DOME_HP, GADGET_DOME_RADIUS, GADGET_INCENDIARY_DURATION, GADGET_INCENDIARY_RADIUS,
  GADGET_LURE_DURATION, GADGET_LURE_RADIUS, GADGET_MINE_RADIUS, GADGET_SMOKE_DURATION, GADGET_SMOKE_RADIUS,
  GADGET_TURRET_DURATION, GADGET_TURRET_HP, GADGET_TURRET_RANGE,
  GADGET_BARRICADE_RADIUS, GADGET_DEFIB_RANGE, GADGET_JUMPPAD_HP, GADGET_JUMPPAD_RADIUS, GADGET_LURE_HP, GADGET_MINE_HP,
  type DeployableKind, type GadgetDef, type GadgetId,
} from '@/shared';
/* 2026-09-11: 원격 지뢰 · 드론 */
import {
  DRONE_AIR_HP, DRONE_AIR_RANGE, DRONE_GROUND_HP, DRONE_GROUND_RANGE, DRONE_RECOVER_HOLD_S,
  GADGET_REMOTE_MINE_ARM_TIME, GADGET_REMOTE_MINE_HP, GADGET_REMOTE_MINE_RADIUS,
  GADGET_MOUNTED_MINE_TRIGGER_RADIUS, GADGET_REMOTE_MINE_DAMAGE, GADGET_REMOTE_MINE_MAX_LIVE, GADGET_REMOTE_MINE_STACK_MUL,
} from '@/shared';

/**
 * The ten special gadgets. Owned by `src/gadgets/` — `items/` only references them through
 * `ItemDef.gadgetId`, and everyone else reads them via `ctx.gadgets.getDefs()`.
 *
 * `radius` is the gameplay radius the gadget advertises (blast / cloud / cloak share / turret range);
 * physical trigger and collider sizes are private tuning constants in `GadgetSystem` / `Deployable`.
 */
export const GADGET_DEFS: readonly GadgetDef[] = [
  {
    id: 'cloakVeil',
    name: '은폐 장막',
    description: `사용 즉시 자신과 반경 ${GADGET_CLOAK_SHARE_RADIUS} m 안의 아군을 ${GADGET_CLOAK_DURATION}초간 은폐시킨다. 사격·질주·구르기는 은폐를 깨뜨린다.`,
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
    id: 'domeShield',
    name: '돔 실드',
    description: `던진 자리에 반경 ${GADGET_DOME_RADIUS} m 돔형 방어막을 전개한다. 적의 발사체만 막으며 내구도 ${GADGET_DOME_HP}.`,
    use: 'throw',
    deployable: 'domeShield',
    duration: 0,
    hp: GADGET_DOME_HP,
    radius: GADGET_DOME_RADIUS,
    recoverTime: 0,
    icon: '⌒',
    color: '#6fe0ff',
  },
  {
    id: 'barricade',
    name: '바리케이드',
    description: `정면에 대형 차폐물을 설치한다. 총알과 벌레를 모두 막으며, 누구나 ${GADGET_BARRICADE_RECOVER_TIME}초 상호작용으로 해체해 회수할 수 있다.`,
    use: 'place',
    deployable: 'barricade',
    duration: 0,
    hp: GADGET_BARRICADE_HP,
    radius: GADGET_BARRICADE_RADIUS,
    recoverTime: GADGET_BARRICADE_RECOVER_TIME,
    icon: '▤',
    color: '#c9a227',
  },
  {
    id: 'lureGrenade',
    name: '유인 수류탄',
    description: `착탄점에서 ${GADGET_LURE_DURATION}초간 소음을 내 반경 ${GADGET_LURE_RADIUS} m 의 벌레를 끌어당긴다. 원거리 적은 이쪽을 쏜다.`,
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
    description: `반경 ${GADGET_SMOKE_RADIUS} m 연막을 ${GADGET_SMOKE_DURATION}초간 피운다. 적의 시야를 가리지만, 연막 안에서 사격하면 그 위치로 부정확한 대응사격이 날아온다.`,
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
    description: `설치 3초 뒤 활성화되고, 밟으면 반경 ${GADGET_MINE_RADIUS} m 를 폭파한다. 피아를 구분하지 않는다. 드론 위에 올리면 반경 ${GADGET_MOUNTED_MINE_TRIGGER_RADIUS} m 안의 적에게만 반응한다. ${GADGET_DEFUSE_TIME}초 상호작용으로 해체.`,
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
    id: 'turret',
    name: '포탑 설치',
    description: `정면에 자동 포탑을 세운다. ${GADGET_TURRET_RANGE} m 안의 적을 자동 사격하지만 사선의 아군도 맞는다. ${GADGET_TURRET_DURATION}초 후 정지, 상호작용으로 회수.`,
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
    id: 'incendiary',
    name: '화염수류탄',
    description: `착탄점에 ${GADGET_INCENDIARY_DURATION}초간 화염 지대를 만든다. 피아를 구분하지 않고 화상을 입힌다.`,
    use: 'throw',
    deployable: 'fire',
    duration: GADGET_INCENDIARY_DURATION,
    hp: 0,
    radius: GADGET_INCENDIARY_RADIUS,
    recoverTime: 0,
    icon: '🔥',
    color: '#ff7a1a',
  },
  {
    id: 'defib',
    name: '제세동기',
    description: '쓰러진 아군을 즉시 최대 체력으로 일으켜 세운다. 사거리 안에 다운된 아군이 있어야 사용된다.',
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
    description: '밟으면 높이 튀어오르고, 달리면서 밟으면 전방으로 크게 도약한다. 상호작용으로 회수.',
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
    description: `설치 ${GADGET_REMOTE_MINE_ARM_TIME}초 뒤 무장된다. 손에 들고 우클릭하면 내가 설치한 원격 지뢰가 한꺼번에 터진다 (반경 ${GADGET_REMOTE_MINE_RADIUS} m, 중심 피해 ${GADGET_REMOTE_MINE_DAMAGE}). 여러 발에 함께 맞으면 가장 센 한 발만 온전히, 나머지는 각각 ${Math.round(GADGET_REMOTE_MINE_STACK_MUL * 100)} % 로 들어간다. 밟아도 터지지 않고, 부서지면 불발로 사라진다. 한 사람당 ${GADGET_REMOTE_MINE_MAX_LIVE}개까지, ${GADGET_DEFUSE_TIME}초 상호작용으로 회수. 드론 위에도 올릴 수 있다.`,
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
    description: `바닥에 내려놓는 정찰 드론. 손에 들고 R 을 꾹 누르면 드론 시점으로 조종한다 (사거리 ${DRONE_GROUND_RANGE} m, 내구도 ${DRONE_GROUND_HP}). 달리면 빠르지만 소리가 나 적이 알아챈다. 위에 지뢰를 올릴 수 있다.`,
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
    description: `공중에 띄우는 정찰 드론. 손에 들고 R 을 꾹 누르면 조종한다 — Space 상승 · C 하강 (사거리 ${DRONE_AIR_RANGE} m, 내구도 ${DRONE_AIR_HP}). 연결이 끊겨도 제자리에 떠 있고, 갈고리를 걸 수 있다.`,
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

const BY_ID = new Map<GadgetId, GadgetDef>(GADGET_DEFS.map((d) => [d.id, d]));
const BY_KIND = new Map<DeployableKind, GadgetDef>();
for (const d of GADGET_DEFS) if (d.deployable) BY_KIND.set(d.deployable, d);

export function gadgetDef(id: GadgetId): GadgetDef | undefined { return BY_ID.get(id); }
/** Every deployable kind is produced by exactly one gadget, so the reverse lookup is unambiguous. */
export function gadgetForKind(kind: DeployableKind): GadgetDef | undefined { return BY_KIND.get(kind); }

/** Deployables that hand an item back when someone finishes the recover interaction. */
export const RECOVERABLE_KINDS: readonly DeployableKind[] = ['barricade', 'turret', 'jumpPad',
  /* 2026-09-11: 원격 지뢰는 밟아도 안 터지는 소유자 도구라 회수하면 아이템이 돌아온다 (바닥 지뢰는 해체 = 반환 없음 그대로) */
  'remoteMine'];
export function isRecoverable(kind: DeployableKind): boolean { return RECOVERABLE_KINDS.includes(kind); }

/** Deployables enemies should attack when they block or annoy them. */
export const ENEMY_TARGET_KINDS: readonly DeployableKind[] = ['barricade', 'turret', 'lure', 'domeShield'];

/** Deployables that stop projectiles (dome shields only stop hostile ones). */
export const SOLID_KINDS: readonly DeployableKind[] = ['barricade', 'domeShield'];
