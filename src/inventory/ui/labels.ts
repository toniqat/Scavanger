import type { AmmoType, EffectiveWeaponStats, ItemCategory, ItemDef, LoadoutSlot, SocketSlot, WeaponDef, WeightState } from '@/shared';
import { Keys, SOCKET_LABEL_KO, WEAPON_GRADE_ROMAN, WEIGHT_STATE_LABEL_KO, WORKBENCH_ICON, formatCreditAmount, formatCredits, keyLabel } from '@/shared';
import { AMMO_LABEL_KO, CATEGORY_LABEL_KO, RARITY_COLORS, RARITY_LABEL_KO, WEAPON_CLASS_LABEL_KO, getTierLabel, weaponClassOf } from '@/items';

export const CELL = 54;   // px — default grid cell edge (the Tab window / container grids)
export const GAP = 2;     // px
export const STEP = CELL + GAP;
/**
 * Pixel size of a `w × h` footprint at an arbitrary cell edge (2026-09-07). `GridView` is built with a `cell` so a
 * screen that needs a denser grid — the 기업 거래 desk, whose 구매 / 판매 tray must show five columns inside its
 * column — can render the very same tiles smaller. `tileSize` keeps the default edge.
 */
export const tileSizeAt = (w: number, h: number, cell: number): { width: number; height: number } => ({
  width: w * (cell + GAP) - GAP,
  height: h * (cell + GAP) - GAP,
});

/**
 * Credit value of an item / a grid (Phase 10): the one shared formatter, `1,200 C`. The old `₩` prefix is gone —
 * credits are the game's only currency and their unit is `CREDIT_SUFFIX`.
 */
export const fmtValue = (n: number): string => formatCredits(n);
export const categoryLabel = (def: ItemDef): string => CATEGORY_LABEL_KO[def.category];
export const rarityLabel = (def: ItemDef): string => RARITY_LABEL_KO[def.rarity];
export const rarityColor = (def: ItemDef): string => RARITY_COLORS[def.rarity];
export const ammoLabel = (w: WeaponDef): string => AMMO_LABEL_KO[w.ammoType];
export const ammoTypeLabel = (t: AmmoType): string => AMMO_LABEL_KO[t];
export const weaponClassLabel = (w: WeaponDef): string => WEAPON_CLASS_LABEL_KO[weaponClassOf(w)];
export const gradeLabel = (s: EffectiveWeaponStats): string => WEAPON_GRADE_ROMAN[s.grade - 1] ?? String(s.grade);
/** Effective range: where damage starts to fall off, or the max range when the weapon has no falloff. */
export const effectiveRange = (w: WeaponDef): number => w.falloffStart ?? w.range;
export const tierTitle = (tier: number): string => getTierLabel(tier);
/** Radians → degrees with two decimals (recoil display). */
export const fmtDeg = (rad: number): string => `${(rad * 180 / Math.PI).toFixed(2)}°`;
/** Percentage change of a multiplier (`0.75` → `−25 %`). */
export const fmtMul = (m: number): string => `${m < 1 ? '−' : '+'}${Math.round(Math.abs(1 - m) * 100)} %`;
/** Durability thresholds shared by tiles / tooltip. */
export const DURABILITY_LOW = 0.3;
/* 2026-09-09: tooltip socket squares — two-letter caption of an empty socket and the square's `title`. */
/** `총구` → `총구`, `개머리판` → `개머`, `조준경` → `조준` — the muted caption of an empty socket square. */
export const socketAbbr = (s: SocketSlot): string => SOCKET_LABEL_KO[s].slice(0, 2);
/** `조준경: 없음` / `총구: 소음기` — hover title of one socket square. */
export const socketTip = (s: SocketSlot, attachmentName?: string): string => `${SOCKET_LABEL_KO[s]}: ${attachmentName ?? TEXT.socketNone}`;

