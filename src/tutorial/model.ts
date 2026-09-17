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
/**
 * 만든 소총의 **무기 계열** (`WeaponDef.family ?? id`, 등급 무관 — `ar` · `ar_g3` …). 2026-09-17 (사용자 결정): 장착 단계
 * (`equipGun`)에 들어서는 순간 이 계열 · 계열 AR 무기가 이미 주무기 칸에 있으면 그 단계는 할 일이 없다 (`TutorialSystem.equipGunMoot`).
 */
export const TUTORIAL_GUN_FAMILY = 'ar';
// (2026-09-15) `TUTORIAL_RAVEN_NPC` 는 없어졌다 — `ravenQuest` 단계가 순서에서 빠지면서 이 폴더는 NPC 를 하나도 모른다.
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
/**
 * 목표 마커가 서는 단계 — **첫 시체 구간 둘**이다 (2026-09-15 2차: 「열어라」(`corpseOpen`)와 「챙겨라」(`corpseLoot`)가
 * 갈렸지만 가리키는 것은 같은 시체 하나라, 열라고 할 때부터 마커가 서 있어야 한다).
 */
export const CORPSE_MARKER_STEPS: readonly TutorialStepId[] = ['corpseOpen', 'corpseLoot'];

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

/**
 * 목표 한 줄. `id` 는 달성 표시(`TutorialSystem.markObjective`)와 저장에 남는 이름이다.
 *
 * 2026-09-15 (사용자 결정) — **문장이 아니라 짧은 명사구**다 (`길게 눌러 붕대 사용` · `벌레 2마리 처치`).
 * 키를 말하는 줄은 **키캡 토큰**을 쓴다 (`shared/keycap.renderKeyText` — `{QUICK:hold}` · `{FIRE}` · `{br}`).
 * 토큰은 그릴 때 `Keys` 에서 풀리고 리바인드하면 `ui/Panel.relabel` 이 다시 그리므로, 2026-09-14 까지의
 * 「문구에 키 글자를 적지 않는다」(리바인드하면 거짓말이 된다)는 더 이상 걸림돌이 아니다 — 글자를 적지 말고 토큰을 적는다.
 */
export interface TutorialObjective {
  id: string;
  /** 명사구 + 키캡 토큰 (`{ACTION}` · `{ACTION:hold}` · `{br}`). */
  text: string;
  /** 안 해도 다음 단계로 넘어간다 — 라벨 앞에 `(선택)` 이 붙고, **실제로 달성했을 때만** 체크된다. */
  optional?: boolean;
  /**
   * **세어야 하는 목표의 목표 수** (2026-09-15 2차, 사용자 결정). 있으면 패널이 문구 뒤에 ` (현재/목표)` 를 붙이고
   * 진행이 바뀔 때마다 **그 숫자 노드만** 갈아 끼운다 (`ui/Panel.setCounts` — 줄을 다시 지으면 체크 · 취소선
   * 애니메이션이 처음부터 다시 돈다). 그래서 **문구에는 수를 적지 않는다**: `벌레 처치` + `count: 2` → `벌레 처치 (0/2)`.
   * 진행 수의 원본은 `TutorialSystem` 이고(지금은 처치 수 `kills` 하나), 목표 수는 그 단계가 세는 상수에서 유도한다.
   */
  count?: number;
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
  /**
   * 세는 목표의 **단위** (2026-09-17) — 있으면 꼬리표가 ` (n / m 단위)` 이고 수에 천 단위 쉼표가 붙는다 (`(420 / 1,000 C)`).
   * 없으면 예전 그대로 ` (n/m)`.
   */
  countUnit?: string;

