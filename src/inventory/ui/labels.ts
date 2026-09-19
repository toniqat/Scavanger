import type { AmmoType, EffectiveWeaponStats, ItemCategory, ItemDef, LoadoutSlot, RoomPurpose, SocketSlot, WeaponDef, WeightState } from '@/shared';
import { Keys, SOCKET_LABEL_KO, UNIQUE_WEAPON_LABEL_KO, WEAPON_GRADE_ROMAN, WEIGHT_STATE_LABEL_KO, WORKBENCH_ICON, CREDIT_SUFFIX, formatCreditAmount, formatCredits, keyLabel, keyTable } from '@/shared';
import { AMMO_LABEL_KO, CATEGORY_LABEL_KO, RARITY_COLORS, RARITY_LABEL_KO, WEAPON_CLASS_LABEL_KO, getTierLabel, weaponClassOf } from '@/items';
import { categoryPathKo } from '@/shared';

/** 2026-09-13: English eyebrow word of the facility a bench belongs to (`TEXT.bench.eyebrow`). Wording only — no numbers. */
const FACILITY_EYEBROW: Partial<Record<RoomPurpose, string>> = { workshop: 'WORKSHOP', lab: 'LAB', kitchen: 'KITCHEN' };

/* ── Grid cell size — **the single source** (2026-09-14, user's decision 「a smaller cell frees vertical room」) ────
 *
 * The cell edge used to be written in two places — `CELL = 54` here and `--inv-cell: 54px` in `inventory.css`. JS sets
 * the grid box's px width · height (`GridView.syncDims`), the drag hit test (`hitTest` · `cellForGhost`) and the
 * highlight spot from it while CSS draws the cells with the same value, so **shrinking only one of them puts the drop
 * spot on a different cell than the cursor.** **JS is the source** now, and CSS's `--inv-cell` is only a first-frame
 * default — grid · window · ghost code all overwrite it inline with `applyGridCellVar`. CSS holds **no** media query.
 *
 * The ladder's numbers (threshold height · cell size) are `INV_CELL_*` in `data/tuning.csv`. The measure is the
 * **viewport height**: at 1280×760 · 1440×900 the window filled the screen vertically, `.inv-root`'s `safe center` fell
 * back to `flex-start` (= it stuck to the top), and a shorter window was the only spare height. 1080 px up keeps 54.
 */
const TUNING = /* data/tuning.csv */ keyTable('tuning.csv');
/** Steps in ascending window height. The first step whose `maxH` the height does not exceed gives the cell. */
const CELL_LADDER: readonly { readonly maxH: number; readonly cell: number }[] = [
  { maxH: TUNING.num('INV_CELL_TINY_MAX_VH'), cell: TUNING.num('INV_CELL_TINY_PX') },
  { maxH: TUNING.num('INV_CELL_SHORT_MAX_VH'), cell: TUNING.num('INV_CELL_SHORT_PX') },
];
const CELL_BASE = TUNING.num('INV_CELL_PX');

/** The cell edge (px) for this window height. It only reads the table — the thresholds and sizes are decided by csv. */
export const gridCellForHeight = (viewportH: number): number => {
  for (const step of CELL_LADDER) if (viewportH <= step.maxH) return step.cell;
  return CELL_BASE;
};

const viewportHeight = (): number => (typeof window === 'undefined' ? CELL_BASE * 20 : window.innerHeight);

/**
 * px — the grid cell edge at the current window height. **It is a `let` and `syncGridCell()` changes it** (an ESM live
 * binding, so importers see it too). A default argument (`cell = CELL`) is evaluated at the call, so it follows.
 */
export let CELL = gridCellForHeight(viewportHeight());
export const GAP = 2;     // px
/** px — cell + gap. The one-cell pitch the drag · highlight math uses. It moves together with `CELL`. */
export let STEP = CELL + GAP;

/**
 * Moves `CELL` · `STEP` to the cell the window height now asks for and returns true. The one caller is `InventoryUI`
 * (mount · resize), and on true it hands the new value to the window's `--inv-cell` and to every live `GridView`.
 */
export function syncGridCell(): boolean {
  const next = gridCellForHeight(viewportHeight());
  if (next === CELL) return false;
  CELL = next;
  STEP = CELL + GAP;
  return true;
}

