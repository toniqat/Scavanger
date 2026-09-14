import type { KeyBindings, Stance, TutorialGate, TutorialStepId, TutorialTrack } from '@/shared';

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

/* ── 목표 마커 (2026-09-14 3차) — 「저 시체다」를 3D 로 짚는다 ──────────────
 * 세로선 + 아래를 가리키는 chevron 하나. 절차 지오메트리이고 **광원을 만들지 않는다**
 * (`CLAUDE.md`: 씬의 광원 개수를 플레이 중에 바꾸지 않는다 — 여기는 emissive 없는 basic 재질이다).
 * ────────────────────────────────────────────────────────────────────────── */

/** 마커 색 — UI 강조색(`--c-accent` #ffb347)과 같은 주황. */
export const MARKER_COLOR = 0xffb347;
/** 세로선의 아래 끝 · 위 끝 높이 (대상 발치 기준, m) 와 폭. */
export const MARKER_BASE_Y = 0.45;
export const MARKER_TOP_Y = 3.2;
export const MARKER_WIDTH = 0.07;
/** chevron 한 날개의 길이 · 두께 · 벌어진 각(rad) — 아래를 가리킨다. */
export const MARKER_CHEVRON_LEN = 0.52;
export const MARKER_CHEVRON_W = 0.1;
export const MARKER_CHEVRON_ANGLE = 0.72;
/** 위아래로 천천히 오가는 폭 (m) 과 주기 (s). */
export const MARKER_BOB = 0.28;
export const MARKER_BOB_PERIOD = 2.6;
/** 마커가 대상을 다시 찾는 주기 (프레임) — 매 프레임 `ctx.interactables` 를 훑지 않는다. */
export const MARKER_RETARGET_FRAMES = 15;

/* ── 기상 연출과 첫 안내 사이 (2026-09-14 4차, 사용자 결정) ────────────────
 * 깨어나는 동안에는 목표 패널도 조작 가이드도 그리지 않는다 — 화면이 아직 검고 몸도 내 것이 아닌데
 * 「걸어가세요」가 먼저 떠 있으면 연출이 아니라 안내를 읽게 된다. 연출이 끝나도 곧바로 띄우지 않고
 * **한 박자** 둔다: 그 사이에 스스로 움직여 본 사람에게는 그 순간 바로 띄운다 (기다릴 이유가 없다).
 * 연출 수치라 csv 가 아니라 여기 있다 (`MARKER_*` · `GUIDE_*` 와 같은 자리).
 * ────────────────────────────────────────────────────────────────────────── */

/** 기상 연출이 끝난 뒤 목표 패널 · 조작 가이드가 나타나기까지 (s). */
export const WAKE_REVEAL_DELAY_S = 2.0;
/** 그 유예를 앞당기는 이동 거리 (m) — 이만큼 움직이면 기다리지 않고 바로 띄운다. */
export const WAKE_REVEAL_MOVE_M = 1.0;

/* ════════════════════════════════════════════════════════════════════════════
 * 목표 줄 (2026-09-14 2차, 사용자 결정)
 *
 * 목표 패널은 이제 **제목 + 부제 두 줄**이 아니라 **체크박스가 달린 목표 줄 목록**이다. 한 단계가 목표를
 * 여럿 가질 수 있고, 그 중 일부는 **선택**이라 안 해도 다음 단계로 넘어간다 (라벨 앞에 `(선택)`).
 * 달성하면 체크가 좌→우로 그려지고 라벨에 취소선이 좌→우로 그어진다 (`tutorial.css`).
 * ════════════════════════════════════════════════════════════════════════════ */