  /* ── 목표별 표시 · 허용 (2026-09-17, 사용자 결정 — 증축 안내의 「한 단계 = 목표 여럿」) ─────────────────────────────
   * 단계 여럿을 한 단계로 묶으면서, 전에는 단계가 들고 있던 것들이 **지금 할 목표**를 따라가야 한다. 지금 할 목표 =
   * 보이는 줄 중 **아직 안 한 첫 필수 줄** (`currentObjective`). 그 줄에 적힌 것이 단계의 값보다 앞선다 — 안 적힌 필드는
   * 단계의 값을 그대로 쓴다. */
  /** 이 줄이 지금 할 목표일 때의 스포트라이트 선택자 (`[]` = 밝히지 않는다). */
  spot?: readonly string[];
  spotText?: string;
  spotUnion?: boolean;
  spotNoDim?: boolean;
  /** 이 줄이 지금 할 목표일 때의 바닥 안내선 대상. `null` = 안내선 없음. */
  guide?: 'bench' | 'terminal' | 'pod' | null;
  /** 「…으로 이동」 줄 — 그 안내선 대상의 상호작용 범위에 들어서면 달성 (`StepDef.arriveObjective` 의 목표판). */
  arrive?: true;
  /**
   * 이 줄이 **보이는 순간부터** 더 여는 게이트 (단계의 `allow` 위에 합친다). 한 단계 안에서도 순서를 지키게 한다 —
   * 「발사 슬롯 탑승」 줄이 열리기 전에는 포드에 탈 수 없다.
   */
  allow?: Partial<Record<TutorialGate, true | readonly string[]>>;
}

/**
 * **지금 할 목표** (2026-09-17) — 보이는 줄 중 아직 안 한 첫 필수 줄. 전부 했으면 null.
 * 선택 줄은 건너뛴다 (안 해도 넘어가는 줄이 포커스를 붙들면 안 된다).
 */
export function currentObjective(
  list: readonly TutorialObjective[], done: ReadonlySet<string>,
): TutorialObjective | null {
  for (const o of visibleObjectives(list, done)) if (!o.optional && !done.has(o.id)) return o;
  return null;
}

/**
 * 보이는 줄들이 더 여는 게이트를 단계의 `allow` 위에 합친다 (2026-09-17). 줄이 하나도 더 열지 않으면 단계의 것을 그대로 돌려준다.
 * 배열끼리는 합집합, 한쪽이 `true` 면 `true`.
 */
