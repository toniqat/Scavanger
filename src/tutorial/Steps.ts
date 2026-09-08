import type { TutorialStepId } from '@/shared';
import { PLANET_IDS, TUTORIAL_STEPS } from '@/shared';
import { TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE, type StepDef } from './model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/Steps.ts — **단계 표**. 각 단계가 무엇을 보여 주고 무엇을 허용하는지만 적는다.
 * 무엇으로 다음 단계에 넘어가는지(진행 조건)는 `TutorialSystem.onEvent` 의 스위치에 있다 — 조건이
 * 이벤트마다 제각각이라 표로 만들면 오히려 읽기 어려워진다.
 *
 * `allow` 에 **없는** 게이트는 전부 막힌다 (사용자 결정: 순서를 엄격하게 강제). `community` 와
 * `screenTab`(인벤토리 외)은 어느 단계에도 없으므로 튜토리얼 내내 잠긴다.
 * ──────────────────────────────────────────────────────────────────────────── */

const STEP_DEFS: Readonly<Record<TutorialStepId, StepDef>> = {
  intro: {
    id: 'intro', title: '함선에 오신 것을 환영합니다',
    hint: '안내를 읽고 시작하세요.',
  },
  manage: {
    id: 'manage', title: '함선 관리를 여세요',
    hint: 'M 을 눌러 함선 관리 화면을 엽니다.',
  },
  generator: {
    id: 'generator', title: '발전기를 가동하세요',
    hint: '시설 증축에는 발전기 Lv.1 이 필요합니다. 용도 지정 목록 맨 위의 발전기를 가동하세요.',
    // 작업실도 함께 열어 둔다 — 발전기가 켜지는 순간 바로 다음 단계로 넘어가므로 목록이 흔들리지 않는다.
    allow: { roomPurpose: [TUTORIAL_ROOM_PURPOSE] },
    spot: ['.sm-gen .sm-gen-btn', '.sm-gen', '.sm-side'],
    spotText: '발전기 가동',
  },
  workshop: {
    id: 'workshop', title: '빈 방을 작업실로 증축하세요',
    hint: '방 목록에서 빈 방을 고르고 작업실 증축을 누릅니다.',
    allow: { roomPurpose: [TUTORIAL_ROOM_PURPOSE] },
    spot: ['.sm-purposes .sm-purpose[data-purpose="workshop"]', '.sm-purposes', '.sm-side'],
    spotText: '빈 방의 시설 증축 → 작업실',
  },
  bench: {
    id: 'bench', title: '총기 작업대를 만드세요',
    hint: '가구 제작 탭에서 총기 작업대의 제작을 누릅니다. 만든 가구는 가구 창고로 들어갑니다.',
    allow: { furniture: [TUTORIAL_BENCH_DEF] },
    spot: ['.sm-cards .fcard[data-def-id="furn_bench_gun"]', '.sm-cards', '.sm-side'],
    spotText: '총기 작업대 제작',
  },
  benchPlace: {
    id: 'benchPlace', title: '만든 작업대를 배치하세요',
    hint: '가구 창고 탭에서 총기 작업대를 고른 다음, 작업실 바닥을 클릭해 내려놓습니다.',
    allow: { furniture: [TUTORIAL_BENCH_DEF] },
    // 창고 탭이 아직 열려 있지 않으면 그 탭 버튼을 밝힌다 — 탭 자체가 어두운 판에 덮여 못 눌리던 자리다.
    spot: ['.sm-store .fcard[data-def-id="furn_bench_gun"]', '.sm-tabs .sm-tab[data-tab="store"]', '.sm-side'],
    spotText: '가구 창고 → 총기 작업대',
  },
  manageDone: {
    id: 'manageDone', title: '함선 관리를 닫으세요',
    hint: 'Esc 또는 C 로 관리 모드를 빠져나옵니다.',
    // 작업대는 계속 허용해 둔다 — 막힌 것은 목록에서 사라지므로, 방금까지 보던 카드가 통째로 비지 않도록.
    allow: { manageExit: true, furniture: [TUTORIAL_BENCH_DEF] },
  },
  craftGun: {
    id: 'craftGun', title: '작업대에서 돌격소총을 만드세요',
    hint: '작업실로 걸어가 총기 작업대를 사용하고 돌격소총 제작을 누릅니다.',
    allow: { craft: [TUTORIAL_GUN_RECIPE] },
    spot: ['.inv-craft-row[data-recipe="make_wpn_ar"] .ui-btn', '.inv-craft-row[data-recipe="make_wpn_ar"]', '.inv-panel-craft'],
    spotText: '돌격소총 제작',
    guide: 'bench',
  },
  equipGun: {
    id: 'equipGun', title: '만든 소총을 주무기로 장착하세요',
    hint: 'Tab 을 눌러 가방을 열고 소총을 주무기 I 칸으로 옮깁니다.',
    // 직전 단계의 레시피는 그대로 열어 둔다 — 막힌 레시피는 목록에서 사라지므로 작업대가 통째로 비지 않게.
    allow: { craft: [TUTORIAL_GUN_RECIPE] },
    spot: ['.inv-slot-primary', '.inv-equip'],
    spotText: '소총을 주무기 I 칸으로',
  },
  craftAmmo: {
    id: 'craftAmmo', title: '준중량탄을 만드세요',
    hint: '같은 작업대에서 준중량탄 대량 제작을 누릅니다.',
    allow: { craft: [TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-craft-row[data-recipe="bulk_ammo_medium"] .ui-btn', '.inv-craft-row[data-recipe="bulk_ammo_medium"]', '.inv-panel-craft'],
    spotText: '준중량탄 대량 제작',
    guide: 'bench',
  },
  stowAmmo: {
    id: 'stowAmmo', title: '탄약을 가방에 넣으세요',
    hint: '함선 창고의 준중량탄을 가방 격자로 끌어다 놓습니다.',
    allow: { craft: [TUTORIAL_AMMO_RECIPE] },
    spot: ['.inv-grid-bag', '.inv-panel-bag'],
    spotText: '준중량탄을 가방으로',
  },
  terminal: {
    id: 'terminal', title: '조종석 터미널을 사용하세요',
    hint: '조종석으로 걸어가 터미널에 상호작용합니다.',
    allow: { terminal: true },
    guide: 'terminal',
  },
  planet: {
    id: 'planet', title: '목표 행성을 지정하세요',
    hint: '행성 이동 버튼을 눌러 첫 번째 행성으로 향합니다.',
    allow: { terminal: true, planet: [PLANET_IDS[0]] },
    spot: ['.hp-travel', '.hub-col.centre', '.menu.hub-menu.fullscreen .frame'],
    spotText: '행성 이동',
  },
  travel: {
    id: 'travel', title: '행성으로 이동 중입니다',
    hint: '워프가 끝날 때까지 기다리세요.',
    allow: { terminal: true },
  },
  board: {
    id: 'board', title: '발사 슬롯에 탑승하세요',
    hint: '발사 포드로 걸어가 상호작용하면 임무가 시작됩니다.',
    allow: { terminal: true, board: true },
    guide: 'pod',
  },
  raid: {
    id: 'raid', title: '탈출 지점을 확인하세요',
    hint: '나침반과 화면의 마커가 탈출 지점을 가리킵니다. 안내는 여기까지입니다.',
    // 레이드는 그대로 진행된다 — 이 단계에서는 아무것도 막지 않고 아무것도 감추지 않는다.
    allow: {
      roomPurpose: true, furniture: true, manageExit: true, craft: true,
      terminal: true, planet: true, board: true, screenTab: true,
    },
  },
};

export const stepDef = (id: TutorialStepId): StepDef => STEP_DEFS[id];

/** 다음 단계 (마지막이면 null = 튜토리얼 종료). */
export function nextStep(id: TutorialStepId): TutorialStepId | null {
  const i = TUTORIAL_STEPS.indexOf(id);
  return i < 0 || i + 1 >= TUTORIAL_STEPS.length ? null : TUTORIAL_STEPS[i + 1];
}

/** 1-based 순번 (없는 단계는 0). */
export const stepIndexOf = (id: TutorialStepId | null): number =>
  (id ? TUTORIAL_STEPS.indexOf(id) + 1 : 0);