/** 목표 한 줄. `id` 는 달성 표시(`TutorialSystem.markObjective`)와 저장에 남는 이름이다. */
export interface TutorialObjective {
  id: string;
  text: string;
  /** 안 해도 다음 단계로 넘어간다 — 라벨 앞에 `(선택)` 이 붙고, **실제로 달성했을 때만** 체크된다. */
  optional?: boolean;
  /**
   * **순차 공개** (2026-09-14 3차, 사용자 결정) — **앞 줄을 달성해야 보인다**. 할 일이 셋이나 되는 단계에서
   * 셋을 한꺼번에 늘어놓으면 「지금 무엇을 하는가」가 묻힌다. 패널은 아직 열리지 않은 줄을 **그리지 않는다**
   * (`visibleObjectives`). 달성 표시(`markObjective`)와 저장은 예전 그대로다.
   */
  reveal?: true;
  /**
   * 앞 줄이 아니라 **바깥 사건**이 여는 줄 — 이 id 가 달성 표시돼야 보인다. `reveal` 이 쓸 앞 줄이 없는
   * 첫 줄에 쓴다 (`heal` 의 「붕대가 빠른 사용 칸에 올라갔다」). 목록에 없는 id 여도 된다 — `done` 은
   * 목표 목록과 무관하게 달성 표시를 기억한다.
   */
  revealOn?: string;
}

/** 선택 목표의 라벨 접두사. */
export const OPTIONAL_PREFIX_KO = '(선택) ';

/**
 * 그 단계의 목표 줄. `objectives` 를 안 적은 단계는 **부제 한 줄**이 곧 유일한 필수 목표다
 * (예전의 `제목 + 부제` 두 줄 중 부제가 그대로 목표 문장이었다).
 */
export const objectivesOf = (def: StepDef): readonly TutorialObjective[] =>
  def.objectives ?? [{ id: def.id, text: def.hint }];

/**
 * **지금 그릴 목표 줄** (2026-09-14 3차) — 순차 공개를 푼 결과다. 한 줄이 아직 안 열렸으면 **그 뒤는 전부**
 * 닫혀 있다 (목록은 순서가 곧 차례다). 순수 함수라 패널도 시스템도 같은 답을 본다.
 */
export function visibleObjectives(
  list: readonly TutorialObjective[], done: ReadonlySet<string>,
): readonly TutorialObjective[] {
  const out: TutorialObjective[] = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.revealOn && !done.has(o.revealOn)) break;
    if (o.reveal) {
      const prev = list[i - 1];
      if (!prev || !done.has(prev.id)) break;
    }
    out.push(o);
  }
  return out;
}

/**
 * `id` 와 **그 앞의 순차 공개 사슬 전부**. 뒤 줄을 먼저 해낸 사람(휠을 안 열고 탭으로 꺼낸 사람)의 앞 줄이
 * 영영 안 켜져 그 뒤가 통째로 숨는 길을 막는다 — 사슬은 `reveal` 이 이어진 만큼만 거슬러 올라간다.
 */
export function objectiveChain(list: readonly TutorialObjective[], id: string): readonly string[] {
  const at = list.findIndex((o) => o.id === id);
  if (at < 0) return [id];
  const out = [id];
  for (let i = at; i > 0 && list[i].reveal; i--) out.unshift(list[i - 1].id);
  return out;
}

/*
 * 2026-09-14 4차 (사용자 결정) — `grenade` 의 선택 목표는 「처치」가 아니라 **「꺼내 던진다」**가 됐다.
 * 던진 것이 빗나갔다고 해서 배운 것이 없어지지는 않는다. 그래서 터진 시각을 적어 두고 그 창 안의
 * 비총기 처치를 세던 `GRENADE_KILL_WINDOW_S` 는 없어졌다 — 판정이 `grenade:exploded` 한 줄이다.
 */

