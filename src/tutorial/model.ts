import type { KeyBindings, TutorialGate, TutorialStepId, TutorialTrack } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/model.ts — 폴더 공용 어휘 (상수 · 타입 · 텍스트). 상태는 없다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** localStorage key of the tutorial save (`TutorialSave`). */
export const TUTORIAL_STORAGE_KEY = 'scav.tutorial';
/**
 * **v2 (2026-09-14)** — 트랙별 저장(`TutorialSave.tracks`). v1(`step` · `done` 최상위)은 읽을 때
 * `tracks.build` 로 옮겨 붙이고 `raid` · `ship` 은 **이미 끝난 것으로** 본다 (하던 사람에게 새 안내가 뜨면 안 된다).
 */
export const TUTORIAL_SAVE_VERSION = 2;

/** 트랙 이름 — 목표 패널 라벨 · 건너뛰기 확인 카드 문구. */
export const TRACK_LABEL_KO: Readonly<Record<TutorialTrack, string>> = {
  raid: '조작 안내',
  ship: '함선 안내',
  build: '증축 안내',
};

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

/* ════════════════════════════════════════════════════════════════════════════
 * 우측 조작 가이드 (2026-09-14, `docs/plans/tutorial-raid.md` C)
 *
 * 배운 조작이 **한 줄씩 쌓이고 사라지지 않는다.** 우하단 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)는 "지금 열린
 * 화면의 키"라 매번 바뀌지만 이쪽은 누적이라 자리가 아예 다르다 — 화면 **우측 세로 가운데**다 (CSS 참고).
 *
 * 표는 **키 액션 이름**만 들고 있다 — 실제 라벨은 그릴 때 `keyLabel(Keys[action])` 로 만든다
 * (`docs/CONTROLS.md`: 키는 사용 시점에 읽는다. 리바인드하면 `input:bindingsChanged` 에 다시 그린다).
 * ════════════════════════════════════════════════════════════════════════════ */

/** 조작 한 줄. `id` 는 저장에 남는 안정된 이름이라 문구를 고쳐도 중복되지 않는다. */
export interface ControlHint {
  id: string;
  /** 이 줄이 보여 주는 키 액션들 (`Keys` 의 필드 이름). 여러 개면 나란히 그린다. */
  keys: readonly (keyof KeyBindings)[];
  label: string;
  /** 꾹 누르는 키 — 키캡에 chevron 을 단다 (`.keycap.kc-hold`). */
  hold?: boolean;
}

/**
 * 그 단계에 **들어설 때** 가이드에 더해지는 줄. 없는 단계는 아무것도 더하지 않는다.
 * 한 번 더해진 줄은 트랙이 끝날 때까지 남는다 (`TutorialSave.learned`).
 */
export const TUTORIAL_CONTROL_HINTS: Readonly<Partial<Record<TutorialStepId, readonly ControlHint[]>>> = {
  move: [{ id: 'move', keys: ['FORWARD', 'LEFT', 'BACK', 'RIGHT'], label: '이동' }],
  sprintJump: [
    { id: 'sprint', keys: ['SPRINT'], label: '달리기' },
    { id: 'jump', keys: ['JUMP'], label: '점프' },
  ],
  corpseLoot: [
    { id: 'interact', keys: ['INTERACT'], label: '상호작용 · 루팅' },
    { id: 'bag', keys: ['INVENTORY'], label: '가방 · 장비' },
  ],
  shoot: [
    { id: 'fire', keys: ['FIRE'], label: '사격' },
    { id: 'aim', keys: ['AIM'], label: '정조준' },
    { id: 'reload', keys: ['RELOAD'], label: '재장전' },
  ],
  crouch: [{ id: 'crouch', keys: ['CROUCH'], label: '앉기' }],
  heal: [{ id: 'quick', keys: ['QUICK'], label: '빠른 사용 (회복)' }],
  grenade: [{ id: 'quickWheel', keys: ['QUICK'], label: '빠른 사용 휠 — 수류탄', hold: true }],
  extract: [{ id: 'map', keys: ['MAP'], label: '지도' }],
};

/** 우측 조작 가이드의 머리 라벨. */
export const CONTROLS_TITLE_KO = '배운 조작';

/* ════════════════════════════════════════════════════════════════════════════
 * 레이드 트랙의 진행 (2026-09-14)
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * 체크포인트(`tutorial:checkpoint`, owner: `world/tutorial`) → **그 자리에서 시작되는 단계**.
 * 체크포인트는 구간의 **입구**라, 지나는 순간 앞 구간의 단계는 끝난 것이다. 그래서 안내는 이 표 하나로
 * 어디까지 왔는지를 되찾는다 — 선택 단계(`grenade`)를 쓰지 않고 지나가도, 체크포인트 하나를 놓쳐도 막히지 않는다.
 * `TutorialCheckpointId` 를 그대로 쓰지 않고 문자열 키를 쓰는 이유는 하나다: 이 폴더는 월드의 계약을 **읽기만** 한다.
 */
export const CHECKPOINT_STEP: Readonly<Record<string, TutorialStepId>> = {
  wake: 'wake',
  cliff: 'sprintJump',
  corpse: 'corpseLoot',
  bugs: 'shoot',
  crawl: 'crouch',
  android: 'crouchAim',
  drop: 'drop',
  supply: 'heal',
  wall: 'grenade',
  ship: 'extract',
};

/** 전투 단계(`shoot` · `crouchAim`)에서 넘어가는 데 필요한 처치 수 — 그 구간에 세워 둔 적 수와 같다. */
export const RAID_KILLS_PER_STEP = 2;

/* ════════════════════════════════════════════════════════════════════════════
 * HUD 점진 노출 (2026-09-14) — `hides('hud', part)`.
 *
 * **레이드 트랙 안에서만 산다.** 함선 트랙 · 증축 트랙에서는 평소 화면 그대로다 (그래서 판정이 트랙을 먼저 본다).
 * ════════════════════════════════════════════════════════════════════════════ */

/** `hides('hud', …)` 가 참고하는 **관찰 상태** — 표 하나로 못 정하는 것만. */
export interface HudRevealState {
  /** 스태미나가 한 번이라도 줄었다 (달리기 · 점프). */
  staminaUsed: boolean;
}

/** 체력 · 실드 · 무기 패널이 나타나는 단계 — 시체에서 장비를 얻는 그 단계를 **지나면** 보인다. */
export const HUD_GEAR_STEP: TutorialStepId = 'corpseLoot';
/** 스태미나 바는 늦어도 이 단계를 지나면 보인다 (그전에 실제로 소모했으면 그때 바로). */
export const HUD_STAMINA_STEP: TutorialStepId = 'sprintJump';
