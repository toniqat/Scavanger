import type { TutorialGate, TutorialStepId } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/model.ts — 폴더 공용 어휘 (상수 · 타입 · 텍스트). 상태는 없다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** localStorage key of the tutorial save (`TutorialSave`). */
export const TUTORIAL_STORAGE_KEY = 'scav.tutorial';
export const TUTORIAL_SAVE_VERSION = 1;

/** UI blocker token the intro / 건너뛰기 팝업 holds (the spotlight holds none — it never takes the cursor itself). */
export const TUTORIAL_BLOCKER = 'tutorial';

/** 튜토리얼이 만들게 하는 것들. */
export const TUTORIAL_ROOM_PURPOSE = 'workshop' as const;
export const TUTORIAL_BENCH_DEF = 'furn_bench_gun';
export const TUTORIAL_GUN_RECIPE = 'make_wpn_ar';
export const TUTORIAL_GUN_DEF = 'wpn_ar';
/*
 * 2026-09-10 (제작 대개편) — `bulk_ammo_medium`(대량 제작, 화약 16 · 폐금속 5 → 90발)이 `data/recipes.csv` 에서
 * 사라져 이 단계가 **영영 끝나지 않았다**. 그 자리를 잇는 것은 `make_ammo_medium`(화약 6 · 폐금속 2 → 30발)이다.
 * `station: 'field'` · `bench` 없음 이라 현장에서도 되고, 작업대 창의 목록은 `bench` 가 없는 레시피를 전부 싣기
 * 때문에(`inventory/parts/Crafting.getRecipes`) **총기 작업대 창에도 그대로 뜬다** — 튜토리얼의 "같은 창에서" 흐름이
 * 그대로다. 산출이 90 → 30발로 줄었지만 뒤 단계(`stowAmmo`)는 "가방에 준중량탄이 있나"만 보므로 수량과 무관하다.
 */
export const TUTORIAL_AMMO_RECIPE = 'make_ammo_medium';
export const TUTORIAL_AMMO_DEF = 'ammo_medium';

/**
 * 제작 단계에서 한 번 지급하는 재료의 **바닥**(`craftGun` 에 들어설 때 함선 창고로).
 * 기본 지급품은 발전기 Lv.1 + 작업실 증축 + 작업대 제작으로 폐금속 20 · 케이블 3 · 합금 2 를 쓰도록 맞춰져 있어
 * 작업대를 짓고 나면 아무것도 만들 수 없다. 소총(`폐금속 8`) + 준중량탄(`화약 6 · 폐금속 2`)에 여유를 더한 양이다
 * (2026-09-10 제작 대개편으로 두 레시피의 재료가 바뀌었다 — 이 표는 늘리지 않는다, 아래 top-up 이 본다).
 *
 * 2026-09-09: 이 표는 바닥일 뿐이고 **실제 필요량은 레시피에서 읽는다** — `TutorialSystem.ensureMaterials(recipeId)`
 * 가 제작 단계(`craftGun` · `craftAmmo`)에 들어설 때마다 재료별 `필요 − 보유` 만큼만 채운다(top-up).
 * 소총이 폐금속 6 을 먹은 뒤 준중량탄의 폐금속 5 가 모자라던 문제가 그래서 없다. 여기에 숫자를 더 적지 않는다.
 */
export const TUTORIAL_CRAFT_GRANT: readonly { defId: string; qty: number }[] = [
  { defId: 'mat_scrap', qty: 16 },
  { defId: 'mat_alloy', qty: 2 },
  { defId: 'mat_gunpowder', qty: 20 },
];

/**
 * 튜토리얼 동안 **함선 창고에 그려지는** 아이템 (`hides('stashItem', defId)`, 2026-09-09). 지급 재료 · 만든 소총 ·
 * 만든 탄약뿐이다 — 기본 지급품(씨앗 · 서적 · 기타 소모품)은 안내가 끝날 때까지 창고에서 사라져 있다.
 * 없어지는 것이 아니라 **그리지 않는** 것이라(`inventory/ui` 의 판정), 건너뛰거나 끝나면 그 자리에 그대로 돌아온다.
 */