/** 한 단계의 정의. 진행 조건은 `TutorialSystem` 의 이벤트 스위치가 갖는다 — 여기는 표시와 게이트뿐이다. */
export interface StepDef {
  id: TutorialStepId;
  /** 단계 이름 (콘솔 · 게이트 사유 문구 `blockedBy`). **목표 패널은 2026-09-14 2차부터 이것을 그리지 않는다.** */
  title: string;
  /** `objectives` 가 없는 단계의 **유일한 필수 목표 문장**. */
  hint: string;
  /**
   * 목표 줄 (2026-09-14 2차). 생략하면 `[{ id, text: hint }]` 하나다.
   * 필수 목표는 **단계가 넘어가는 순간** 전부 달성으로 표시되고, 선택 목표는 실제로 달성했을 때만 체크된다.
   */
  objectives?: readonly TutorialObjective[];
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
  /**
   * **딤 없는 포커싱** (2026-09-14 2차, 사용자 결정 — `corpseLoot`). 구멍 · 링 · 말풍선은 그대로지만 네 판이
   * 투명해지고 **클릭도 통과시킨다**. 어두운 판이 없는데 클릭만 막히면 "왜 안 눌리지"가 되기 때문이다.
   */
  spotNoDim?: boolean;
  /** 스포트라이트 말풍선 문구 (없으면 `hint`). */
  spotText?: string;
  /** 걸어서 가야 하는 목표 — 안내선이 가리킬 `Interactable.id` (`bench` 는 런타임에 정해진다). */
  guide?: 'bench' | 'terminal' | 'pod';
  /**
   * **「…으로 이동」 목표 줄의 id** (2026-09-14 3차). `guide` 가 가리키는 그 물건의 상호작용 범위 안에 들어서면
   * 달성으로 적는다 — 좌표를 여기 적지 않으려고 `ctx.interactables` 가 준 자리와 반지름만 본다.
   */
  arriveObjective?: string;
}

/* ── 단계가 상황에 따라 갈아 끼우는 스포트라이트 (2026-09-14 3차) ──────────
 * `Spotlight.set` 은 선택자 배열을 **참조로** 비교해 「대상이 바뀌었다」를 판단한다 (바뀌면 지금 켜진 것을 접고
 * 반 박자를 다시 센다). 그래서 갈아 끼우는 목록은 **모듈 상수로 한 번만** 만든다 — 부를 때마다 새 배열을
 * 넘기면 `refreshVisuals` 가 돌 때마다 포커싱이 꺼져 영영 안 켜진다.
 * ────────────────────────────────────────────────────────────────────────── */

/** `equipGun` 인데 제작 창이 열려 있다 — 장비 칸이 숨었으므로 먼저 닫기 버튼을 밝힌다. */
export const SPOT_CRAFT_CLOSE: readonly string[] = ['.inv-craft-close', '.inv-panel-craft'];
/*
 * 2026-09-14 4차 — `SPOT_HEAL_STOCK`(시체 격자 + 빠른 사용 로제트)은 없어졌다. 붕대 · 수류탄은 주우면 빈 휠
 * 칸에 **자동 등록**되므로 「빠른 사용 칸에 올린다」는 할 일 자체가 사라졌고, 남은 일(휠에서 골라 손에 들고
 * 길게 눌러 쓰기)은 화면이 아니라 손가락이라 밝힐 UI 가 없다 — 조작 가이드가 살아 있는 키를 그린다.
 */
/** 밝힐 것이 없다 (화면이 아니라 손가락으로 하는 일). */
export const SPOT_NONE: readonly string[] = [];

/** 게이트가 막혔을 때 쓰는 기본 문구 — 단계 제목을 끼워 넣는다. */
export const blockedBy = (title: string): string => `튜토리얼 진행 중 — 먼저 '${title}'`;

/* ════════════════════════════════════════════════════════════════════════════
 * 우측 조작 가이드 (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」)
 *
 * 배운 조작이 **한 줄씩 쌓이고 사라지지 않는다.** 우하단 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)는 "지금 열린
 * 화면의 키"라 매번 바뀌지만 이쪽은 누적이라 자리가 아예 다르다 — 화면 **우측 세로 가운데**다 (CSS 참고).
 *
 * 표는 **키 액션 이름**만 들고 있다 — 실제 라벨은 그릴 때 `keyLabel(Keys[action])` 로 만든다
 * (`docs/CONTROLS.md`: 키는 사용 시점에 읽는다. 리바인드하면 `input:bindingsChanged` 에 다시 그린다).
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * 조작 **구간** (2026-09-14 2차, 사용자 결정). 줄은 배운 순서가 아니라 이 구간 순서로 쌓이고, 구간과 구간
 * 사이에만 얇은 구분선이 들어간다. 비어 있는 구간은 아예 그려지지 않으므로 구분선도 생기지 않는다.
 */
export type ControlSection = 'move' | 'screen' | 'combat' | 'gear';

/** 구간이 그려지는 순서. */
export const CONTROL_SECTIONS: readonly ControlSection[] = ['move', 'screen', 'combat', 'gear'];