export function mergedAllow(
  base: StepDef['allow'], list: readonly TutorialObjective[], done: ReadonlySet<string>,
): StepDef['allow'] {
  let out: Partial<Record<TutorialGate, true | readonly string[]>> | null = null;
  for (const o of visibleObjectives(list, done)) {
    if (!o.allow) continue;
    out ??= { ...(base ?? {}) };
    for (const [g, v] of Object.entries(o.allow) as [TutorialGate, true | readonly string[]][]) {
      const have = out[g];
      out[g] = have === true || v === true ? true : [...(have ?? []), ...v];
    }
  }
  return out ?? base;
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

/*
 * 함선 트랙 `stats` 의 목표별 포커싱 (2026-09-16 2차, 사용자 결정) — 목표가 하나씩 열리는 대로 **포커스가 옮겨 간다**.
 * 고르는 곳은 `TutorialSystem.stepView` 다. 메뉴가 닫혀 있는 첫 목표(`statsMenu`)는 밝힐 화면이 없어 `SPOT_NONE` 이고,
 * 그 안내는 우측 조작 가이드의 한 줄(`TUTORIAL_CONTROL_HINTS.stats`)이 한다.
 * ⚠ 탭 버튼에는 탭마다의 표식이 없다 — `SCREEN_TABS`(inventory/ui/model) 의 두 번째가 캐릭터 탭이라 `:nth-child(2)` 로 집고,
 *   못 찾으면 탭 줄 전체로 넓힌다. (함선 트랙에서 보이는 탭은 인벤토리 · 캐릭터 둘뿐이다.)
 */
/** ② 캐릭터 탭으로 이동. */
export const SPOT_STATS_TAB: readonly string[] = ['.inv-root .scr-tabs .scr-tab:nth-child(2)', '.inv-root .scr-tabs'];
export const STATS_TAB_TEXT = '캐릭터 탭으로 이동';
/** ③ 능력치 하나 ＋ — 능력치 열 전체 (＋ 줄이 전부 그 안에 있다). */
export const SPOT_STATS_RAISE: readonly string[] = ['.cs-col', '.inv-root .scr-tabs'];
/** `{+}` 는 스포트라이트 말풍선이 능력치 시트의 ＋ 버튼 모양으로 그린다 (`parts/Spotlight.renderSpotText`). */
export const STATS_RAISE_TEXT = '원하는 능력치 하나 {+} 를 눌러 상승';
/** ④ 투자 확정 — `되돌리기 · 포인트 투자 확정` 줄. */
export const SPOT_STATS_CONFIRM: readonly string[] = ['.pg-alloc .pg-confirm', '.pg-alloc', '.cs-col'];
export const STATS_CONFIRM_TEXT = '버튼을 길게 눌러 확정';

/** 게이트가 막혔을 때 쓰는 기본 문구 — 단계 제목을 끼워 넣는다. */
export const blockedBy = (title: string): string => `튜토리얼 진행 중 — 먼저 '${title}'`;

/* ════════════════════════════════════════════════════════════════════════════
 * 우측 조작 가이드 (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」)
 *
 * 배운 조작이 **한 줄씩 쌓이고 사라지지 않는다.** 우하단 키 가이드(`ui/hud/KeyGuide`, `.key-guide`)는 "지금 열린
 * 화면의 키"라 매번 바뀌지만 이쪽은 누적이라 자리가 아예 다르다 — 화면 **우측 세로 가운데**다 (CSS 참고).
 *
 * 표는 **키 액션 이름**(과 2026-09-15 부터 키캡 토큰 `{ACTION}`)만 들고 있다 — 키캡은 그릴 때 `shared/keycap.paintKeycap(Keys[action])` 으로 칠한다
 * (`docs/CONTROLS.md`: 키는 사용 시점에 읽는다. 리바인드하면 `input:bindingsChanged` 에 다시 그린다).
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * 조작 **구간** (2026-09-14 2차, 사용자 결정). 줄은 배운 순서가 아니라 이 구간 순서로 쌓이고, 구간과 구간
 * 사이에만 얇은 구분선이 들어간다. 비어 있는 구간은 아예 그려지지 않으므로 구분선도 생기지 않는다.
 */
/* 2026-09-17: `meta` — 조작 가이드 자신을 다루는 줄(`] 조작 가이드 숨김`)이 맨 아래 구분선 밑에 선다. */
export type ControlSection = 'move' | 'stance' | 'screen' | 'combat' | 'gear' | 'meta';

/**
 * 구간이 그려지는 순서. 2026-09-16 (사용자 결정): `stance`(앉기 · 포복)가 `move` 에서 갈라졌다 — 포복 구간의 패널은
 * `WASD 이동` ─ 구분선 ─ `C 앉기 · Z 포복` ─ 구분선 ─ `발사 · 정조준` 세 묶음이다.
 */
export const CONTROL_SECTIONS: readonly ControlSection[] = ['move', 'stance', 'screen', 'combat', 'gear', 'meta'];

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
 *
 * **2026-09-15 (사용자 결정) — 토큰 문장 줄 `text`.** 「키 쌍」 모양으로 담기지 않는 조작이 있다
 * (`{QUICK:hold}를 꾹 눌러 수류탄 장착 후,{br}{FIRE:hold} 수류탄 던지기`). `text` 가 있으면 그 줄은 쌍을 그리지 않고
 * `shared/keycap.renderKeyText` 로 문장 안에 키캡을 끼워 그린다 (`keys` · `label` · `more` 는 무시).
 */
export interface ControlHint {
  id: string;
  /** 첫 쌍의 키 액션들 (`text` 줄이면 생략). */
  keys?: readonly (keyof KeyBindings)[];
  /** 첫 쌍의 라벨 (`text` 줄이면 생략). */
  label?: string;
  /** 첫 쌍이 꾹 누르는 키. */
  hold?: boolean;
  /** 같은 줄의 나머지 쌍 (2026-09-14 2차). 앞에 얇은 구분자를 두고 이어 그린다. */
  more?: readonly ControlHintPair[];
  /** 토큰 문장 줄 (2026-09-15) — `{ACTION}` · `{ACTION:hold}` · `{br}`. 있으면 쌍 대신 이것을 그린다. */
  text?: string;
  /** 이 줄이 속한 구간 (생략 = `gear`). */
  section?: ControlSection;
}

/** 한 줄이 가진 쌍 전부 (첫 쌍 + `more`). 토큰 문장 줄(`text`)은 쌍이 없다. */
export const hintPairs = (h: ControlHint): readonly ControlHintPair[] =>
  h.text !== undefined ? [] : [{ keys: h.keys ?? [], label: h.label ?? '', hold: h.hold }, ...(h.more ?? [])];

/**
 * 이동 · 달리기 · 점프 — `move` 와 「앞으로 이동」 구간 셋이 **같은 배열을 공유한다** (2026-09-14 4차).
 * (`ControlHint` 는 2026-09-15 에 `keys` · `label` 이 선택 필드가 됐다 — 토큰 문장 줄 `text` 가 대신할 수 있다.)
 * 줄 목록이 참조까지 같으면 `applyControls` 의 id 비교가 그대로 통과해 DOM 을 한 번도 안 건드린다.
 */
const MOVE_HINT: ControlHint = { id: 'move', keys: ['FORWARD', 'LEFT', 'BACK', 'RIGHT'], label: '이동', section: 'move' };
const SPRINT_HINT: ControlHint = { id: 'sprint', keys: ['SPRINT'], label: '달리기', hold: true, section: 'move' };
const MOVE_HINTS: readonly ControlHint[] = [
  MOVE_HINT,
  SPRINT_HINT,
  { id: 'jump', keys: ['JUMP'], label: '점프', section: 'move' },
];

/**
 * **그 단계에 보일 줄 전부** (2026-09-14 3차, 사용자 결정 — 「누적」에서 「교체」로).
 *
 * 예전에는 배운 줄이 한 줄씩 쌓이고 트랙이 끝날 때까지 사라지지 않았다. 레이드 끝에 가면 여덟 줄이
 * 우측을 채우는데 그 중 **지금 쓰는 것은 한둘**이라, 정작 배우는 중인 키가 목록에 파묻혔다.
 * 이제 표는 「그 단계에서 화면에 **있어야** 하는 줄」이고, 단계가 바뀌면 그 줄로 **갈아 끼운다**.
 *
 * ⚠ **표에 없는 단계는 직전 단계의 줄을 그대로 유지한다** (`wake` · `sprintJump` · `drop` 처럼
 * 새로 배우는 키가 없는 단계). 빈 배열을 적으면 「조작 가이드를 비운다」는 다른 뜻이 된다.
 *
 * `crouch` · `crouchAim` 단계는 **자세에 따라 라벨이 바뀌므로** 표가 아니라 `controlHintsFor(step, stance)` 가 만든다 —
 * 여기 있는 것은 선 자세(기본)의 모습이고, 저장에서 되살릴 때 id 를 찾는 데 쓰인다 (2026-09-15: `crouchAim` 이 표에 들어왔다).
 */
/**
 * 루팅 두 줄 — 첫 시체(`corpseLoot`)와 보급품 시체(`supplyLoot`, 2026-09-15)가 **같은 배열**을 쓴다
 * (`MOVE_HINTS` 와 같은 이유: 참조가 같으면 `applyControls` 의 id 비교가 DOM 을 안 건드린다).
 */
const BAG_HINT: ControlHint = { id: 'bag', keys: ['INVENTORY'], label: '가방 · 장비', section: 'screen' };

const LOOT_HINTS: readonly ControlHint[] = [
  { id: 'interact', keys: ['INTERACT'], label: '상호작용 · 루팅', hold: true, section: 'screen' },
  BAG_HINT,
];

/**
 * 장착 단계의 한 줄 (2026-09-16) — **작업대 창의 `닫기` 는 창째 닫는다** (`inventory/parts/Crafting.closeCraftWindow`,
 * 사용자 보고 「작업대 창을 닫았는데 가방이 열린다」). 그래서 `equipGun` 에 들어서는 순간 장비 칸도 가방도 화면에
 * 없고, 밝힐 DOM 이 없으니 스포트라이트도 뜨지 못한다 (`parts/Spotlight` 는 대상이 없으면 스스로 접힌다).
 * 남은 안내는 「창을 다시 열어라」 하나이고, 그것을 적는 자리는 우측 조작 가이드다 — 창이 열리면 가이드가
 * 스스로 접히므로(`TutorialSystem.setInventoryOpen`) 줄은 필요한 동안에만 떠 있다.
 */
const EQUIP_HINTS: readonly ControlHint[] = [BAG_HINT];

/*
 * 발사 · 정조준 두 줄 (2026-09-16, 사용자 결정) — 예전의 `LMB 사격 / RMB 정조준` 한 줄을 갈랐고 정조준은 **꾹 누르기** 키캡이다.
 * `shoot` · `advance2` · 포복 구간 뒤쪽(`crouch` · `crouchAim`)이 같은 두 객체를 쓴다. 이동 묶음과는 구간이 달라 구분선이 선다.
 */
const FIRE_HINT: ControlHint = { id: 'fire', keys: ['FIRE'], label: '발사', section: 'combat' };
const AIM_HINT: ControlHint = { id: 'aim', keys: ['AIM'], label: '정조준', hold: true, section: 'combat' };
/**
 * 재장전 줄 (2026-09-17, 사용자 결정 — 「벌레 둘 처치한 후, 발사 및 정조준 밑에 재장전」). `shoot` 에는 없고 벌레를 다 잡은 뒤
 * (`advance2`)부터 발사 · 정조준 바로 아래에 선다 — 포복 구간 뒤쪽(`crawlHalf`)의 발사 · 정조준 묶음에도 함께 붙는다.
 */
const RELOAD_HINT: ControlHint = { id: 'reload', keys: ['RELOAD'], label: '재장전', section: 'combat' };
/** 전투 구간의 이동 묶음 — `WASD 이동` · `Shift 달리기` (점프는 뺀다). */
const COMBAT_MOVE_HINTS: readonly ControlHint[] = [MOVE_HINT, SPRINT_HINT];
const SHOOT_HINTS: readonly ControlHint[] = [...COMBAT_MOVE_HINTS, FIRE_HINT, AIM_HINT];
/**
 * 벌레를 잡은 뒤 걸어가는 구간 (2026-09-16, 사용자 결정) — 발사 · 정조준을 그대로 두고 그 아래에 벌레 시체를 뒤져 보라는
 * `E 시체 상호작용` 한 줄을 붙인다 (같은 구간이라 구분선 없이 이어진다).
 */
const ADVANCE_AFTER_BUGS_HINTS: readonly ControlHint[] = [
  ...SHOOT_HINTS,
  RELOAD_HINT,
  // 2026-09-17:적 시체는 꾹 누르기다 (`enemies/Corpses` 의 `holdTime`) — 키캡에 chevron (`hold`)
  { id: 'bugCorpse', keys: ['INTERACT'], label: '시체 상호작용', hold: true, section: 'combat' },
];

/*
 * 빠른 사용 두 줄 (2026-09-15, 사용자 결정) — 예전에는 `T 빠른 사용 꺼내기 · T 휠 열기` 가 **한 줄에 쌍 둘**이었는데
 * 202 px 패널에서 쌍 중간이 접혀 키캡과 라벨이 서로 다른 줄로 흩어졌다. 그래서 두 줄로 가른다.
 */
const QUICK_HINT: ControlHint = { id: 'quick', keys: ['QUICK'], label: '빠른 사용 꺼내기', section: 'gear' };
const QUICK_WHEEL_HINT: ControlHint = { id: 'quickWheel', keys: ['QUICK'], label: '휠 열기', hold: true, section: 'gear' };
/** 손에 든 붕대를 쓰는 줄 — `heal` 에서 **붕대가 손에 있을 때만** 선다 (2026-09-16, `controlHintsFor`). */
const QUICK_USE_HINT: ControlHint = { id: 'quickUse', keys: ['FIRE'], label: '길게 눌러 사용', hold: true, section: 'gear' };

/**
 * 증축 안내 마지막 레이드의 조작 가이드 (2026-09-17, 사용자 결정) — `M 지도 / Q 전술 임플란트 / G (꾹) 함선 지원 / V 구르기 /
 * X 시점 변경` ─ 구분선 ─ `] 조작 가이드 숨김`. 이 레이드에서만 뜬다. `]` 로 접으면 같은 자리에 `] 조작 가이드 표시` 한 줄만 남는다
 * (`ui/Controls.setCollapsed`, 문구는 `CONTROLS_FOLDED_TEXT`). 키 글자는 그릴 때 `Keys` 에서 읽는다.
 */
const RAID_GUIDE_HINTS: readonly ControlHint[] = [
  { id: 'rgMap', keys: ['MAP'], label: '지도', section: 'gear' },
  { id: 'rgImplant', keys: ['IMPLANT'], label: '전술 임플란트', section: 'gear' },
  { id: 'rgShipCall', keys: ['SHIP_CALL'], label: '함선 지원', hold: true, section: 'gear' },
  { id: 'rgRoll', keys: ['DIVE'], label: '구르기', section: 'gear' },
  { id: 'rgCamera', keys: ['SHOULDER'], label: '시점 변경', section: 'gear' },
  { id: 'rgFold', keys: ['GUIDE_TOGGLE'], label: '조작 가이드 숨김', section: 'meta' },
];
/** 접힌 조작 가이드의 한 줄 (키캡 토큰) — 이 줄만 남는다. */
export const CONTROLS_FOLDED_TEXT = '{GUIDE_TOGGLE} 조작 가이드 표시';
/** 조작 가이드를 접을 수 있는 단계 (그 단계에서만 `Keys.GUIDE_TOGGLE` 을 읽는다). */
export const FOLDABLE_CONTROL_STEPS: readonly TutorialStepId[] = ['raid'];
/** 증축 안내 마지막 레이드에서 몸에 지닌 전리품 가치를 다시 세는 주기 (프레임) — 매 프레임 가방을 훑지 않는다. */
export const RAID_VALUE_POLL_FRAMES = 20;

export const TUTORIAL_CONTROL_HINTS: Readonly<Partial<Record<TutorialStepId, readonly ControlHint[]>>> = {
  // 기상 직후 이동 · 달리기 · 점프를 **한꺼번에** (2026-09-14 3차, 사용자 결정)
  move: MOVE_HINTS,
  // 「앞으로 이동」 구간 셋 (2026-09-14 4차) — 배우는 키가 이동뿐이라 `move` 와 같은 세 줄로 되돌아온다.
  //   직전 단계(루팅 · 사격 · 정조준)의 줄을 그대로 두면 걸어가는 동안 쓰지도 않는 키가 우측을 채운다.
  advance1: MOVE_HINTS,
  // 2026-09-16 (사용자 결정): 벌레를 잡은 뒤에는 발사 · 정조준이 남고 그 아래에 `E 시체 상호작용`
  advance2: ADVANCE_AFTER_BUGS_HINTS,
  advance3: MOVE_HINTS,
  // 2026-09-15 2차: 시체를 여는 단계와 뒤지는 단계가 **같은 배열**을 쓴다 (참조가 같으면 `applyControls` 의
  //   id 비교가 그대로 통과해 DOM 을 한 번도 안 건드린다 — 줄이 깜빡이지 않는다).
  corpseOpen: LOOT_HINTS,
  corpseLoot: LOOT_HINTS,
  // 2026-09-16 (사용자 결정): `WASD 이동 · Shift 달리기` ─ 구분선 ─ `좌클 발사 · 우클(꾹) 정조준` (재장전 줄은 뺐다)
  shoot: SHOOT_HINTS,
  // 아래 둘은 **선 자세 · 통로 뒤쪽의 모습**이다 — 실제로 그리는 줄은 `controlHintsFor` 가 지금 자세 · 통로 진행으로 만든다.
  //   표에 두는 이유는 저장에서 줄을 되살릴 때(`restoreControls`) id 를 찾는 것 하나다.
  crouch: [MOVE_HINT, ...crouchHints('stand'), FIRE_HINT, AIM_HINT, RELOAD_HINT],
  crouchAim: [MOVE_HINT, ...crouchHints('stand'), FIRE_HINT, AIM_HINT, RELOAD_HINT],
  // 증축 트랙에서 유일하게 줄이 있는 단계 — 작업대 창이 통째로 닫힌 뒤 「가방을 다시 열어라」 (위 `EQUIP_HINTS`)
  equipGun: EQUIP_HINTS,
  // 2026-09-17: 장착을 마치면 `Tab 가방 · 장비` 줄을 걷는다 (전에는 표에 없어 출격까지 남아 있었다)
  terminal: [],
  // 2026-09-17 (사용자 결정): 증축 안내의 마지막 **레이드** — 레이드에서 처음 쓰는 키 다섯 + 가이드 접기 (위 `RAID_GUIDE_HINTS`)
  raid: RAID_GUIDE_HINTS,
  supplyLoot: LOOT_HINTS,
  // 2026-09-16 (사용자 결정): `T 꾹 누르기 (휠 열기)` 가 맨 위. `길게 눌러 사용` 은 붕대가 손에 있을 때만 (`controlHintsFor`)
  heal: [QUICK_WHEEL_HINT, QUICK_HINT, QUICK_USE_HINT],
  grenade: [
    QUICK_HINT,
    QUICK_WHEEL_HINT,
    // 2026-09-15 (사용자 결정) — 수류탄의 쓰는 법은 「키 쌍」 한 칸에 안 담긴다: 토큰 문장 줄 (`ControlHint.text`)
    { id: 'grenadeThrow', text: '{QUICK:hold}를 꾹 눌러 수류탄 장착 후,{br}{FIRE:hold} 수류탄 던지기', section: 'combat' },
    // 핀 뽑기 = 좌클릭을 누른 채 R (`weapons/parts/Throwing` 이 `Keys.RELOAD` 를 읽는다)
    { id: 'grenadePin', text: '{FIRE:hold} 누른 상태에서 {RELOAD} : 핀 뽑기', section: 'combat' },
  ],
  extract: [{ id: 'map', keys: ['MAP'], label: '지도', section: 'screen' }],
  /*
   * 함선 트랙 (2026-09-16 2차, 사용자 결정) — 「메뉴를 열어 능력치를 투자하라」의 여는 키. 메뉴가 열리면 가이드가 스스로 접히므로
   * (`TutorialSystem.setInventoryOpen`) 창을 닫은 동안에만 떠 있다.
   * ⚠ ESC 는 적지 않는다: ESC 가 여는 것은 일시정지 메뉴이고 거기에는 캐릭터 탭으로 가는 길이 없다 (`ui/menus/PauseMenu`).
   */
  stats: [{ id: 'statsMenu', keys: ['INVENTORY'], label: '메뉴 열기', section: 'screen' }],
};

/**
 * 앉기 · 포복 두 줄 — **라벨이 지금 자세를 따라간다** (2026-09-14 3차, 사용자 결정).
 * 같은 키가 「앉기」였다가 「일어서기」가 되므로, 서 있는 사람에게 「일어서기」라고 적지 않는다.
 *   서 있음 → `C 앉기` · `Z 포복` / 앉음 → `C 일어서기` · `Z 포복` / 엎드림 → `C 앉기` · `Z 일어서기`.
 * 키 글자는 여전히 그릴 때 `Keys` 에서 읽는다 (`ui/Controls`) — 여기 있는 것은 문구뿐이다.
 */
export function crouchHints(stance: Stance): readonly ControlHint[] {
  return [
    { id: 'crouch', keys: ['CROUCH'], label: stance === 'crouch' ? '일어서기' : '앉기', section: 'stance' },
    { id: 'prone', keys: ['PRONE'], label: stance === 'prone' ? '일어서기' : '포복', section: 'stance' },
  ];
}

/** 표 하나로 못 정하는 조작 가이드 줄의 **관찰 상태** (2026-09-16) — `TutorialSystem` 이 채운다. */
export interface ControlHintState {
  /** 지금 자세 (앉기 · 포복 라벨). */
  stance: Stance;
  /** 무너진 통로를 `TUTORIAL_CRAWL_AIM_HINT_FRAC` 만큼 지났다 — 포복 구간에 발사 · 정조준 줄이 붙는다. */
  crawlHalf: boolean;
  /** 손에 든 빠른 사용 아이템이 회복 아이템(붕대)이다 — `heal` 의 `길게 눌러 사용` 줄. */
  handStim: boolean;
}

/**
 * 그 단계에 보일 줄 (자세를 타는 단계는 여기서 갈린다). `undefined` = **직전 줄 유지**.
 *
 * 2026-09-15 — `crouchAim` 도 자세를 탄다. 2026-09-14 3차의 사용자 보고 「라벨이 안 바뀐다」의 뿌리가 여기였다:
 * `crouch` 단계는 **앉는 그 순간 끝나고**(`player:stanceChanged` → `crouchAim`), `crouchAim` 은 표에 줄이 없어
 * 직전 줄을 **선 자세 라벨 그대로 얼려 둔 채** 포복 구간 전체를 지났다. 이제 두 단계 모두 지금 자세로 만든다.
 */
/*
 * 2026-09-16 (사용자 결정) — 포복 구간(`crouch` · `crouchAim`)은 `WASD 이동`(달리기 없음) ─ `C 앉기 · Z 포복` 이고, 통로를 절반쯤
 * 지나면(`crawlHalf`) 그 아래에 `발사 · 정조준` 이 붙는다. `heal` 의 `길게 눌러 사용` 은 붕대를 손에 들었을 때만 선다 —
 * 총 · 수류탄으로 바꾸면 빠지고 붕대로 돌아오면 다시 선다.
 */
export function controlHintsFor(step: TutorialStepId, state: ControlHintState): readonly ControlHint[] | undefined {
  if (step === 'crouch' || step === 'crouchAim') {
    const base = [MOVE_HINT, ...crouchHints(state.stance)];
    return state.crawlHalf ? [...base, FIRE_HINT, AIM_HINT, RELOAD_HINT] : base;
  }
  if (step === 'heal') return state.handStim ? TUTORIAL_CONTROL_HINTS.heal : HEAL_NO_STIM_HINTS;
  return TUTORIAL_CONTROL_HINTS[step];
}

/** `heal` 인데 붕대가 손에 없다 — 휠 두 줄만 (참조가 같아야 `applyControls` 가 DOM 을 안 건드린다). */
const HEAL_NO_STIM_HINTS: readonly ControlHint[] = [QUICK_WHEEL_HINT, QUICK_HINT];

/** 자세를 따라가는 줄의 id — 지금 떠 있는 줄에 이것이 있으면 자세가 바뀔 때마다 다시 그린다. */
export const STANCE_HINT_IDS: readonly string[] = ['crouch', 'prone'];

/* ── 앉아 조준 TIP (2026-09-15, 사용자 결정) ────────────────────────────────
 * 포복 · 앉아 조준 구간에서 **처음으로** 앉거나 엎드린 채 정조준하면 우측 조작 가이드 바로 아래에 토스트처럼
 * 작은 TIP 패널이 한 번 뜬다. 나타남 · 사라짐은 `update(dt)` 가 인라인 opacity 로 몬다 (reduced motion 이
 * CSS 전이를 0.01 ms 로 자르는 PC 가 있다 — 의미를 싣는 페이드는 CSS 로 만들지 않는다).
 * ────────────────────────────────────────────────────────────────────────── */

/** TIP 이 뜨는 단계. */
export const CROUCH_TIP_STEPS: readonly TutorialStepId[] = ['crouch', 'crouchAim'];
/** TIP 머리 라벨과 본문. */
export const TIP_LABEL_KO = 'TIP';
export const CROUCH_AIM_TIP_KO = '앉거나 포복해서 조준 시, 명중률이 높아집니다.';
/** 다 보인 채 머무는 시간 (s) · 나타나고 사라지는 시간 (s). */
export const TIP_HOLD_S = 6;
export const TIP_FADE_S = 0.35;
/** 조작 가이드 바닥과 TIP 사이 (px). */
export const TIP_GAP_PX = 8;

/* ── 레이드 트랙 건너뛰기 = 암전 → 결과 화면 (2026-09-15, 사용자 결정) ────────
 * ESC 메뉴의 「튜토리얼 건너뛰기」는 화면을 검게 덮은 뒤 **완전히 검어진 순간** `ExtractionRef.skipToComplete` 를 부른다 —
 * 함선이 떠나는 연출 없이 평소 탈출과 같은 결과 화면이 뜬다. 검은 판은 결과 화면으로 페이즈가 바뀌는 순간
 * `ui/HudSystem` 이 스스로 걷는다(`applyVisibility` 의 페이즈 가드).
 * ────────────────────────────────────────────────────────────────────────── */

/** 건너뛰기 암전에 걸리는 시간 (s). */
export const SKIP_FADE_OUT_S = 0.6;
/** 결과 화면 대신 이륙 연출로 떨어졌을 때(폴백) 다시 밝아지는 시간 (s). */
export const SKIP_FADE_IN_S = 0.4;

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
  /*
   * 2026-09-15 2차 (사용자 결정) — `corpse` 는 `corpseLoot` 이 아니라 **`corpseOpen`** 을 연다. 절벽을 건너선
   * 사람에게 「기관단총을 주무기 칸에 장착」부터 띄우면, 아직 열지도 않은 가방 속 물건을 옮기라는 말이 된다.
   * 시체 가방이 실제로 열리면(`inventory:containerOpened` 의 `corpse:…`) 그때 `corpseLoot` 이다.
   */
  corpse: 'corpseOpen',
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
  /*
   * 2026-09-15 (사용자 결정) — `supply` 는 `heal` 이 아니라 **`supplyLoot`** 를 연다. 전에는 절벽 2 를 내려서자마자
   * 붕대를 줍기도 전에 「붕대를 사용」이 떴다. 이제 보급품 시체에서 붕대를 얻고 창을 닫아야 `heal` 이다.
   * 줍지 않고 `wall` 까지 가면 `foldRaid('grenade')` 가 `heal` 까지 함께 건너뛴다.
   */
  supply: 'supplyLoot',
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
