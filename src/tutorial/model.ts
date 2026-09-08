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
export const TUTORIAL_AMMO_RECIPE = 'bulk_ammo_medium';
export const TUTORIAL_AMMO_DEF = 'ammo_medium';

/**
 * 제작 단계에서 한 번 지급하는 재료 (`craftGun` 에 들어설 때 함선 창고로).
 * 기본 지급품은 발전기 Lv.1 + 작업실 증축 + 작업대 제작으로 폐금속 20 · 케이블 3 · 합금 2 를 쓰도록 맞춰져 있어
 * 작업대를 짓고 나면 아무것도 만들 수 없다. 소총(`폐금속 6 · 합금 1`) + 준중량탄(`화약 16 · 폐금속 5`)에
 * 여유를 더한 양이다.
 */
export const TUTORIAL_CRAFT_GRANT: readonly { defId: string; qty: number }[] = [
  { defId: 'mat_scrap', qty: 16 },
  { defId: 'mat_alloy', qty: 2 },
  { defId: 'mat_gunpowder', qty: 20 },
];

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