/**
 * 2026-09-11 (A-15): `PouchDef.accepts` 를 한 줄로 — `약초 · 씨앗 · 토양 · 작물 · 표본`.
 * 카테고리 이름의 원본은 `CATEGORY_LABEL_KO`(`@/shared`) 하나다.
 */
export const pouchAcceptsLabel = (accepts: readonly ItemCategory[]): string =>
  accepts.map((c) => CATEGORY_LABEL_KO[c] ?? c).join(' · ');

export const SLOT_LABEL: Readonly<Record<LoadoutSlot, string>> = {
  primary: '주무기 I', primary2: '주무기 II', secondary: '보조무기', bag: '가방', armor: '방탄복',
  /** 2026-09-11 (A-15): 고정 1칸 — 채집 · 열쇠 · 구급 · 귀중품 넷 중 하나만 끼운다. */
  pouch: '주머니',
};
/** @deprecated static defaults — use `slotKeyLabel(slot)` (follows the live bindings). */
export const SLOT_KEY: Readonly<Record<LoadoutSlot, string>> = { primary: '1', primary2: '2', secondary: '3', bag: '', armor: '', pouch: '' };
/** Live key label of a weapon slot ('' for bag / armor). */
export function slotKeyLabel(slot: LoadoutSlot): string {
  if (slot === 'primary') return keyLabel(Keys.PRIMARY);
  if (slot === 'primary2') return keyLabel(Keys.PRIMARY2);
  if (slot === 'secondary') return keyLabel(Keys.SECONDARY);
  return '';
}
/* appended: tactical kit */
export const fmtKg = (n: number): string => `${n.toFixed(1)} kg`;
export const weightLabel = (state: WeightState): string => WEIGHT_STATE_LABEL_KO[state] ?? state;
/** Wheel direction glyphs by quick-slot index (N, NE, E, SE, S, SW, W, NW). */
export const QUICK_DIR_GLYPH: readonly string[] = ['▲', '◥', '►', '◢', '▼', '◣', '◄', '◤'];
/** DOM order of the 3×3 compass rose (row-major, -1 = centre). */
export const QUICK_ROSE_ORDER: readonly number[] = [7, 0, 1, 6, -1, 2, 5, 4, 3];

