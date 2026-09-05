import {
  IMPLANT_AT_COOLDOWN, IMPLANT_DASH_CHARGES, IMPLANT_DASH_COOLDOWN, IMPLANT_GRAPPLE_COOLDOWN, IMPLANT_SCAN_COOLDOWN,
  IMPLANT_IDS, type ImplantDef, type ImplantId,
} from '@/shared';

/**
 * The six tactical implants. Everyone owns all of them; exactly one may be equipped and only in the ship.
 *
 * `cooldown` 0 = the implant has no timer at all (barrier is limited by its shield hp, overcharge by the
 * beam itself). ImplantSystem stores the *effective* total of the running cooldown so a special case
 * (barrier collapse lockout) can use a different number without lying to the HUD.
 */
export const IMPLANT_DEFS: readonly ImplantDef[] = [
  {
    id: 'grapple',
    name: '갈고리',
    description: '와이어 앵커를 발사해 지형이나 지물에 고정하고 그 지점으로 몸을 끌어당긴다. 조준점이 초록색이면 걸 수 있다.',
    mode: 'wielded',
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
    description: '정면에 넓은 에너지 실드를 전개한다. 적의 발사체만 막으며, 접었을 때 내구도가 회복된다.',
    mode: 'instant',
    cooldown: 0,
    charges: 1,
    icon: '▤',
    color: '#5fd7ff',
  },
  {
    id: 'overcharge',
    name: '오버차지',
    description: '좌클릭으로 아군을 회복하고, 우클릭으로 자신과 대상의 이동속도·연사속도를 올리며 스태미나 소모를 없앤다.',
    mode: 'wielded',
    cooldown: 0,
    charges: 1,
    icon: '⚡',
    color: '#ffc23a',
  },
  {
    id: 'scan',
    name: '정찰',
    description: '좌클릭을 누르고 있으면 1초마다 파동이 퍼진다. 파동마다 범위가 넓어지며, 감지한 대상은 벽 너머로 10초간 표시된다.',
    mode: 'wielded',
    cooldown: IMPLANT_SCAN_COOLDOWN,
    charges: 1,
    icon: '◎',
    color: '#7cf07a',
  },
  {
    id: 'atlauncher',
    name: '대전차포',
    description: '좌클릭으로 대전차 로켓을 발사한다. 착탄 지점에 큰 폭발이 일어난다.',
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