/** 한 줄 안의 **쌍** — 키캡 묶음 하나 + 그 라벨 하나 (`LMB 사격 / RMB 정조준`). */
export interface ControlHintPair {
  /** 이 쌍이 보여 주는 키 액션들 (`Keys` 의 필드 이름). 여러 개면 나란히 그린다. */
  keys: readonly (keyof KeyBindings)[];
  label: string;
  /** 꾹 누르는 키 — 키캡에 chevron 을 단다 (`.keycap.kc-hold`). */
  hold?: boolean;
}

/**
 * 조작 한 줄. `id` 는 저장에 남는 안정된 이름이라 문구를 고쳐도 중복되지 않는다.
 *
 * `keys` · `label` · `hold` 는 **첫 쌍**이고 (2026-09-14 의 모양 그대로 — 깨지 않았다), `more` 는 같은 줄에
 * 이어 붙는 쌍들이다 (`LMB 사격 / RMB 정조준` 을 한 줄에 담으려고 2026-09-14 2차에 더했다).
 */
export interface ControlHint extends ControlHintPair {
  id: string;
  /** 같은 줄의 나머지 쌍 (2026-09-14 2차). 앞에 얇은 구분자를 두고 이어 그린다. */
  more?: readonly ControlHintPair[];
  /** 이 줄이 속한 구간 (생략 = `gear`). */
  section?: ControlSection;
}

/** 한 줄이 가진 쌍 전부 (첫 쌍 + `more`). */
export const hintPairs = (h: ControlHint): readonly ControlHintPair[] =>
  [{ keys: h.keys, label: h.label, hold: h.hold }, ...(h.more ?? [])];

/**
 * 이동 · 달리기 · 점프 — `move` 와 「앞으로 이동」 구간 셋이 **같은 배열을 공유한다** (2026-09-14 4차).
 * 줄 목록이 참조까지 같으면 `applyControls` 의 id 비교가 그대로 통과해 DOM 을 한 번도 안 건드린다.
 */
const MOVE_HINTS: readonly ControlHint[] = [
  { id: 'move', keys: ['FORWARD', 'LEFT', 'BACK', 'RIGHT'], label: '이동', section: 'move' },
  { id: 'sprint', keys: ['SPRINT'], label: '달리기', hold: true, section: 'move' },
  { id: 'jump', keys: ['JUMP'], label: '점프', section: 'move' },
];

/**
 * **그 단계에 보일 줄 전부** (2026-09-14 3차, 사용자 결정 — 「누적」에서 「교체」로).
 *
 * 예전에는 배운 줄이 한 줄씩 쌓이고 트랙이 끝날 때까지 사라지지 않았다. 레이드 끝에 가면 여덟 줄이
 * 우측을 채우는데 그 중 **지금 쓰는 것은 한둘**이라, 정작 배우는 중인 키가 목록에 파묻혔다.
 * 이제 표는 「그 단계에서 화면에 **있어야** 하는 줄」이고, 단계가 바뀌면 그 줄로 **갈아 끼운다**.
 *
 * ⚠ **표에 없는 단계는 직전 단계의 줄을 그대로 유지한다** (`wake` · `sprintJump` · `crouchAim` · `drop` 처럼
 * 새로 배우는 키가 없는 단계). 빈 배열을 적으면 「조작 가이드를 비운다」는 다른 뜻이 된다.
 *
 * `crouch` 단계는 **자세에 따라 라벨이 바뀌므로** 표가 아니라 `crouchHints(stance)` 가 만든다 — 여기 있는
 * 것은 선 자세(기본)의 모습이고, 저장에서 되살릴 때 id 를 찾는 데도 쓰인다.
 */