export const TEXT = {
  bag: '가방',
  equipment: '장비',
  emptySlot: '비어 있음',
  takeAll: '모두 가져가기',
  value: '가치',
  quickSlots: '퀵슬롯',
  hintRotate: '회전',
  hintDrop: '버리기',
  /* hub screen (2026-09-06) */
  stash: '함선 창고',
  tabs: {
    inventory: '인벤토리', character: '캐릭터', corp: '기업', ship: '함선',
    corpHint: '기업 네트워크: 상점 · 계약 · 퀘스트',
    characterHint: '캐릭터: 능력치 · 스킬 · 레벨',
    shipHint: '함선 관리: 시설 업그레이드 · 방 용도',
    unavailable: (what: string): string => `${what} 정보를 사용할 수 없습니다`,
  },
  /* Phase 7: container search (감정) */
  search: {
    hiddenIcon: '?',
    hiddenName: '???',
    /** Header readout while items are still hidden. */
    status: (left: number): string => `감정 중 · ${left}개 남음`,
    done: '감정 완료',
    /** Tooltip / notify when an unsearched item is used. */
    locked: '아직 감정하지 않은 아이템입니다',
    /** Host refused a take (someone else got it first). */
    denied: '다른 대원이 먼저 가져갔습니다',
  },
  /* Phase 5: credits readout on the ship screen */
  /* Phase 8: the pill already carries the `CREDITS` eyebrow — the value is the bare number (`CREDITS 500`). */
  /* Phase 10: the grouped number comes from the shared formatter (`formatCreditAmount` = `formatCredits` without the unit). */
  credits: { eyebrow: 'CREDITS', value: (n: number): string => formatCreditAmount(Math.max(0, n)), none: '—' },
  quick: {
    title: '퀵슬롯',
    eyebrow: 'QUICK USE',
    hint: '스팀·수류탄·가젯을 끌어다 놓기',
    holdHint: (key: string): string => `${key} 길게 눌러 휠 열기`,
    locked: '가방 등급이 낮아 잠김',
    empty: '비어 있음',
  },
  /**
   * **주머니** (2026-09-11, A-15) — 퀵슬롯 패널 바로 아래 격자의 제목 한 줄. 장착한 주머니가 없으면
   * 그 자리를 통째로 그리지 않으므로 "비어 있음" 문구는 없다.
   */
  pouch: {
    /** `채집 주머니 · 약초 · 씨앗 · 토양 · 작물 · 표본` — 받는 카테고리 이름은 `CATEGORY_LABEL_KO` 가 원본이다. */
    line: (name: string, accepts: string): string => `${name} · ${accepts}`,
  },
  dropZone: '버리기',
  dropZoneHint: '여기에 놓으면 아이템을 바닥에 버립니다',
  menu: {
    equip: '장착',
    equipPrimary2: '주무기 II로 장착',
    toBag: '가방으로 이동',
    toContainer: '상자로 이동',
    toStash: '창고로 이동',
    repair: '수리',
    repairShort: '재료 부족',
    repairShortMsg: '수리 재료가 부족합니다',
    repairFail: '수리할 수 없습니다',
    /* A-13 (2026-09-11): 준비물 — 함선에서 쓰면 다음 레이드 1회분으로 실린다 */
    usePrep: '사용 (다음 레이드 1회분)',
    usePrepRaid: '레이드 중에는 쓸 수 없음',
    /* A-3c (2026-09-11): 요리 — 준비물의 `사용` 바로 옆. 제자리는 주방의 식탁이고 이것은 편의 경로다. */
    eatMeal: '먹기 (다음 레이드 1회분)',
    eatMealRaid: '레이드 중에는 먹을 수 없음',
    unload: '장전된 탄약 모두 탈착',
    detachAll: '무기 소켓 모두 탈착',
    splitHalf: '절반 나누기',
    splitOne: '하나 나누기',
    splitCustom: '수량 지정…',
    requestAmmo: '탄약 요청',
    request: '요청',
    quickAssign: '빠른 슬롯에 등록',
    quickClear: '빠른 슬롯 해제',
    drop: '버리기',
    dropOne: '하나 버리기',
    /* 2026-09-12 (E1, 사용자 결정): 우클릭은 **모든 아이템**에 메뉴를 연다 — 예전의 「바로 옮기기」는 이 항목이 됐다 */
    quickMove: { bag: '빠른 이동 (가방)', stash: '빠른 이동 (창고)', container: '빠른 이동 (상자)', pouch: '빠른 이동 (주머니)' } as Record<'bag' | 'stash' | 'container' | 'pouch', string>,
    favoriteOn: '즐겨찾기 켜기',
    favoriteOff: '즐겨찾기 끄기',
  },
  /** 2026-09-12 (E1): 즐겨찾기 — 분해 전에 한 번 더 묻는 확인 카드 (`ui/DisassemblePanel`). */
  favorite: {
    confirmTitle: '즐겨찾기한 아이템입니다',
    confirmBody: (name: string): string => `${name} 을(를) 정말 분해할까요?`,
    confirmHint: (sec: number): string => `분해 버튼을 ${sec}초 동안 누르고 있어야 실행됩니다`,
    cancel: '취소',
    confirm: '분해',
  },
  split: {
    title: '수량 지정',
    keep: '남김',
    take: '나눔',
    confirm: '확인',
    cancel: '취소',
  },
  size: '크기',
  qty: '수량',
  weaponStats: {
    damage: '대미지', fireRate: '연사', magSize: '탄창', loaded: '장전',
    reload: '재장전', ammo: '탄종', range: '사거리', mode: '발사 모드',
    weaponClass: '종류', grade: '등급', effectiveRange: '유효 사거리', zoom: '배율',
    recoil: '반동', adsTime: '정조준 시간', durability: '내구도', sockets: '소켓',
  },
  attachmentStats: {
    socket: '소켓', fits: '호환', all: '모든 무기', recoilV: '수직 반동', recoilH: '수평 반동', spread: '탄 퍼짐',
    hipSpread: '지향 사격 퍼짐', adsTime: '정조준 시간', magSize: '장탄수', zoom: '배율', scope: '스코프', laser: '레이저',
  },
  /**
   * 2026-09-11 (C-36): `durability` — 가방도 레이드마다 닳는다 (0 이어도 격자는 그대로).
   * 2026-09-12: `capacity` — 가방이 늘려 주는 소지 한계 (`Gear.bagCapacityBonus`, 0 이면 줄이 없다).
   */
  bagStats: { grid: '칸', quickSlots: '퀵슬롯', tactical: '전술형', durability: '내구도', capacity: '소지 한계' },
  /* Phase 9: 서적 (`ItemDef.book`) */
  /* 2026-09-12 (A-3e): 디스크 · 레코드도 같은 두 줄 — 꽂는 보관함만 다르다 */
  bookStats: {
    skill: '스킬', use: '용도', shelf: '서재 책장에 꽂으면 해당 스킬 XP 증가',
    discShelf: '서재 디스크 전시대에 꽂으면 해당 스킬 XP 증가', recordShelf: '서재 레코드랙에 꽂으면 해당 스킬 XP 증가',
  },
  /* appended: tactical kit */
  weight: '무게',
  /* 2026-09-10: 방탄복은 피해 감소가 아니라 실드(추가 체력)를 준다 — `dr` 은 안 쓰지만 남겨 둔다 */
  armorStats: { dr: '피해 감소', shield: '실드', durability: '내구도', perk: '특성' },
  /* 2026-09-10: 실드 충전기 (`shieldChargeOf`) */
  shieldChargeStats: { amount: '실드 회복', useTime: '사용 시간', full: '최대치까지' },
  /* 2026-09-12: 전투 소모품 3종 (`boostItemOf`) — 아드레날린 주사 · 각성제 · 안정제 */
  boostStats: {
    stamina: '스태미나', staminaFull: '전부 회복', drain: '지속 소모', drainNone: '없음 (질주 · 사다리 · 부양)',
    reload: '장전 속도', ads: '정조준 전환', sway: '조준 흔들림', staminaCost: '스태미나 소모',
    implant: '전술 임플란트', implantFull: '전부 충전 · 쿨타임 초기화', duration: '지속 시간', useTime: '사용 시간',
  },
  craft: '제작',
  craftPanel: '필드 제작',
  craftNone: '지금 만들 수 있는 레시피가 없습니다',
  craftHold: '길게 눌러 제작',
  craftMaking: '제작 중…',
  /**
   * 2026-09-09: 산출물이 갈 데가 없으면 홀드 버튼이 이 문구로 바뀌며 비활성화된다 (`CraftPanel.paint`).
   * 함선 작업대는 가방 → 창고 순으로 보므로 (`Crafting.roomForOutputs`) 두 곳을 다 말한다.
   */
  craftNoRoomShip: '가방·창고 공간 부족',
  craftNoRoomField: '가방 공간 부족',
  /** 비활성 버튼의 `title` — 왜 못 누르는지 한 문장으로. */
  craftNoRoomTipShip: '만든 것을 넣을 자리가 없습니다 — 가방과 함선 창고를 비우세요',
  craftNoRoomTipField: '만든 것을 넣을 자리가 없습니다 — 가방을 비우세요',
  /* 제작 수량 (2026-09-09) — `◀ 90 ▶` 위의 라벨과 화살표 버튼의 접근성 이름. */
  craftCount: {
    label: '제작 수량',
    less: '수량 줄이기',
    more: '수량 늘리기',
    /** 버튼 · 컨트롤의 `title` — 휠로도 조절된다는 것을 알려 준다. */
    hint: '휠 또는 좌우 버튼으로 조절',
  },
  craftStationShip: '함선 작업대',
  craftStationField: '야전 제작',
  socketEmpty: '비어 있음',
  /** 2026-09-09: `조준경: 없음` in a tooltip socket square's title (`socketTip`). */
  socketNone: '없음',
  broken: '고장',
  auto: '자동', semi: '반자동', pellets: '펠릿',
  /* Phase 6: 무한 상자 (cheat catalog) */
  catalog: {
    eyebrow: 'CHEAT · INFINITE CRATE',
    title: '무한 상자',
    search: '이름으로 검색…',
    count: (n: number): string => `${n}종`,
    hint: '드래그 → 가방 · 창고 · 슬롯에 새 아이템 생성 · 더블클릭 → 가방에 넣기',
    empty: '일치하는 아이템이 없습니다',
    close: '닫기',
    bagFull: '가방에 공간이 없습니다',
    tabs: {
      all: '전체', weapon: '무기', ammo: '탄약', attachment: '부착물', bag: '가방', armor: '방탄복',
      gadget: '가젯', consumable: '소모품', material: '재료', herb: '약초', seed: '씨앗', book: '서재', furniture: '가구',
      /** Phase 12: 임플란트 items (label from the shared category table, the one source of the word). */
      implant: CATEGORY_LABEL_KO.implant,
    },
  },
  /* Phase 12: 임플란트 item tooltip (`ItemDef.implant`) */
  implantStats: {
    slots: '장착칸',
    perk: '특성',
    broken: '망가짐 — 세레스 바이오에서 수리',
  },
  /** Phase 12: 회복 스프레이 gauge row (`durability` / `durabilityMax`). */
  gauge: '게이지',
  /* Phase 8: 아이템 분해 (right-click → modeless dialog with the expected result) */
  disassemble: {
    eyebrow: 'DISASSEMBLE',
    title: '아이템 분해',
    menu: '분해',
    /** Column captions of the input → output preview. */
    input: '재료',
    output: '결과물',
    arrow: '→',
    button: '분해',
    working: '분해 중…',
    short: '재료가 부족합니다',
    done: '분해 완료',
    fail: '분해할 수 없습니다',
    close: '닫기',
    /**
     * 2026-09-08: the bag is checked **before** the hold now, so this is a refusal, not a post-mortem.
     * 2026-09-09: 함선에서는 결과물이 가방 → 창고 순으로 들어가므로 (`Crafting.roomForOutputs`) 거기서는
     * 두 곳을 다 말한다. `noRoom` 은 레이드(창고 없음) 쪽 문구로 남는다.
     */
    noRoom: '가방에 공간이 없습니다',
    noRoomShip: '가방과 함선 창고에 공간이 없습니다',
  },
  /**
   * **내구도 구간** (2026-09-10, 제작 대개편). 수리 재료와 분해 산출은 `제작 재료 × 남은 내구도 구간의 배수`
   * 라서, 화면이 말해 줘야 하는 것은 두 가지다 — ① 지금 **어느 구간**인가, ② 그 구간의 **배수가 얼마**인가.
   * 배수는 `ctx.loot.durabilityBucketInfo` 가 주는 값이고 여기 상수로 적지 않는다 (수치는 `data/tables.csv`).
   * 내구도가 없는 아이템은 언제나 구간 4 이므로 이 줄을 그리지 않는다.
   */
  durability: {
    eyebrow: '남은 내구도',
    /** `81~100 % · 제작 재료의 10 %` — 수리 팝업. */
    repair: (label: string, mul: number): string => `${label} · 제작 재료의 ${Math.round(mul * 100)} %`,
    /** `81~100 % · 제작 재료의 40 %` — 분해 팝업. */
    salvage: (label: string, mul: number): string => `${label} · 제작 재료의 ${Math.round(mul * 100)} %`,
    /** 구간이 바뀌면 숫자가 바뀐다는 것을 말해 주는 한 줄. */
    repairNote: '내구도가 낮을수록 수리 재료가 많이 듭니다',
    salvageNote: '내구도가 낮을수록 나오는 재료가 적습니다',
    /*
     * 2026-09-12: 호버 카드의 `구간` 줄(2026-09-11 C-37 의 `tooltip` · `tooltipKey`)은 **없앴다** — 아이템 카드는
     * 내구도 게이지 하나로 말하고, 구간과 배수는 그것으로 값이 정해지는 두 화면(수리 팝업 `ui/RepairPanel` ·
     * 분해 팝업 `ui/DisassemblePanel`)이 `repair` · `salvage` 로 계속 적는다.
     */
  },
  /** Shared close affordance of the modeless popups (임플란트 / 제작 / 분해). */
  modelessClose: '닫기',
  /**
   * **작업대 고르기** (2026-09-10 가로 탭 → 2026-09-12 왼쪽 세로 리스트, 사용자 결정). 작업대 **이름**의 원본은
   * `WORKBENCH_LABEL_KO`(`@/shared`) 하나이고 여기 있는 것은 `빠른제작` 라벨과 **글리프뿐**이다.
   * (같은 글리프를 `ui/hud/ShipManage` 의 시설 관리 화면도 쓴다 — 작업대를 알아보는 눈이 같아야 한다.)
   * `all` (`전체`) 은 리스트에서 빠졌다 — 94 줄을 한 목록에 쏟는 것이 애초에 읽히지 않아 가르기 시작한 이유다.
   */
  craftTabs: {
    all: '전체',
    /** `bench` 가 없는 레시피 = 현장 빠른제작 (함선에서도 만들 수 있다). */
    field: '빠른제작',
    /** 작업대 글리프의 원본은 `shared` 의 `WORKBENCH_ICON` 이다 — 가구 카드(`ui/hud/ShipManage`)와 같은 글자여야 한다. */
    icon: { all: '▦', field: '✥', ...WORKBENCH_ICON } as Readonly<Record<string, string>>,
  },
  /* Phase 6: 작업실 bench crafting */
  bench: {
    eyebrow: 'WORKSHOP BENCH',
    level: (n: number): string => `Lv.${n}`,
    lockedLevel: (n: number): string => `작업대 Lv.${n} 필요`,
    discount: (pct: number): string => `작업실 할인 −${pct} %`,
    repairTitle: '수리',
    repairNone: '수리할 장비가 없습니다',
    /* 2026-09-08 — 수리는 작업대 패널 아래가 아니라 헤더의 `모두 수리` → 모달 팝업이다 */
    repairEyebrow: 'MAINTENANCE',
    repairModal: '장비 수리',
    repairTotal: '소모 재료',
    repairTotalNone: '소모하는 재료가 없습니다',
    repairDrop: '수리 목록에서 제외',
    repairKeep: '다시 수리 목록에',
    repairExcluded: '제외됨',
    repairRun: (n: number): string => n > 0 ? `모두 수리 (${n})` : '모두 수리',
    repairHint: '개별 수리는 아이템 우클릭 → 수리',
    repairDone: '정비 완료',
    repairAll: '모두 수리',
    repairShort: '재료 부족',
    repairBtn: '수리',
    repairOk: '수리 완료',
    repairFail: '재료가 부족합니다',
    repairAllResult: (done: number, skipped: number): string =>
      done > 0 ? `${done}개 수리 완료${skipped > 0 ? ` · ${skipped}개 재료 부족` : ''}` : skipped > 0 ? '재료가 부족합니다' : '수리할 장비가 없습니다',
    close: '닫기',
  },
} as const;

/** Pixel size of a w×h-cell tile. */
export const tileSize = (w: number, h: number): { width: number; height: number } => ({
  width: w * STEP - GAP,
  height: h * STEP - GAP,
});
