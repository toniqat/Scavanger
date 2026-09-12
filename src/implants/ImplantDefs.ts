import {
  IMPLANT_AT_COOLDOWN, IMPLANT_DASH_CHARGES, IMPLANT_DASH_COOLDOWN, IMPLANT_GRAPPLE_COOLDOWN, IMPLANT_SCAN_COOLDOWN_V2,
  IMPLANT_IDS, type ImplantDef, type ImplantId,
} from '@/shared';

/**
 * The six tactical implants. Everyone owns all of them; exactly one may be equipped and only in the ship.
 *
 * Modes (reworked 2026-09-06, revised Phase 10 / Phase 12): 갈고리 / 대시 / **정찰** are `instant` (Q casts, the gun
 * stays in hand — 정찰 became one wide pulse on 2026-09-08), 오버차지 is `hold` (the effect runs while Q is held), and
 * 대전차포 / **배리어** are `wielded` (Q takes them into the hands, the gun is holstered; Q or a weapon key puts them away).
 * `cooldown` 0 = no timer at all (barrier is limited by its shield hp, overcharge by its energy pool).
 * ImplantSystem stores the *effective* total of the running cooldown so a special case (barrier collapse
 * lockout) can use a different number without lying to the HUD.
 */
export const IMPLANT_DEFS: readonly ImplantDef[] = [
  {
    id: 'grapple',
    name: '갈고리',
    description: 'Q를 누르면 조준점의 지형·지물에 와이어 앵커를 박고 그 지점으로 몸을 끌어당긴다. 조준점 괄호가 켜지면 걸 수 있다. 다시 누르면 와이어를 끊는다. 붙기 전에 끊으면 재사용 대기시간 대부분을 돌려받고, 붙은 뒤에는 짧게 끌려갈수록 더 돌려받는다.',
    mode: 'instant',
    cooldown: IMPLANT_GRAPPLE_COOLDOWN,
    charges: 1,
    icon: '⚓',
    color: '#8fe8ff',
  },
  {
    id: 'dash',
    name: '대시',
    description: '정면으로 짧게 순간이동한다. 충전 3회, 충전당 재사용 대기시간이 따로 돈다.',
    mode: 'instant',
    cooldown: IMPLANT_DASH_COOLDOWN,
    charges: IMPLANT_DASH_CHARGES,
    icon: '»',
    color: '#c8a2ff',
  },
  {
    id: 'barrier',
    name: '배리어',
    description: '앞을 넓게 막는 에너지 방패를 든다. 적의 발사체와 정면 근접공격을 대신 맞고, 벌레는 방패를 뚫고 지나가지 못한다. 든 채로 좌클릭·근접키 = 실드 배쉬(스태미나 소모). 파괴되면 10초간 재충전한다.',
    mode: 'wielded',
    cooldown: 0,
    charges: 1,
    icon: '▤',
    color: '#5fd7ff',
  },
  {
    id: 'overcharge',
    name: '오버차지',
    description: 'Q를 누르고 있는 동안 자신을 천천히 회복하고, 조준점의 아군도 함께 회복한다. 체력이 90% 이상이면 이동속도·연사속도가 오른다. 에너지를 소모하며 놓으면 재충전된다.',
    mode: 'hold',
    cooldown: 0,
    charges: 1,
    icon: '⚡',
    color: '#ffc23a',
  },
  {
    id: 'scan',
    name: '정찰',
    description: 'Q를 누르면 이동 중에도 즉시 넓은 정찰 파동이 한 번 퍼진다. 반경 70 m 안의 상호작용물과 적이 15초 동안 나와 아군 모두에게 벽 너머로 표시되고, 적은 나침반에 붉게 뜬다.',
    mode: 'instant',
    cooldown: IMPLANT_SCAN_COOLDOWN_V2,
    charges: 1,
    icon: '◎',
    color: '#7cf07a',
  },
  {
    id: 'atlauncher',
    name: '대전차포',
    description: 'Q로 발사기를 꺼내 들고 좌클릭으로 대전차 로켓을 발사한다. 착탄 지점에 큰 폭발이 일어난다. 무기 키를 누르면 집어넣는다.',
    mode: 'wielded',
    cooldown: IMPLANT_AT_COOLDOWN,
    charges: 1,
    icon: '➤',
    color: '#ff8a4a',
  },
];

const BY_ID = new Map<ImplantId, ImplantDef>(IMPLANT_DEFS.map((d) => [d.id, d]));

export function getImplantDef(id: ImplantId): ImplantDef | undefined {
  return BY_ID.get(id);
}

/** True when `id` is one of the known implant ids (profile / wire values are untrusted). */
export function isImplantId(id: unknown): id is ImplantId {
  return typeof id === 'string' && (IMPLANT_IDS as readonly string[]).includes(id);
}

/** Colour of an implant as a hex number for world FX (`ImplantDef.color` is CSS for the HUD). */
export function implantHex(id: ImplantId): number {
  const css = BY_ID.get(id)?.color ?? '#ffffff';
  const n = Number.parseInt(css.slice(1), 16);
  return Number.isFinite(n) ? n : 0xffffff;
}