export const TUTORIAL_CONTROL_HINTS: Readonly<Partial<Record<TutorialStepId, readonly ControlHint[]>>> = {
  // 기상 직후 이동 · 달리기 · 점프를 **한꺼번에** (2026-09-14 3차, 사용자 결정)
  move: MOVE_HINTS,
  // 「앞으로 이동」 구간 셋 (2026-09-14 4차) — 배우는 키가 이동뿐이라 `move` 와 같은 세 줄로 되돌아온다.
  //   직전 단계(루팅 · 사격 · 정조준)의 줄을 그대로 두면 걸어가는 동안 쓰지도 않는 키가 우측을 채운다.
  advance1: MOVE_HINTS,
  advance2: MOVE_HINTS,
  advance3: MOVE_HINTS,
  corpseLoot: [
    { id: 'interact', keys: ['INTERACT'], label: '상호작용 · 루팅', hold: true, section: 'screen' },
    { id: 'bag', keys: ['INVENTORY'], label: '가방 · 장비', section: 'screen' },
  ],
  shoot: [
    // 한 줄에 쌍 둘 — 사격과 정조준은 같은 손의 같은 동작이라 따로 읽을 이유가 없다 (2026-09-14 2차)
    { id: 'fire', keys: ['FIRE'], label: '사격', section: 'combat', more: [{ keys: ['AIM'], label: '정조준' }] },
    { id: 'reload', keys: ['RELOAD'], label: '재장전', section: 'combat' },
  ],
  crouch: crouchHints('stand'),
  heal: [
    { id: 'quick', keys: ['QUICK'], label: '빠른 사용 꺼내기', section: 'gear', more: [{ keys: ['QUICK'], label: '휠 열기', hold: true }] },
    { id: 'quickUse', keys: ['FIRE'], label: '길게 눌러 사용', hold: true, section: 'gear' },
  ],
  grenade: [
    { id: 'quick', keys: ['QUICK'], label: '빠른 사용 꺼내기', section: 'gear', more: [{ keys: ['QUICK'], label: '휠 열기', hold: true }] },
    { id: 'throw', keys: ['FIRE'], label: '던지기', hold: true, section: 'combat' },
  ],
  extract: [{ id: 'map', keys: ['MAP'], label: '지도', section: 'screen' }],
};

/**
 * `crouch` 단계의 두 줄 — **라벨이 지금 자세를 따라간다** (2026-09-14 3차, 사용자 결정).
 * 같은 키가 「앉기」였다가 「일어서기」가 되므로, 서 있는 사람에게 「일어서기」라고 적지 않는다.
 * 키 글자는 여전히 그릴 때 `Keys` 에서 읽는다 (`ui/Controls`) — 여기 있는 것은 문구뿐이다.
 */
export function crouchHints(stance: Stance): readonly ControlHint[] {
  return [
    { id: 'crouch', keys: ['CROUCH'], label: stance === 'crouch' ? '일어서기' : '앉기', section: 'move' },
    { id: 'prone', keys: ['PRONE'], label: stance === 'prone' ? '일어서기' : '포복', section: 'move' },
  ];
}

/** 그 단계에 보일 줄 (자세를 타는 단계는 여기서 갈린다). `undefined` = **직전 줄 유지**. */
export function controlHintsFor(step: TutorialStepId, stance: Stance): readonly ControlHint[] | undefined {
  if (step === 'crouch') return crouchHints(stance);
  return TUTORIAL_CONTROL_HINTS[step];
}

/** 우측 조작 가이드의 머리 라벨 — 2026-09-14 3차부터 **누적이 아니라 지금 구간의 조작**이라 `배운 조작` 이 아니다. */
export const CONTROLS_TITLE_KO = '조작';

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
  /*
   * 2026-09-14 4차 (사용자 결정: 「걸어가다 **벌레가 솟으면** 그때 시작」) — `bugs` 는 `shoot` 이 아니라
   * **`advance1`** 로 접는다. 이 체크포인트는 z 60 이고 벌레(−2.5, 34)·(2.5, 28) 는 감지 12 m 라
   * 첫 마리가 솟는 자리는 z ≈ 45.7 — 체크포인트로 `shoot` 을 열면 「벌레를 처치하세요」를 띄운 채 14 m 를
   * 더 걸어야 한다. 체크포인트 자리는 못 옮긴다(부활 자리는 감지 반경 **밖**이어야 한다는 월드 규약).
   * 그래서 자리는 그대로 두고 뜻만 「앞으로 이동 구간의 입구」로 바꾸고, `shoot` 은 실제 스폰이 연다
   * (`TutorialSystem` 의 `enemy:spawned` 구독). 지날 때 이미 `advance1` 이면 `foldRaid` 가 조용히 지나간다.
   */
  bugs: 'advance1',
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