/** Writes `--inv-cell` on this element — it overrides the CSS default so JS and CSS see the same cell. */
export const applyGridCellVar = (el: HTMLElement, cell: number = CELL): void => {
  el.style.setProperty('--inv-cell', `${cell}px`);
};
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
 * **The cell readout in the grid header** — `사용칸 / 전체칸` (2026-09-16, user's decision). It stands **left** of the
 * sort button and does not count defs (`N점`): the one thing a grid has to answer is "how many cells are left", and the
 * number of defs is what the tiles show. The Tab window's stash header (`InventoryUI.stashCount`, `.inv-capacity`) and
 * the embedded grids (`ui/TradeGrids`) must print the **same string** — so the wording lives here alone.
 */
export const capacityLabel = (usedCells: number, totalCells: number): string => `${usedCells} / ${totalCells}`;

/**
 * Credit value of an item / a grid (Phase 10): the one shared formatter, `1,200 C`. The old `₩` prefix is gone —
 * credits are the game's only currency and their unit is `CREDIT_SUFFIX`.
 */
export const fmtValue = (n: number): string => formatCredits(n);
/** 2026-09-16: the number part alone (`1,200`) — for a line that paints the unit in its own colour (가방 내 가치). */
export const fmtCreditNumber = (n: number): string => formatCreditAmount(n);
/**
 * The item's **`종류`** row. Since 2026-09-16 (user's decision) a category that has a super category reads in two steps
 * — 「수집품 > 서적」. It goes through `categoryPathKo` here too so the two tooltips (`inventory/ui/Tooltip` ·
 * `ui/hud/ItemTip`) and the craft card say the same sentence (change the separator in `shared/labels.ts` alone).
 */
export const categoryLabel = (def: ItemDef): string => categoryPathKo(def.category);
export const rarityLabel = (def: ItemDef): string => RARITY_LABEL_KO[def.rarity];
export const rarityColor = (def: ItemDef): string => RARITY_COLORS[def.rarity];
export const ammoLabel = (w: WeaponDef): string => AMMO_LABEL_KO[w.ammoType];
export const ammoTypeLabel = (t: AmmoType): string => AMMO_LABEL_KO[t];
/**
 * The weapon's **type** word (종류). 2026-09-15 (user's decision): a legendary unique names its own kind (`컴포짓 보우` …,
 * `UNIQUE_WEAPON_LABEL_KO`) — its csv `class` (AR / DMR / SMG / SR) only picks the shooting skill and never reaches the
 * screen. Graded guns keep the class label. (Same rule as `ui/hud/WeaponPanel.weaponTypeLabel`.)
 */
export const weaponClassLabel = (w: WeaponDef): string =>
  w.unique ? UNIQUE_WEAPON_LABEL_KO[w.unique] : WEAPON_CLASS_LABEL_KO[weaponClassOf(w)];
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
 * 2026-09-11 (A-15): `PouchDef.accepts` as one line — `약초 · 씨앗 · 토양 · 작물 · 표본`.
 * The source of the category names is `CATEGORY_LABEL_KO` (`@/shared`) alone.
 */
export const pouchAcceptsLabel = (accepts: readonly ItemCategory[]): string =>
  accepts.map((c) => CATEGORY_LABEL_KO[c] ?? c).join(' · ');

export const SLOT_LABEL: Readonly<Record<LoadoutSlot, string>> = {
  primary: '주무기 I', primary2: '주무기 II', secondary: '보조무기', bag: '가방', armor: '방탄복',
  /** 2026-09-11 (A-15): a fixed single slot — only one of 채집 · 열쇠 · 구급 · 귀중품 goes in. */
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
  /** 2026-09-16: the small text at the left end of the bag's bottom row — `가방 내 가치 1,000 C` (only the number is white). */
  bagValue: '가방 내 가치',
  creditUnit: CREDIT_SUFFIX,
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
  /* Phase 7: container search */
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
  /* 2026-09-16 (user's decision): held credits are **text** at the right end of the bag's bottom row, `12,345 C` — the `CREDITS` pill · eyebrow are gone. */
  credits: { value: (n: number): string => formatCredits(Math.max(0, n)), none: '—' },
  quick: {
    title: '퀵슬롯',
    eyebrow: 'QUICK USE',
    hint: '스팀·수류탄·가젯을 끌어다 놓기',
    holdHint: (key: string): string => `${key} 길게 눌러 휠 열기`,
    locked: '가방 등급이 낮아 잠김',
    empty: '비어 있음',
  },
  /**
   * **The pouch** (2026-09-11, A-15) — the one title line of the grid right under the quick-slot panel. With no pouch
   * equipped the block is not drawn at all, so there is no "비어 있음" wording.
   */
  pouch: {
    /** `채집 주머니 · 약초 · 씨앗 · 토양 · 작물 · 표본` — the accepted category names come from `CATEGORY_LABEL_KO`. */
    line: (name: string, accepts: string): string => `${name} · ${accepts}`,
  },
  /** 2026-09-16 (user's decision): `모두 창고로 이동` in the bag header — ship only, the bag grid only (`StashOps.moveBagToStash`). */
  bagToStash: {
    label: '모두 창고로 이동',
    title: '가방 격자의 아이템을 모두 함선 창고로 옮깁니다 (퀵슬롯 · 주머니 · 장착 장비는 그대로)',
    empty: '가방이 비어 있습니다',
    left: (n: number): string => `창고에 공간이 없습니다 (${n}개 남음)`,
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
    /* A-13 (2026-09-11): a preparation — used in the ship it is loaded as one use for the next raid */
    usePrep: '사용 (다음 레이드 1회분)',
    usePrepRaid: '레이드 중에는 쓸 수 없음',
    /* 2026-09-16 (the plate model): the meal's `먹기` entry is gone — a meal is not an item but the dining table's plate. */
    unload: '장전된 탄약 모두 탈착',
    detachAll: '무기 소켓 모두 탈착',
    splitHalf: '절반 나누기',
    splitOne: '하나 나누기',
    splitCustom: '수량 지정…',
    requestAmmo: '탄약 요청',
    request: '요청',
    /* 2026-09-15 (user's decision): the request entry for an equipped armor whose shield is even slightly down */
    requestShield: '실드 충전 요청',
    quickAssign: '빠른 슬롯에 등록',
    quickClear: '빠른 슬롯 해제',
    drop: '버리기',
    dropOne: '하나 버리기',
    /* 2026-09-12 (E1, user's decision): right-click opens the menu on **every item** — the old 「바로 옮기기」 became this entry */
    quickMove: { bag: '빠른 이동 (가방)', stash: '빠른 이동 (창고)', container: '빠른 이동 (상자)', pouch: '빠른 이동 (주머니)' } as Record<'bag' | 'stash' | 'container' | 'pouch', string>,
    favoriteOn: '즐겨찾기 켜기',
    favoriteOff: '즐겨찾기 끄기',
  },
  /**
   * 2026-09-12 (E1): favourites — the confirm card that asks once more before a salvage (`ui/DisassemblePanel`).
   * 2026-09-15 2nd pass (user's decision): `confirmHint` (「분해 버튼을 N초 동안 누르고 있어야 실행됩니다」) is gone —
   * 「how it is pressed」 is said by the left-click hold keycap **inside** the button (`shared/keycap.createHoldButtonCap`).
   */
  favorite: {
    confirmTitle: '즐겨찾기한 아이템입니다',
    confirmBody: (name: string): string => `${name} 을(를) 정말 분해할까요?`,
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
   * 2026-09-11 (C-36): `durability` — a bag wears down every raid too (its grid is unchanged even at 0).
   * 2026-09-12: `capacity` — the carry limit the bag adds (`Gear.bagCapacityBonus`; at 0 there is no row).
   */
  bagStats: { grid: '칸', quickSlots: '퀵슬롯', tactical: '전술형', durability: '내구도', capacity: '소지 한계' },
  /* Phase 9: 서적 (`ItemDef.book`) */
  /* 2026-09-12 (A-3e): discs · records get the same two rows — only the holder they go into differs */
  bookStats: {
    skill: '스킬', use: '용도', shelf: '서재 책장에 꽂으면 해당 스킬 XP 증가',
    discShelf: '서재 디스크 전시대에 꽂으면 해당 스킬 XP 증가', recordShelf: '서재 레코드랙에 꽂으면 해당 스킬 XP 증가',
  },
  /* appended: tactical kit */
  weight: '무게',
  /* 2026-09-10: armor gives a shield (extra hp), not damage reduction — `dr` is unused but left alone */
  armorStats: { dr: '피해 감소', shield: '실드', durability: '내구도', perk: '특성' },
  /**
   * 2026-09-10: 실드 충전기 (`shieldChargeOf`).
   * @deprecated 2026-09-15 — these rows are built by `items/ItemSpec.itemSpecRows` (the same function as the chip card).
   *   Nothing reads them; they stay as the old source of the wording.
   */
  shieldChargeStats: { amount: '실드 회복', useTime: '사용 시간', full: '최대치까지' },
  /**
   * 2026-09-12: the three combat consumables (`boostItemOf`) — 아드레날린 주사 · 각성제 · 안정제.
   * @deprecated 2026-09-15 — for the same reason as above, `itemSpecRows` takes over.
   */
  boostStats: {
    stamina: '스태미나', staminaFull: '전부 회복', drain: '지속 소모', drainNone: '없음 (질주 · 사다리 · 부양)',
    reload: '장전 속도', ads: '정조준 전환', sway: '조준 흔들림', staminaCost: '스태미나 소모',
    implant: '전술 임플란트', implantFull: '전부 충전 · 쿨타임 초기화', duration: '지속 시간', useTime: '사용 시간',
  },
  craft: '제작',
  craftPanel: '필드 제작',
  /** 2026-09-15 2nd pass (user's decision): the **one centred line** of a workbench with nothing to pick. */
  craftNone: '제작할 수 있는 레시피가 없습니다.',
  /**
   * 2026-09-15 2nd pass (user's decision): the detail panel's **held count** row. Its scope is the scope the materials
   * are counted over — bag + ship stash in the ship, the bag alone for quick craft in a raid (`InventoryRef.craftCountDef`).
   */
  craftOwned: (n: number): string => `보유 ${n}`,
  /**
   * The hold button's label (2026-09-15 2nd pass, user's decision — the old `길게 눌러 제작`). 「how long to press」 is
   * said by the left-click hold keycap **inside** the button (`shared/keycap.createHoldButtonCap`), so the label only names the act.
   */
  craftHold: '제작',
  craftMaking: '제작 중…',
  /**
   * 2026-09-09: with nowhere for the product to go the hold button turns into this wording and is disabled (`CraftPanel.paint`).
   * A ship workbench looks bag → stash (`Crafting.roomForOutputs`), so there it names both places.
   */
  craftNoRoomShip: '가방·창고 공간 부족',
  craftNoRoomField: '가방 공간 부족',
  /** The disabled button's `title` — one sentence on why it cannot be pressed. */
  craftNoRoomTipShip: '만든 것을 넣을 자리가 없습니다 — 가방과 함선 창고를 비우세요',
  craftNoRoomTipField: '만든 것을 넣을 자리가 없습니다 — 가방을 비우세요',
  /* The craft count (2026-09-09) — the label above `◀ 90 ▶` and the accessible names of the arrow buttons. */
  craftCount: {
    label: '제작 수량',
    less: '수량 줄이기',
    more: '수량 늘리기',
    /** The `title` of the buttons · the control — it says the wheel adjusts it too. */
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
    /* 2026-09-13 (user's decision): the bottom hint line (`hint`) is gone — drag · double-click behave as in any other grid. */
    empty: '일치하는 아이템이 없습니다',
    close: '닫기',
    bagFull: '가방에 공간이 없습니다',
    /** 2026-09-17: in the ship a double-click goes stash → bag, so this says both are full. */
    stashBagFull: '창고와 가방에 공간이 없습니다',
    tabs: {
      all: '전체', weapon: '무기', ammo: '탄약', attachment: '부착물', bag: '가방', armor: '방탄복',
      gadget: '가젯', consumable: '소모품', material: '재료', herb: '약초', seed: '씨앗', book: '서재', furniture: '가구',
      /** Phase 12: 임플란트 items (label from the shared category table, the one source of the word). */
      implant: CATEGORY_LABEL_KO.implant,
      /** 2026-09-16 (user's report): the sample tab — the same word as the bag filter's `표본` chip (source: the shared category table). */
      sample: CATEGORY_LABEL_KO.sample,
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
     * 2026-09-09: in the ship the outputs go bag → stash (`Crafting.roomForOutputs`), so there the wording names both
     * places. `noRoom` stays the raid wording (no stash there).
     */
    noRoom: '가방에 공간이 없습니다',
    noRoomShip: '가방과 함선 창고에 공간이 없습니다',
  },
  /**
   * **Durability buckets** (2026-09-10, the craft rework). Repair materials and salvage output are `craft materials ×
   * the multiplier of the remaining bucket`, so the screen has to say two things — ① **which bucket** it is in now, and
   * ② **what that bucket's multiplier** is. The multiplier comes from `ctx.loot.durabilityBucketInfo`, never a constant
   * here (the numbers live in `data/tables.csv`). An item with no durability is always bucket 4, so it draws no row.
   */
  durability: {
    eyebrow: '남은 내구도',
    /** `81~100 % · 제작 재료의 10 %` — the repair popup. */
    repair: (label: string, mul: number): string => `${label} · 제작 재료의 ${Math.round(mul * 100)} %`,
    /** `81~100 % · 제작 재료의 40 %` — the salvage popup. */
    salvage: (label: string, mul: number): string => `${label} · 제작 재료의 ${Math.round(mul * 100)} %`,
    /** The one line that says the numbers change when the bucket does. */
    repairNote: '내구도가 낮을수록 수리 재료가 많이 듭니다',
    salvageNote: '내구도가 낮을수록 나오는 재료가 적습니다',
    /*
     * 2026-09-12: the hover card's `구간` row (`tooltip` · `tooltipKey` of 2026-09-11 C-37) is **gone** — an item card
     * says it with the durability gauge alone, and the bucket and its multiplier keep being written by `repair` ·
     * `salvage` in the two screens they decide (the repair popup `ui/RepairPanel` · the salvage popup `ui/DisassemblePanel`).
     */
  },
  /** Shared close affordance of the modeless popups (임플란트 / 제작 / 분해). */
  modelessClose: '닫기',
  /**
   * **Picking a workbench** (2026-09-10 a row of tabs → 2026-09-12 a vertical list on the left, user's decision). The
   * source of a workbench **name** is `WORKBENCH_LABEL_KO` (`@/shared`) alone; what lives here is the `빠른제작` label
   * and **the glyphs only**. (The ship management screen `ui/hud/ShipManage` uses the same glyphs — a workbench has to
   * be recognised by the same eye.) `all` (`전체`) left the list and on 2026-09-13 its label · glyph went too — pouring
   * 94 rows into one list was unreadable, which is why they were split up in the first place.
   */
  craftTabs: {
    /** A recipe with no `bench` = field quick craft (it can be made in the ship too). It heads the workshop group (2026-09-13). */
    field: '빠른제작',
    /** The workbench glyphs come from `WORKBENCH_ICON` in `shared` — the same character the furniture card (`ui/hud/ShipManage`) uses. */
    icon: { field: '✥', ...WORKBENCH_ICON } as Readonly<Record<string, string>>,
  },
  /* Phase 6: 작업실 bench crafting */
  bench: {
    /**
     * 2026-09-13: the header's English line is the **facility** the workbench belongs to (`ui/CraftPanel.benchFacility` —
     * `room` in `data/furniture.csv`). It used to be `WORKSHOP BENCH` always; an unknown facility = its room id upper-cased.
     */
    eyebrow: (facility: RoomPurpose): string => `${FACILITY_EYEBROW[facility] ?? facility.toUpperCase()} BENCH`,
    level: (n: number): string => `Lv.${n}`,
    lockedLevel: (n: number): string => `작업대 Lv.${n} 필요`,
    /* 2026-09-16 (user's decision, 2nd pass): the row locked for want of skill — `제작 20 필요`. Every
       `skillRequired` in `recipes.csv` is 0 today so it never shows, but raising the number brings it straight back. */
    lockedSkill: (label: string, n: number): string => `${label} ${n} 필요`,
    discount: (pct: number): string => `작업실 할인 −${pct} %`,
    repairTitle: '수리',
    repairNone: '수리할 장비가 없습니다',
    /* 2026-09-08 — repair is not under the workbench panel but the header's `모두 수리` → a modal popup */
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