export const TUTORIAL_STASH_WHITELIST: readonly string[] = [
  ...TUTORIAL_CRAFT_GRANT.map((g) => g.defId),
  TUTORIAL_GUN_DEF,
  TUTORIAL_AMMO_DEF,
];

/**
 * 건너뛰기 확인 카드의 **홀드 시간** (s, 2026-09-09). 제작 버튼의 1초 홀드(`inventory/model.CRAFT_HOLD_TIME`)와 같은
 * 값이지만 다른 기능 폴더의 내부를 import 하지 않으므로 여기 다시 적는다 — UI 타이밍이라 csv 대상이 아니다.
 */
export const SKIP_HOLD_TIME = 1.0;

/** 안내선 · 스포트라이트가 목표를 다시 찾는 주기 (s) — 매 프레임 DOM 을 뒤지지 않는다. */
export const RETARGET_INTERVAL = 0.25;

/** 바닥 안내선. */
export const GUIDE_COLOR = 0x7ad7ff;
/** 점선 한 마디의 길이 · 간격 (m) 과 흐르는 속도 (m/s). */
export const GUIDE_DASH = 0.34;
export const GUIDE_GAP = 0.26;
export const GUIDE_FLOW = 2.2;
/** 선의 폭 (m) 과 바닥에서 띄우는 높이 (z-fighting 방지). */
export const GUIDE_WIDTH = 0.16;
export const GUIDE_LIFT = 0.03;
/** 목표 빛기둥의 반지름 · 높이. */
export const PILLAR_RADIUS = 0.55;
export const PILLAR_HEIGHT = 3.0;
/** 목표에 이만큼 다가서면 안내선을 걷는다 (m). */
export const GUIDE_ARRIVE = 2.2;

/** 한 단계의 정의. 진행 조건은 `TutorialSystem` 의 이벤트 스위치가 갖는다 — 여기는 표시와 게이트뿐이다. */
export interface StepDef {
  id: TutorialStepId;
  /** 목표 패널의 제목 (한 줄). */
  title: string;
  /** 목표 패널의 부제 — 무엇을 어떻게 하면 되는지. */
  hint: string;
  /**
   * 이 단계에서 **허용**하는 게이트. 여기 없는 게이트는 전부 막힌다.
   * 값이 문자열 배열이면 그 id 만 허용한다 (`roomPurpose: ['workshop']`).
   */
  allow?: Partial<Record<TutorialGate, true | readonly string[]>>;
  // `stashItem` 은 여기 적지 않는다 — 허용 목록이 단계와 무관하게 `TUTORIAL_STASH_WHITELIST` 하나라 `parts/Gates`
  //   가 특별 취급한다 (`raid` 만 `stashItem: true` 로 전부 연다).
  /** 이 단계에서 화면에 뜨는 UI 중 밝힐 요소의 CSS 선택자 (앞에서부터 먼저 찾히는 것 하나). */
  spot?: readonly string[];
  /**
   * `spot` 을 "먼저 찾히는 하나"가 아니라 **전부의 합집합**으로 밝힌다 (2026-09-08).
   * 두 패널에 걸친 드래그를 안내할 때 쓴다 — 하나만 밝히면 출발점이나 도착점이 어두운 판에 덮여 손이 묶인다.
   * 구멍은 사각형 하나이므로 **서로 맞닿은 것들**을 넘겨야 이어진 도형으로 읽힌다.
   */
  spotUnion?: boolean;
  /** 스포트라이트 말풍선 문구 (없으면 `hint`). */
  spotText?: string;
  /** 걸어서 가야 하는 목표 — 안내선이 가리킬 `Interactable.id` (`bench` 는 런타임에 정해진다). */
  guide?: 'bench' | 'terminal' | 'pod';
}

/** 게이트가 막혔을 때 쓰는 기본 문구 — 단계 제목을 끼워 넣는다. */
export const blockedBy = (title: string): string => `튜토리얼 진행 중 — 먼저 '${title}'`;
