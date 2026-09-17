/**
 * Global gameplay constants shared by every module. Do not duplicate these elsewhere.
 *
 * **수치는 여기에 없다.** 스칼라 수치는 전부 `data/constants.csv` 에 있고 이 파일은 그 표를 이름으로 읽을 뿐이다
 * (`K.num('MAP_SIZE')`). 값을 조정할 때는 csv 만 고치면 되고, 이름 · 주석 · 타입은 계속 여기가 원본이다.
 * 새 상수를 추가할 때는 csv 에 줄을 넣고 여기에 `export const X = K.num('X');` 한 줄을 더한다.
 */
import { costLevels, csvRows, keyTable, numberList, numberMap, stringList } from './data/tables';

const K = /* data/constants.csv */ keyTable('constants.csv');

export const MAP_SIZE = K.num('MAP_SIZE');                 // world is a square [-MAP_SIZE/2, MAP_SIZE/2] on X and Z (meters)
export const EXTRACTION_COUNTDOWN = K.num('EXTRACTION_COUNTDOWN');     // seconds from switch press to ship arrival
export const PLAYER_MAX_HP = K.num('PLAYER_MAX_HP');
export const PLAYER_RADIUS = K.num('PLAYER_RADIUS');
export const PLAYER_HEIGHT = K.num('PLAYER_HEIGHT');
export const PLAYER_WALK_SPEED = K.num('PLAYER_WALK_SPEED');
export const PLAYER_SPRINT_SPEED = K.num('PLAYER_SPRINT_SPEED');
export const PLAYER_INTERACT_RANGE = K.num('PLAYER_INTERACT_RANGE');
export const INVENTORY_COLS = K.num('INVENTORY_COLS');
export const INVENTORY_ROWS = K.num('INVENTORY_ROWS');
export const GRAVITY = K.num('GRAVITY');
export const PLAYER_MAX_STAMINA = K.num('PLAYER_MAX_STAMINA');
export const PLAYER_CROUCH_SPEED = K.num('PLAYER_CROUCH_SPEED');
export const PLAYER_PRONE_SPEED = K.num('PLAYER_PRONE_SPEED');
/** Seconds a ping marker stays on screen / map. */
export const PING_LIFETIME = K.num('PING_LIFETIME');

/** Three.js object layers. Use camera.layers / raycaster.layers to filter. */
export const Layers = {
  DEFAULT: 0,
  TERRAIN: 1,
  PROP: 2,
  ENEMY: 3,
  PLAYER: 4,
  INTERACTABLE: 5,
  NO_RAYCAST: 6,
} as const;

/**
 * Every rebindable action. Values are `KeyboardEvent.code`s or the synthetic mouse codes `Mouse0`..`Mouse4`
 * (`Input` registers those in the same key sets, so `input.isDown(Keys.X)` works for both).
 */
export interface KeyBindings {
  FORWARD: string; BACK: string; LEFT: string; RIGHT: string;
  SPRINT: string; JUMP: string;
  CROUCH: string; PRONE: string; DIVE: string;
  RELOAD: string; INTERACT: string;
  STIM: string; GRENADE: string;
  PRIMARY: string; PRIMARY2: string; SECONDARY: string;
  INVENTORY: string; ROTATE_ITEM: string; MENU: string; MAP: string;
  DROP_ITEM: string; CHAT: string;
  QUICK: string; RESPAWN: string; GIVE_UP: string;
  SHIP_CALL: string;
  /* appended (key rebinding, 2026-09-06): the tactical-kit keys and the three mouse actions joined the table. */
  IMPLANT: string; MELEE: string; THROW_MODE: string;
  /* appended (Phase 10): contextual second use of MELEE — a downed squadmate in range turns the F tap into 들쳐메기. */
  CARRY: string;
  FIRE: string; AIM: string; PING: string;
  /* appended (dev console, 2026-09-06): ` opens the console on a dev client, Home = /movecheat fast move. */
  CONSOLE: string; MOVE_CHEAT: string;
  /* appended (Phase 11): hold P to accept a 분대 초대 (ship only). Took P off the undocumented character-sheet shortcut. */
  INVITE: string;
  /* appended (2026-09-07, 커서 rework): Alt frees the mouse cursor during gameplay without opening any screen.
     2026-09-10: 그 기능은 제거됐다 — 계약이라 필드는 남고 아무도 읽지 않는다 (`SECONDARY` 와 같은 처리). */
  CURSOR: string;
  /* appended (2026-09-09): H 홀드 = 의사소통 휠. 톡 누르면 아무 일도 없다 (STIM 이 은퇴하며 비운 자리다). */
  COMMS: string;
  /* appended (2026-09-12): 어깨 전환 — 3인칭 카메라를 왼쪽 / 오른쪽 어깨로 옮긴다 (owner: player/CameraRig). */
  SHOULDER: string;
  /* appended (2026-09-17): 튜토리얼 레이드 우측 조작 가이드 접기 / 펴기 (owner: tutorial — 증축 안내의 마지막 레이드에서만 읽는다). */
  GUIDE_TOGGLE: string;
}

/** Factory defaults; `Keys` is the live (rebindable) copy. Both are keyed by `KeyAction`. */
export const DEFAULT_KEYS: Readonly<KeyBindings> = {
  FORWARD: 'KeyW', BACK: 'KeyS', LEFT: 'KeyA', RIGHT: 'KeyD',
  SPRINT: 'ShiftLeft', JUMP: 'Space',
  /** C toggles crouch, Z toggles prone, V rolls (ends prone). Alt is unbound since the Alt 커서 was removed (2026-09-10). */
  CROUCH: 'KeyC', PRONE: 'KeyZ', DIVE: 'KeyV',
  RELOAD: 'KeyR', INTERACT: 'KeyE',
  /** Tactical kit: H puts a stim in hand directly (F is the melee attack). GRENADE is legacy (G = ship calls). */
  STIM: 'KeyH', GRENADE: 'KeyG',
  /** Weapon package: 1 = 주무기 I, 2 = 주무기 II, 3 = 보조무기. (이전 무기 was V; V is 구르기 since 2026-09-07.) */
  PRIMARY: 'Digit1', PRIMARY2: 'Digit2', SECONDARY: 'Digit3',
  INVENTORY: 'Tab', ROTATE_ITEM: 'KeyR', MENU: 'Escape', MAP: 'KeyM',
  /* X drops the hovered/selected inventory item; Enter opens text chat. */
  DROP_ITEM: 'KeyX', CHAT: 'Enter',
  /* Phase 2: quick use (tap: last item in hand, hold: wheel) — moved from F to T by the tactical kit.
     Space respawns when allowed / gives up while downed (hold); both follow JUMP when rebound. */
  QUICK: 'KeyT', RESPAWN: 'Space', GIVE_UP: 'Space',
  /* Phase 3: G = ship-call wheel (same key as the legacy GRENADE binding, which follows it). */
  SHIP_CALL: 'KeyG',
  /* tactical kit */
  IMPLANT: 'KeyQ', MELEE: 'KeyF', THROW_MODE: 'KeyB',
  /* Phase 10: 들쳐메기 follows MELEE (see KEY_ALIASES); H (STIM) is retired — 회복약 is a quick-use item now. */
  CARRY: 'KeyF',
  /* mouse actions (rebindable to other mouse buttons only) */
  FIRE: 'Mouse0', AIM: 'Mouse2', PING: 'Mouse1',
  /* dev console */
  CONSOLE: 'Backquote', MOVE_CHEAT: 'Home',
  /* Phase 11: 분대 초대 수락 (홀드). The P character-sheet shortcut is gone — 캐릭터 is a Tab-screen tab. */
  INVITE: 'KeyP',
  /* 2026-09-07 (커서 rework): Alt = 커서 표시 / 숨기기. 구르기 moved off Alt onto V.
     2026-09-10: Alt 커서 제거 — 값은 남지만 `KEY_ACTION_DEFS` 에 없어 아무 데도 걸리지 않는다. */
  CURSOR: 'AltLeft',
  /* 2026-09-09: 의사소통 휠. 은퇴한 STIM 과 같은 H 를 쓴다 — 그 키는 아무 데도 안 걸려 있었다. */
  COMMS: 'KeyH',
  /* 2026-09-12: 어깨 전환. X 는 인벤토리(DROP_ITEM) · 시설 관리(회수)에서도 쓰지만 그 둘은 커서 화면이라 범위가 겹치지 않는다. */
  SHOULDER: 'KeyX',
  /* 2026-09-17: `]` = 튜토리얼 조작 가이드 숨김 / 표시. 시설 관리 모드의 `]`(가구 넘기기, 고정 키 — `hub/HousingMode`)는 커서 화면이라 범위가 겹치지 않는다. */
  GUIDE_TOGGLE: 'BracketRight',
};

/**
 * Live key bindings (KeyboardEvent.code / `MouseN`). **Mutable**: `shared/Keybinds.ts` overwrites entries from
 * localStorage at startup and when the player rebinds. Always read `Keys.X` at use time, never cache it in a
 * module-level constant (labels included — use `keyLabel(Keys.X)`).
 */
export const Keys: KeyBindings = { ...DEFAULT_KEYS };

/** `'Mouse2'` → 2; anything that is not a mouse code → `fallback`. */
export function mouseButtonOf(code: string, fallback = -1): number {
  if (typeof code !== 'string' || !code.startsWith('Mouse')) return fallback;
  const n = Number(code.slice(5));
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : fallback;
}

/**
 * Mouse buttons (MouseEvent.button) of the three mouse actions, derived live from `Keys.FIRE / PING / AIM`
 * (those may only ever be rebound to other mouse buttons). −1 (never pressed) if a binding is not a mouse code.
 */
export const MouseButtons = {
  get FIRE(): number { return mouseButtonOf(Keys.FIRE); },
  get PING(): number { return mouseButtonOf(Keys.PING); },
  get AIM(): number { return mouseButtonOf(Keys.AIM); },
};

/* ── appended: pings v2 / chat / pickups / hub ── */
/** Middle-mouse drag distance (px, pointer-locked movement) that turns a click into a directional ping. */
export const PING_DRAG_THRESHOLD_PX = K.num('PING_DRAG_THRESHOLD_PX');
/** Max seconds the middle button may be held before the gesture is treated as a plain ping. */
export const PING_HOLD_MAX = K.num('PING_HOLD_MAX');
/** Chat log lines kept. */
export const CHAT_MAX_LINES = K.num('CHAT_MAX_LINES');
/** Seconds a dropped item pickup stays in the world (0 = forever). */
export const PICKUP_LIFETIME = K.num('PICKUP_LIFETIME');
/** Max simultaneous pickups per mission (oldest removed). */
export const PICKUP_MAX = K.num('PICKUP_MAX');
/** Seconds between "everyone boarded" and mission launch in the hub. */
export const HUB_LAUNCH_COUNTDOWN = K.num('HUB_LAUNCH_COUNTDOWN');
/** Docking cutscene length (s). */
export const HUB_DOCKING_DURATION = K.num('HUB_DOCKING_DURATION');
/* appended (2026-09-15): 분대 · 도킹 매칭 */
/** Seconds of the right-side countdown a squad member sees after the leader docked, before their own fade → docking cutscene. */
export const HUB_SQUAD_DOCK_COUNTDOWN_S = K.num('HUB_SQUAD_DOCK_COUNTDOWN_S');
/** Fade-out before, and fade-in after the start of, a docking cutscene into the shared ship (s). */
export const HUB_DOCK_FADE_S = K.num('HUB_DOCK_FADE_S');

/* ── appended: weapon package (2026-09-05) ── */
import type { SocketSlot, AmmoType, Rarity, WeaponClass } from './types';
/** Durability lost per trigger pull (shotgun pellets count once). */
export const WEAPON_DURABILITY_PER_SHOT = K.num('WEAPON_DURABILITY_PER_SHOT');
/** Fallback `WeaponDef.maxDurability`. */
export const WEAPON_DEFAULT_DURABILITY = K.num('WEAPON_DEFAULT_DURABILITY');
/** Holster + draw time when swapping to a primary / secondary (s). */
export const WEAPON_SWAP_TIME_PRIMARY = K.num('WEAPON_SWAP_TIME_PRIMARY');
export const WEAPON_SWAP_TIME_SECONDARY = K.num('WEAPON_SWAP_TIME_SECONDARY');
/** Aim-in time (s) for primaries; secondaries use half. Stocks multiply it. */
export const WEAPON_ADS_TIME = K.num('WEAPON_ADS_TIME');
/** Per grade above I: damage +12 %, max durability +25 %. */
export const WEAPON_GRADE_DAMAGE_STEP = K.num('WEAPON_GRADE_DAMAGE_STEP');
export const WEAPON_GRADE_DURABILITY_STEP = K.num('WEAPON_GRADE_DURABILITY_STEP');
export const WEAPON_GRADE_ROMAN: readonly string[] = ['I', 'II', 'III', 'IV', 'V'];
export const SOCKET_SLOTS: readonly SocketSlot[] = ['muzzle', 'grip', 'mag', 'stock', 'sight'];
export const SOCKET_LABEL_KO: Readonly<Record<SocketSlot, string>> = {
  muzzle: '총구', grip: '그립', mag: '탄창', stock: '개머리판', sight: '조준경',
};
/** Calibre per weapon class (v2 ammo). */
export const AMMO_FOR_CLASS: Readonly<Record<WeaponClass, AmmoType>> = {
  SMG: 'light', PISTOL: 'light', AR: 'medium', SR: 'heavy', DMR: 'heavy', SG: 'shell',
};
/** Rounds per ammo stack (`ItemDef.stackMax` of ammo items). */
export const AMMO_STACK_ROUNDS: Readonly<Record<AmmoType, number>> = numberMap<AmmoType>('tables.csv', 'AMMO_STACK_ROUNDS');
/** Bag grid with no backpack equipped (half of a common bag). `INVENTORY_COLS × INVENTORY_ROWS` is the legendary bag. */
export const BAG_DEFAULT_COLS = K.num('BAG_DEFAULT_COLS');
export const BAG_DEFAULT_ROWS = K.num('BAG_DEFAULT_ROWS');
export const BAG_DEFAULT_QUICK_SLOTS = K.num('BAG_DEFAULT_QUICK_SLOTS');
/** Repair: 1 폐금속 per REPAIR_SCRAP_PER durability missing (rounded up); grade ≥ III also needs 1 합금 판 per REPAIR_ALLOY_PER. */
export const REPAIR_SCRAP_PER = K.num('REPAIR_SCRAP_PER');
export const REPAIR_ALLOY_PER = K.num('REPAIR_ALLOY_PER');

/* ── appended: Phase 2 — down / revive / respawn ── */
/** Separate health pool while 전투불능. */
export const PLAYER_DOWN_HP = K.num('PLAYER_DOWN_HP');
/** Bleed per second while downed. */
export const PLAYER_DOWN_BLEED_PER_SEC = K.num('PLAYER_DOWN_BLEED_PER_SEC');
/** Crawl speed multiplier on top of PLAYER_PRONE_SPEED while downed. */
export const PLAYER_DOWN_SPEED_MUL = K.num('PLAYER_DOWN_SPEED_MUL');
/** Teammate hold (s) and range (m) to revive; hp after a revive. */
export const PLAYER_REVIVE_HOLD = K.num('PLAYER_REVIVE_HOLD');
export const PLAYER_REVIVE_RANGE = K.num('PLAYER_REVIVE_RANGE');
export const PLAYER_REVIVE_HP = K.num('PLAYER_REVIVE_HP');
/** Seconds after death until the respawn (hellpod at the mission start point) is allowed. */
export const PLAYER_RESPAWN_DELAY = K.num('PLAYER_RESPAWN_DELAY');
/** Holding Space this long while downed gives up (immediate death → respawn timer). */
export const PLAYER_GIVE_UP_HOLD = K.num('PLAYER_GIVE_UP_HOLD');

/* ── appended: Phase 2 — quick-use wheel / grenade cooking ── */
export const QUICK_SLOTS = K.num('QUICK_SLOTS');
/** Wheel directions by slot index. */
export const QUICK_SLOT_DIRS: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const QUICK_SLOT_LABEL_KO: readonly string[] = ['위', '오른쪽 위', '오른쪽', '오른쪽 아래', '아래', '왼쪽 아래', '왼쪽', '왼쪽 위'];
/** Item categories that can sit in a wheel slot. */
/** 2026-09-15: `'grenade'` 폐지 — 수류탄 2종도 `category: 'gadget'` 이라 이 목록이 그대로 덮는다. */
export const QUICK_USABLE_CATEGORIES: readonly string[] = ['stim', 'gadget'];
/**
 * Which wheel slots a bag with `n` quick slots unlocks: the first `n` entries of this order (N, S, E, W, then the
 * diagonals), so a 2-slot bag gives up/down rather than up/up-right. Use `isQuickSlotActive`.
 */
export const QUICK_SLOT_UNLOCK_ORDER: readonly number[] = numberList('tables.csv', 'QUICK_SLOT_UNLOCK_ORDER');
export function isQuickSlotActive(index: number, count: number): boolean {
  const rank = QUICK_SLOT_UNLOCK_ORDER.indexOf(index);
  return rank >= 0 && rank < Math.max(0, Math.min(QUICK_SLOTS, count));
}
/** F held longer than this opens the wheel; shorter = re-equip the last quick item. */
export const QUICK_WHEEL_HOLD = K.num('QUICK_WHEEL_HOLD');
/** Pointer-locked mouse travel (px) needed before a wheel direction counts. */
export const QUICK_WHEEL_DRAG_PX = K.num('QUICK_WHEEL_DRAG_PX');
/** Fuse after the pin is pulled; a grenade cooked this long explodes in the hand. */
export const GRENADE_FUSE = K.num('GRENADE_FUSE');
export const GRENADE_COOK_MAX = K.num('GRENADE_COOK_MAX');
/** Underhand toss speed multiplier. */
export const GRENADE_UNDERHAND_SPEED_MUL = K.num('GRENADE_UNDERHAND_SPEED_MUL');
/** 2026-09-09: throw ballistics moved out of weapons/model.ts so progression can quote the range in metres. */
export const GRENADE_THROW_SPEED = K.num('GRENADE_THROW_SPEED');
export const GRENADE_THROW_LIFT = K.num('GRENADE_THROW_LIFT');
export const GRENADE_UNDERHAND_LIFT = K.num('GRENADE_UNDERHAND_LIFT');
/**
 * G-12 고폭 수류탄의 반경(m) · 중심 피해 · 플레이어 몫 (2026-09-15, 사용자 결정 — 반경 6 → 7.2 = ×1.2).
 * 2026-09-15 까지 `weapons/Grenade.ts` 에 박혀 있던 세 숫자다; 같은 이름이 `@/weapons` 배럴로도 계속 나간다.
 * 감쇠는 `shared/explosion.ts` 의 2단 계단 — 반경을 고쳐도 「가까우면 100 %」 구간이 함께 자란다.
 */
export const GRENADE_RADIUS = K.num('GRENADE_RADIUS');
export const GRENADE_DAMAGE = K.num('GRENADE_DAMAGE');
/** 수류탄 폭발이 플레이어에게 주는 몫 (내 것도 분대원 것의 복제도 같다). 적 · 드론에는 안 곱한다. */
export const GRENADE_PLAYER_DAMAGE_MUL = K.num('GRENADE_PLAYER_DAMAGE_MUL');
/**
 * **폭발 감쇠 2단 계단** (2026-09-15, 사용자 결정) — 수식은 `shared/explosion.ts` 하나다.
 * `0 … FULL_FRACTION × radius` = 100 %, 거기서 `radius` 까지 = `OUTER_MUL`(거리 무관 고정), 밖은 0.
 */
export const EXPLOSION_FULL_FRACTION = K.num('EXPLOSION_FULL_FRACTION');
export const EXPLOSION_OUTER_MUL = K.num('EXPLOSION_OUTER_MUL');
/** 2026-09-18 (사용자 결정): 폭발 · 근접 차폐 — 몸 3점 높이 · 폭심 들어올림 · 끝점 여유. 판정은 `shared/explosion.ts`. */
export const BLAST_LOS_FEET_M = K.num('BLAST_LOS_FEET_M');
export const BLAST_LOS_CHEST_FRAC = K.num('BLAST_LOS_CHEST_FRAC');
export const BLAST_LOS_HEAD_FRAC = K.num('BLAST_LOS_HEAD_FRAC');
export const BLAST_LOS_LIFT_M = K.num('BLAST_LOS_LIFT_M');
export const BLAST_LOS_SLACK_M = K.num('BLAST_LOS_SLACK_M');
export const MELEE_LOS_SLACK_M = K.num('MELEE_LOS_SLACK_M');
/** 투척 거리 배율 (2026-09-09): linear from THROW_RANGE_MUL_MIN at STAT_MIN 근력 to THROW_RANGE_MUL_MAX at STAT_MAX. */
export const THROW_RANGE_MUL_MIN = K.num('THROW_RANGE_MUL_MIN');
export const THROW_RANGE_MUL_MAX = K.num('THROW_RANGE_MUL_MAX');

/* ── appended: Phase 3 — ship calls / stratagems ── */
import type { StratagemId } from './types';
export interface StratagemDef {
  id: StratagemId;
  name: string;
  /** Shared cooldown this call starts (s). */
  cooldown: number;
  /** Seconds between confirmation and the effect. */
  delay: number;
  /** `topview`: LMB charge → top-down camera cursor. `ground`: aim-ray ring from the current view. */
  targeting: 'topview' | 'ground';
  /** Effect radius shown by the targeting ring (m). */
  radius: number;
  /** Short HUD description. */
  hint: string;
}
export const STRATAGEM_DEFS: readonly StratagemDef[] = csvRows('stratagems.csv').map((r) => ({
  id: r.str('id') as StratagemId,
  name: r.str('name'),
  cooldown: r.num('cooldown', { min: 0 }),
  delay: r.num('delay', { min: 0 }),
  targeting: r.enum('targeting', ['topview', 'ground'] as const),
  radius: r.num('radius', { min: 0 }),
  hint: r.str('hint'),
}));
/**
 * G 휠에 뜨는 목록과 순서 — **4방위 고정**(N/E/S/W)이라 항목은 정확히 4개다.
 * 2026-09-09: `airstrike` 를 휠에서 내리고 `rescue_drop` 을 올렸다. 항공 폭탄의 정의(csv 줄)와
 * 구현(`stratagems/parts/Calls`)은 남아 있지만 어디서도 무장되지 않는다 — 계약은 지우지 않고 목록만 바꾼다.
 */
export const STRATAGEM_ORDER: readonly StratagemId[] = ['orbital_laser', 'supply_drop', 'structure_drop', 'rescue_drop'];
/** 멀티에서 **호스트만** 무장할 수 있는 호출. 나머지는 아무나 쓴다. */
export const STRATAGEM_HOST_ONLY: readonly StratagemId[] = ['orbital_laser', 'airstrike'];
/** G held longer than this opens the wheel; a tap re-arms the last call. */
export const STRATAGEM_WHEEL_HOLD = K.num('STRATAGEM_WHEEL_HOLD');
/** LMB hold (s) before an orbital call switches to the top view. */
export const STRATAGEM_CHARGE_TIME = K.num('STRATAGEM_CHARGE_TIME');
/** Top view: camera height above the player (m) and max cursor distance from the player (m). */
export const TOPVIEW_HEIGHT = K.num('TOPVIEW_HEIGHT');
export const TOPVIEW_RANGE = K.num('TOPVIEW_RANGE');
/** Pointer-locked mouse pixels → metres of cursor travel in the top view. */
export const TOPVIEW_CURSOR_SPEED = K.num('TOPVIEW_CURSOR_SPEED');
/** Ground targeting (drops): max distance of the aim-ray hit from the player (m). */
export const GROUND_TARGET_RANGE = K.num('GROUND_TARGET_RANGE');
/** Orbital laser: beam duration (s), damage radius (m), damage per second. */
export const LASER_DURATION = K.num('LASER_DURATION');
export const LASER_RADIUS = K.num('LASER_RADIUS');
export const LASER_DPS = K.num('LASER_DPS');
/** Airstrike: explosion radius (m) and damage at the centre (감쇠는 `shared/explosion` 2단 계단). */
export const AIRSTRIKE_RADIUS = K.num('AIRSTRIKE_RADIUS');
export const AIRSTRIKE_DAMAGE = K.num('AIRSTRIKE_DAMAGE');
/** Supply crate: fall time (s), impact damage radius (m) / damage, loot tier (see items LOOT_TABLES), lifetime after landing (s). */
export const SUPPLY_FALL_TIME = K.num('SUPPLY_FALL_TIME');
export const SUPPLY_IMPACT_RADIUS = K.num('SUPPLY_IMPACT_RADIUS');
export const SUPPLY_IMPACT_DAMAGE = K.num('SUPPLY_IMPACT_DAMAGE');
export const SUPPLY_CRATE_TIER = K.num('SUPPLY_CRATE_TIER');
/** Structures: count, hp, scatter radius around the target (m), impact damage radius / damage, fall time (s). */
export const STRUCTURE_COUNT = K.num('STRUCTURE_COUNT');
export const STRUCTURE_HP = K.num('STRUCTURE_HP');
export const STRUCTURE_SCATTER = K.num('STRUCTURE_SCATTER');
export const STRUCTURE_IMPACT_RADIUS = K.num('STRUCTURE_IMPACT_RADIUS');
export const STRUCTURE_IMPACT_DAMAGE = K.num('STRUCTURE_IMPACT_DAMAGE');
export const STRUCTURE_FALL_TIME = K.num('STRUCTURE_FALL_TIME');
/** Off-screen indicators: squadmate pings show an edge arrow for this many seconds after placement. */
export const OFFSCREEN_PING_SECONDS = K.num('OFFSCREEN_PING_SECONDS');

/* ── appended: Phase 4 — rogues / enemy gimmicks / corpses ── */
/** Seconds a lootable corpse (and its interactable) stays in the world. */
export const CORPSE_LIFETIME = K.num('CORPSE_LIFETIME');
/** Corpse interaction radius (m). */
export const CORPSE_INTERACT_RADIUS = K.num('CORPSE_INTERACT_RADIUS');
/* appended (2026-09-16): 빈 시체 제거 (owner: game/Corpses · enemies/parts/CorpseEmpty · world/tutorial/parts/Corpses) */
/** 아이템이 하나도 남지 않은 시체가 비고 나서 가라앉기 시작할 때까지(초). 적 시체는 **열어서 비운** 것만. */
export const CORPSE_EMPTY_REMOVE_DELAY_S = K.num('CORPSE_EMPTY_REMOVE_DELAY_S');
/** 빈 시체가 땅으로 가라앉는 시간(초). 끝나면 상호작용 · 빛기둥 · 메시가 함께 사라진다. */
export const CORPSE_EMPTY_SINK_S = K.num('CORPSE_EMPTY_SINK_S');
/** 플레이어 · 안드로이드 · 튜토리얼 시체가 가라앉는 깊이(m). 적 리그는 자기 시체 가라앉기 깊이(`anim.fade`)를 쓴다. */
export const CORPSE_EMPTY_SINK_DEPTH_M = K.num('CORPSE_EMPTY_SINK_DEPTH_M');
/** 호스트 가드: `ecorpseq emptied` 를 보낸 사람의 스냅샷과 적 시체의 수평 거리 상한(m). */
export const CORPSE_EMPTY_REQUEST_REACH_M = K.num('CORPSE_EMPTY_REQUEST_REACH_M');
/** 호스트 가드: 한 사람이 초당 보낼 수 있는 빈 적 시체 요청 수 · 버킷 크기. */
export const CORPSE_EMPTY_REQUEST_RATE_MAX = K.num('CORPSE_EMPTY_REQUEST_RATE_MAX');
export const CORPSE_EMPTY_REQUEST_BURST = K.num('CORPSE_EMPTY_REQUEST_BURST');
/** Rogue gunner: reaction delay before the first shot (s), aim error (radians) at hip / after settling, damage per hit, rounds per burst. */
export const ROGUE_REACTION = K.num('ROGUE_REACTION');
export const ROGUE_AIM_ERROR = K.num('ROGUE_AIM_ERROR');
export const ROGUE_AIM_ERROR_SETTLED = K.num('ROGUE_AIM_ERROR_SETTLED');
export const ROGUE_DAMAGE = K.num('ROGUE_DAMAGE');
export const ROGUE_BURST = K.num('ROGUE_BURST');
/** Rogue engagement range (m) and the "rush the player" impulse chance per cover cycle. */
export const ROGUE_RANGE = K.num('ROGUE_RANGE');
export const ROGUE_RUSH_CHANCE = K.num('ROGUE_RUSH_CHANCE');
/** Boss rogue multipliers and escort count. */
export const ROGUE_BOSS_SCALE = K.num('ROGUE_BOSS_SCALE');
export const ROGUE_BOSS_HP_MUL = K.num('ROGUE_BOSS_HP_MUL');
export const ROGUE_BOSS_ESCORTS = K.num('ROGUE_BOSS_ESCORTS');
/** Artillery bug: preferred stand-off range (m), shell flight time (s), blast radius (m) / damage, shell hit radius for interception (m). */
export const ARTILLERY_RANGE = K.num('ARTILLERY_RANGE');
export const SHELL_FLIGHT_TIME = K.num('SHELL_FLIGHT_TIME');
export const SHELL_BLAST_RADIUS = K.num('SHELL_BLAST_RADIUS');
/** 2026-09-10: 포탄 궤적 전용 유효 중력 — 실제 `GRAVITY` 가 아니다 (`shared/ballistics`). */
export const SHELL_ARC_GRAVITY = K.num('SHELL_ARC_GRAVITY');
export const SHELL_DAMAGE = K.num('SHELL_DAMAGE');
export const SHELL_RADIUS = K.num('SHELL_RADIUS');
/** 2026-09-09: max distance (m) a shell leads a moving target by — keeps a 6.3 s shell dodgeable. */
export const SHELL_LEAD_MAX = K.num('SHELL_LEAD_MAX');
/** Toxic bug: burst radius (m), damage (players and enemies alike), trigger distance (m). */
export const TOXIC_RADIUS = K.num('TOXIC_RADIUS');
export const TOXIC_DAMAGE = K.num('TOXIC_DAMAGE');
export const TOXIC_TRIGGER_DIST = K.num('TOXIC_TRIGGER_DIST');
/** Behemoth: scale vs a warrior, charge speed (m/s), charge damage, knockback speed (m/s), wind-up (s). */
export const BEHEMOTH_SCALE = K.num('BEHEMOTH_SCALE');   // Phase 7: 4 → 3 (the 6.4 m body stumbled on most obstacles while charging)
export const BEHEMOTH_CHARGE_SPEED = K.num('BEHEMOTH_CHARGE_SPEED');
export const BEHEMOTH_CHARGE_DAMAGE = K.num('BEHEMOTH_CHARGE_DAMAGE');
export const BEHEMOTH_KNOCKBACK = K.num('BEHEMOTH_KNOCKBACK');
export const BEHEMOTH_WINDUP = K.num('BEHEMOTH_WINDUP');
/** Ammo calibres that bounce off armour plate (`EnemyHit.armored`). */
export const ARMOR_IMMUNE_AMMO: readonly string[] = stringList('tables.csv', 'ARMOR_IMMUNE_AMMO');

/* ── appended: tactical kit (implants, gadgets, melee, gear, progression; merged 2026-09-06) ── */
/* 2026-09-11 (C-8): the deprecated `KEY_IMPLANT` / `KEY_MELEE` / `KEY_THROW_MODE` defaults were removed — nothing
 * read them, and they are neither saved nor on the wire. Read `Keys.IMPLANT` / `Keys.MELEE` / `Keys.THROW_MODE`. */

/* ── melee ── */
export const MELEE_DAMAGE = K.num('MELEE_DAMAGE');
export const MELEE_RANGE = K.num('MELEE_RANGE');
export const MELEE_STAMINA_COST = K.num('MELEE_STAMINA_COST');
export const MELEE_COOLDOWN = K.num('MELEE_COOLDOWN');
/** Weapons whose stock adds melee damage list a multiplier; this is the default for everything else. */
export const MELEE_STOCK_MUL_DEFAULT = K.num('MELEE_STOCK_MUL_DEFAULT');

/* ── roll (구르기, replaced the dive; on V since the 2026-09-07 커서 rework moved Alt to the cursor) ── */
export const ROLL_DURATION = K.num('ROLL_DURATION');
export const ROLL_DISTANCE = K.num('ROLL_DISTANCE');
export const ROLL_STAMINA_COST = K.num('ROLL_STAMINA_COST');
export const ROLL_COOLDOWN = K.num('ROLL_COOLDOWN');
/** Damage taken during the roll is multiplied by this (small i-frame substitute). */
export const ROLL_DAMAGE_MUL = K.num('ROLL_DAMAGE_MUL');

/* ── weight ── */
export const WEIGHT_BASE_CAPACITY = K.num('WEIGHT_BASE_CAPACITY');        // kg at strength 0
export const WEIGHT_PER_STRENGTH = K.num('WEIGHT_PER_STRENGTH');        // kg per 근력 point
export const WEIGHT_LIGHT_RATIO = K.num('WEIGHT_LIGHT_RATIO');         // 조금 무거움
export const WEIGHT_HEAVY_RATIO = K.num('WEIGHT_HEAVY_RATIO');         // 무거움
export const WEIGHT_OVER_RATIO = K.num('WEIGHT_OVER_RATIO');          // 과적
export const WEIGHT_LIGHT_STAMINA_MUL = K.num('WEIGHT_LIGHT_STAMINA_MUL');   // -30 % stamina regen
export const WEIGHT_HEAVY_STAMINA_MUL = K.num('WEIGHT_HEAVY_STAMINA_MUL');   // -50 % stamina regen
export const WEIGHT_HEAVY_MOVE_MUL = K.num('WEIGHT_HEAVY_MOVE_MUL');
export const WEIGHT_STATE_LABEL_KO: Record<string, string> = {
  normal: '보통', light: '조금 무거움', heavy: '무거움', over: '과적',
};

/* ── detection (감지 시스템) ── */
export const DETECT_BASE_RADIUS = K.num('DETECT_BASE_RADIUS');          // interactable highlight radius at 인지력 0
export const DETECT_PER_PERCEPTION = K.num('DETECT_PER_PERCEPTION');      // + meters per 인지력 point
export const DETECT_ENEMY_BASE_RADIUS = K.num('DETECT_ENEMY_BASE_RADIUS');    // off-screen enemy arrow radius
export const DETECT_ENEMY_PER_PERCEPTION = K.num('DETECT_ENEMY_PER_PERCEPTION');
/** Fresnel highlight colour for interactables / revealed objects. */
export const DETECT_HIGHLIGHT_COLOR = K.num('DETECT_HIGHLIGHT_COLOR');
export const DETECT_ENEMY_COLOR = K.num('DETECT_ENEMY_COLOR');

/* ── tactical implants ── */
export const IMPLANT_GRAPPLE_RANGE = K.num('IMPLANT_GRAPPLE_RANGE');
export const IMPLANT_GRAPPLE_SPEED = K.num('IMPLANT_GRAPPLE_SPEED');       // pull speed (m/s)
export const IMPLANT_GRAPPLE_COOLDOWN = K.num('IMPLANT_GRAPPLE_COOLDOWN');
export const IMPLANT_DASH_CHARGES = K.num('IMPLANT_DASH_CHARGES');
export const IMPLANT_DASH_DISTANCE = K.num('IMPLANT_DASH_DISTANCE');
export const IMPLANT_DASH_COOLDOWN = K.num('IMPLANT_DASH_COOLDOWN');        // per charge
/**
 * 2026-09-14 (owner: implants/parts/Devices.castDash) 대시는 앞을 레이 하나로 자르지 않고 몸을 걸음처럼 밀어 본다 —
 * 한 걸음 `SWEEP_STEP` m, 밀려난 뒤 진행이 걸음의 `SLIDE_MIN` 배 미만이면 막힘, 지형 오르막이 `MAX_SLOPE_DEG` 보다 가파르면 막힘.
 */
export const IMPLANT_DASH_SWEEP_STEP = K.num('IMPLANT_DASH_SWEEP_STEP');
export const IMPLANT_DASH_SLIDE_MIN = K.num('IMPLANT_DASH_SLIDE_MIN');
export const IMPLANT_DASH_MAX_SLOPE_DEG = K.num('IMPLANT_DASH_MAX_SLOPE_DEG');
export const IMPLANT_BARRIER_HP = K.num('IMPLANT_BARRIER_HP');
export const IMPLANT_BARRIER_WIDTH = K.num('IMPLANT_BARRIER_WIDTH');
export const IMPLANT_BARRIER_HEIGHT = K.num('IMPLANT_BARRIER_HEIGHT');
/** Shield hp regenerated per second while it is stowed. */
export const IMPLANT_BARRIER_REGEN = K.num('IMPLANT_BARRIER_REGEN');
/** After the shield collapses it is locked for this long; its hp regenerates from 0 to full over exactly this window (HUD gauge). */
export const IMPLANT_BARRIER_BREAK_LOCKOUT = K.num('IMPLANT_BARRIER_BREAK_LOCKOUT');
export const IMPLANT_OVERCHARGE_RANGE = K.num('IMPLANT_OVERCHARGE_RANGE');
/** @deprecated legacy beam rate; the hold-to-channel overcharge uses SELF / ALLY rates below. */
export const IMPLANT_OVERCHARGE_HEAL_PER_SEC = K.num('IMPLANT_OVERCHARGE_HEAL_PER_SEC');
/** Overcharge (hold Q): slow self heal, faster heal on the ally under the crosshair. */
export const IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC = K.num('IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC');
export const IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC = K.num('IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC');
/** Energy = seconds of continuous channelling; refills from empty in IMPLANT_OVERCHARGE_REGEN_TIME while released. */
export const IMPLANT_OVERCHARGE_ENERGY = K.num('IMPLANT_OVERCHARGE_ENERGY');
export const IMPLANT_OVERCHARGE_REGEN_TIME = K.num('IMPLANT_OVERCHARGE_REGEN_TIME');
/** Speed / fire-rate buff applies while channelling only when the target's hp is at least this ratio. */
export const IMPLANT_OVERCHARGE_BUFF_HP_RATIO = K.num('IMPLANT_OVERCHARGE_BUFF_HP_RATIO');
export const IMPLANT_OVERCHARGE_SPEED_MUL = K.num('IMPLANT_OVERCHARGE_SPEED_MUL');
export const IMPLANT_OVERCHARGE_FIRERATE_MUL = K.num('IMPLANT_OVERCHARGE_FIRERATE_MUL');
export const IMPLANT_OVERCHARGE_DURATION = K.num('IMPLANT_OVERCHARGE_DURATION');  // buff lingers this long after the beam breaks
export const IMPLANT_SCAN_PULSE_INTERVAL = K.num('IMPLANT_SCAN_PULSE_INTERVAL');
export const IMPLANT_SCAN_MAX_PULSES = K.num('IMPLANT_SCAN_MAX_PULSES');
export const IMPLANT_SCAN_RADIUS_STEP = K.num('IMPLANT_SCAN_RADIUS_STEP');    // radius grows by this per pulse
export const IMPLANT_SCAN_REVEAL_TIME = K.num('IMPLANT_SCAN_REVEAL_TIME');
export const IMPLANT_SCAN_COOLDOWN = K.num('IMPLANT_SCAN_COOLDOWN');
export const IMPLANT_AT_DAMAGE = K.num('IMPLANT_AT_DAMAGE');
export const IMPLANT_AT_RADIUS = K.num('IMPLANT_AT_RADIUS');
export const IMPLANT_AT_SPEED = K.num('IMPLANT_AT_SPEED');
export const IMPLANT_AT_COOLDOWN = K.num('IMPLANT_AT_COOLDOWN');

/* ── gadgets ── */
export const GADGET_CLOAK_DURATION = K.num('GADGET_CLOAK_DURATION');
export const GADGET_CLOAK_SHARE_RADIUS = K.num('GADGET_CLOAK_SHARE_RADIUS');
export const GADGET_DOME_HP = K.num('GADGET_DOME_HP');
export const GADGET_DOME_RADIUS = K.num('GADGET_DOME_RADIUS');
export const GADGET_BARRICADE_HP = K.num('GADGET_BARRICADE_HP');
export const GADGET_BARRICADE_RECOVER_TIME = K.num('GADGET_BARRICADE_RECOVER_TIME');
export const GADGET_LURE_DURATION = K.num('GADGET_LURE_DURATION');
export const GADGET_LURE_RADIUS = K.num('GADGET_LURE_RADIUS');
export const GADGET_SMOKE_DURATION = K.num('GADGET_SMOKE_DURATION');
export const GADGET_SMOKE_RADIUS = K.num('GADGET_SMOKE_RADIUS');
export const GADGET_MINE_ARM_TIME = K.num('GADGET_MINE_ARM_TIME');
export const GADGET_MINE_RADIUS = K.num('GADGET_MINE_RADIUS');
export const GADGET_MINE_DAMAGE = K.num('GADGET_MINE_DAMAGE');
export const GADGET_TURRET_HP = K.num('GADGET_TURRET_HP');
export const GADGET_TURRET_RANGE = K.num('GADGET_TURRET_RANGE');
export const GADGET_TURRET_DPS = K.num('GADGET_TURRET_DPS');
export const GADGET_TURRET_DURATION = K.num('GADGET_TURRET_DURATION');
/* ── appended: 2026-09-15 (가젯 개편 · 제세동기 조준 · 독성 포자, 사용자 결정) ── */
/** 준비된 제세동기가 쓰러진 아군을 「겨눴다」고 보는 크로스헤어 반각(°) — `gadget:defibAim.target` 의 기준. */
export const DEFIB_AIM_CONE_DEG = K.num('DEFIB_AIM_CONE_DEG');
/** 돔 실드 중앙 개체를 꾹 눌러 회수하는 시간(초). */
export const GADGET_DOME_RECOVER_TIME = K.num('GADGET_DOME_RECOVER_TIME');
/** 1 이면 독성 포자 재해 피해가 실드를 건너뛴다 (`PlayerRef.takeDamage` 의 `opts.bypassShield`). */
export const HAZARD_SPORES_BYPASS_SHIELD = K.num('HAZARD_SPORES_BYPASS_SHIELD') > 0;
/* 2026-09-15 2차 (화염 통합, 사용자 결정): `GADGET_INCENDIARY_RADIUS`(5) · `GADGET_INCENDIARY_DURATION`(10) 은퇴 —
   화염 지대를 만드는 정의가 하나가 되면서 살아남은 수치는 `GRENADE_INCENDIARY_*`(3.5 m · 6 s)다. 초당 피해
   `GADGET_INCENDIARY_DPS` 는 그대로 쓴다(지대 전체의 값이라 통합과 무관하다). */
export const GADGET_INCENDIARY_DPS = K.num('GADGET_INCENDIARY_DPS');
export const GADGET_JUMPPAD_IMPULSE = K.num('GADGET_JUMPPAD_IMPULSE');
export const GADGET_JUMPPAD_FORWARD = K.num('GADGET_JUMPPAD_FORWARD');
/** Hold time (s) to defuse a mine / recover a turret, jump pad or barricade. */
export const GADGET_DEFUSE_TIME = K.num('GADGET_DEFUSE_TIME');
/* 2026-09-09: 아래 여섯 개는 `gadgets/GadgetDefs.ts` 안에 리터럴로 박혀 있던 값이다 — csv 로 옮겼다. */
/** 바리케이드가 차지하는 반경(m). */
export const GADGET_BARRICADE_RADIUS = K.num('GADGET_BARRICADE_RADIUS');
/** 유인 수류탄 비콘 / 지뢰 / 점프대의 내구도 (쏘면 부서진다). */
export const GADGET_LURE_HP = K.num('GADGET_LURE_HP');
export const GADGET_MINE_HP = K.num('GADGET_MINE_HP');
export const GADGET_JUMPPAD_HP = K.num('GADGET_JUMPPAD_HP');
/** 제세동기가 닿는 거리(m)와 점프대 발동 반경(m). */
export const GADGET_DEFIB_RANGE = K.num('GADGET_DEFIB_RANGE');
export const GADGET_JUMPPAD_RADIUS = K.num('GADGET_JUMPPAD_RADIUS');

/* ── stealth / cloak ── */
/** Enemy detection range is multiplied by this while the target is cloaked and behaving. */
export const CLOAK_DETECT_MUL = K.num('CLOAK_DETECT_MUL');
/** Cloak breaks for this long after firing / sprinting near an alerted enemy. */
export const CLOAK_BREAK_TIME = K.num('CLOAK_BREAK_TIME');
/** Distance (m) at which an alerted enemy sees a cloaked target regardless. */
export const CLOAK_REVEAL_DISTANCE = K.num('CLOAK_REVEAL_DISTANCE');

/* ── armor / durability ── */
/** Damage reduction of numbered armor I..V. */
export const ARMOR_DR_BY_TIER: readonly number[] = numberList('tables.csv', 'ARMOR_DR_BY_TIER');
/** Armor durability lost per point of damage absorbed. */
export const ARMOR_DURABILITY_PER_DAMAGE = K.num('ARMOR_DURABILITY_PER_DAMAGE');
/** Fire-rate multiplier once a weapon is broken (durability 0) — unused while broken weapons refuse to fire. */
export const BROKEN_WEAPON_FIRERATE_MUL = K.num('BROKEN_WEAPON_FIRERATE_MUL');

/* ── gathering / crafting ── */
export const GATHER_NODES_PER_MISSION = K.num('GATHER_NODES_PER_MISSION');
export const GATHER_INTERACT_TIME = K.num('GATHER_INTERACT_TIME');
export const CRAFT_DEFAULT_TIME = K.num('CRAFT_DEFAULT_TIME');
/* appended (2026-09-08): 폐금속 공급 — 고철 노드 (`GatherNodeDef.kind === 'salvage'`) */
/** 고철 더미 nodes per mission, on top of `GATHER_NODES_PER_MISSION` plants. */
export const SALVAGE_NODES_PER_MISSION = K.num('SALVAGE_NODES_PER_MISSION');
/** Hold seconds to strip one 고철 더미 — longer than a plant (`GATHER_INTERACT_TIME`). */
export const SALVAGE_INTERACT_TIME = K.num('SALVAGE_INTERACT_TIME');

/* ── progression ── */
export const STAT_BASE = K.num('STAT_BASE');
export const STAT_MAX = K.num('STAT_MAX');
export const STAT_POINTS_PER_LEVEL = K.num('STAT_POINTS_PER_LEVEL');   // Phase 5 (2026-09-06): was 2
export const SKILL_LEVEL_MAX = K.num('SKILL_LEVEL_MAX');
export const PROFILE_STORAGE_KEY = 'scav.profile';
export const PROFILE_VERSION = 1;
/** XP needed to reach level n+1: XP_BASE * n^XP_EXPONENT. */
export const XP_BASE = K.num('XP_BASE');   // Phase 5 (2026-09-06): was 240 (plan: 120 × n^1.35)
export const XP_EXPONENT = K.num('XP_EXPONENT');
/**
 * appended (2026-09-16, owner: game): 탈출하지 못한 레이드의 처치 경험치 배율. 레이드 경험치 = Σ 처치 종류의 `enemies.csv` raidXp
 * (`MissionStats.killXp`) × (탈출 ? 1 : XP_DEATH_MUL) × 서재 배율 — `game/parts/Death.awardMissionXp`.
 */
export const XP_DEATH_MUL = K.num('XP_DEATH_MUL');

/* ── appended: key rebinding + ship stash (2026-09-06) ── */
/** localStorage key of the player's key bindings (`shared/Keybinds.ts`). */
export const KEYBINDS_STORAGE_KEY = 'scav.keybinds';
/** localStorage key of the ship stash (`inventory/Stash.ts`) and its fixed grid. */
export const STASH_STORAGE_KEY = 'scav.stash';
export const STASH_COLS = K.num('STASH_COLS');
export const STASH_ROWS = K.num('STASH_ROWS');

/* ══ appended: dev console · unique weapons · stat XP · ship housing (2026-09-06) ═══════════════════════ */

/* ── dev console (owner: console/) ── */
export const CONSOLE_HISTORY_KEY = 'scav.console.history';
export const CONSOLE_HISTORY_MAX = K.num('CONSOLE_HISTORY_MAX');
/** Output lines kept in the console log. */
export const CONSOLE_MAX_LINES = K.num('CONSOLE_MAX_LINES');
/** Suggestions shown above the input while typing. */
export const CONSOLE_SUGGESTIONS_MAX = K.num('CONSOLE_SUGGESTIONS_MAX');
/** `/movecheat 1` + Home: metres per second along the camera forward. */
export const MOVE_CHEAT_SPEED = K.num('MOVE_CHEAT_SPEED');

/* ── unique weapons (owner: items data, weapons behaviour) ── */
/** Legendary-only uniques (`WeaponDef.unique`). Item ids are `wpn_<id>` like every weapon. */
export const UNIQUE_WEAPON_IDS = ['u_flame', 'u_shock', 'u_shuriken', 'u_bow', 'u_bazooka', 'u_minigun'] as const;
export const UNIQUE_WEAPON_LABEL_KO = {
  flamethrower: '화염방사기', shockgun: '전격총', shuriken: '표창', bow: '컴포짓 보우', bazooka: '바주카', minigun: '미니건',
} as const;

/* 화염방사기: LMB wide cone, hold to damage; RMB long narrow jet. Heat stacks → 전소 (writhing, no actions). */
export const FLAME_RANGE = K.num('FLAME_RANGE');
export const FLAME_CONE_DEG = K.num('FLAME_CONE_DEG');
export const FLAME_DPS = K.num('FLAME_DPS');
export const FLAME_ALT_RANGE = K.num('FLAME_ALT_RANGE');
export const FLAME_ALT_CONE_DEG = K.num('FLAME_ALT_CONE_DEG');
export const FLAME_ALT_DPS = K.num('FLAME_ALT_DPS');
/** Fuel units (ammo `qty`) burnt per second while spraying. */
export const FLAME_FUEL_PER_SEC = K.num('FLAME_FUEL_PER_SEC');
/** Heat an enemy accumulates from flame damage before it is set 전소 (`applyStatus 'incinerated'`). */
export const BURNOUT_THRESHOLD = K.num('BURNOUT_THRESHOLD');
/** Heat lost per second when not being burnt. */
export const BURNOUT_DECAY_PER_SEC = K.num('BURNOUT_DECAY_PER_SEC');
export const BURNOUT_DURATION = K.num('BURNOUT_DURATION');
/** Residual burning applied on every flame tick (dps, seconds). */
export const FLAME_AFTERBURN_DPS = K.num('FLAME_AFTERBURN_DPS');
export const FLAME_AFTERBURN_DURATION = K.num('FLAME_AFTERBURN_DURATION');

/* 전격총: LMB chains to several nearby enemies; RMB hold to charge, release = DMR-class bolt. */
export const SHOCK_RANGE = K.num('SHOCK_RANGE');
export const SHOCK_CONE_DEG = K.num('SHOCK_CONE_DEG');
export const SHOCK_MAX_TARGETS = K.num('SHOCK_MAX_TARGETS');
export const SHOCK_DPS = K.num('SHOCK_DPS');
/** Cell units per second while the arc is on. */
export const SHOCK_CELL_PER_SEC = K.num('SHOCK_CELL_PER_SEC');
export const SHOCK_CHARGE_TIME = K.num('SHOCK_CHARGE_TIME');
/** Damage of a fully charged bolt; a partial charge scales linearly from SHOCK_CHARGE_MIN_RATIO. */
export const SHOCK_CHARGE_DAMAGE = K.num('SHOCK_CHARGE_DAMAGE');
export const SHOCK_CHARGE_MIN_RATIO = K.num('SHOCK_CHARGE_MIN_RATIO');
export const SHOCK_CHARGE_RANGE = K.num('SHOCK_CHARGE_RANGE');
/** Cells per charged bolt. */
export const SHOCK_CHARGE_CELLS = K.num('SHOCK_CHARGE_CELLS');
/** 'shocked' status: slow factor and duration applied by the arc. */
export const SHOCK_SLOW_FACTOR = K.num('SHOCK_SLOW_FACTOR');
export const SHOCK_SLOW_DURATION = K.num('SHOCK_SLOW_DURATION');
/** appended 2026-09-14 (owner: weapons): LMB with nothing to shock still throws forked arcs toward the crosshair point + a crackle. */
export const SHOCK_FIZZLE_FORKS = K.num('SHOCK_FIZZLE_FORKS');
export const SHOCK_FIZZLE_SPREAD_DEG = K.num('SHOCK_FIZZLE_SPREAD_DEG');
export const SHOCK_CRACKLE_INTERVAL = K.num('SHOCK_CRACKLE_INTERVAL');

/* 표창: LMB one, RMB fan of three. Melee: F tap = normal swing, F hold >= SLASH_HOLD_TIME then release = 용검 big slash. */
export const SHURIKEN_DAMAGE = K.num('SHURIKEN_DAMAGE');
export const SHURIKEN_SPEED = K.num('SHURIKEN_SPEED');
export const SHURIKEN_FIRE_RATE = K.num('SHURIKEN_FIRE_RATE');
export const SHURIKEN_TRIPLE_SPREAD_DEG = K.num('SHURIKEN_TRIPLE_SPREAD_DEG');
export const SHURIKEN_TRIPLE_COOLDOWN = K.num('SHURIKEN_TRIPLE_COOLDOWN');
export const SLASH_HOLD_TIME = K.num('SLASH_HOLD_TIME');
/** Fraction of max stamina the big slash costs (refused below it). */
export const SLASH_STAMINA_RATIO = K.num('SLASH_STAMINA_RATIO');
export const SLASH_DAMAGE = K.num('SLASH_DAMAGE');
export const SLASH_RANGE = K.num('SLASH_RANGE');
export const SLASH_ARC_DEG = K.num('SLASH_ARC_DEG');
/** Camera FOV multiplier while `PlayerRef.setViewWiden(true)` (the slash wind-up / swing). */
export const SLASH_FOV_MUL = K.num('SLASH_FOV_MUL');
export const SLASH_DURATION = K.num('SLASH_DURATION');

/* 컴포짓 보우 (2026-09-14 활 시위): LMB hold draws over BOW_DRAW_TIME, release shoots — damage / speed / drop lerp from a tap to a full draw; RMB cancels. */
/** Full-draw arrow damage — a tap (no draw) deals BOW_DAMAGE × BOW_TAP_POWER; linear in between. */
export const BOW_DAMAGE = K.num('BOW_DAMAGE');
export const BOW_RANGE = K.num('BOW_RANGE');
/** Cooldown after an arrow leaves = 1 / BOW_FIRE_RATE s (taps can follow each other quickly). */
export const BOW_FIRE_RATE = K.num('BOW_FIRE_RATE');
/** Full-draw arrow speed (m/s). */
export const BOW_PROJECTILE_SPEED = K.num('BOW_PROJECTILE_SPEED');
/** Seconds of LMB hold from nothing to a full draw (the unique csv chargeTime column). */
export const BOW_DRAW_TIME = K.num('BOW_DRAW_TIME');
/** Damage fraction of a tap (draw 0). */
export const BOW_TAP_POWER = K.num('BOW_TAP_POWER');
/** Arrow speed (m/s) of a tap; lerps to BOW_PROJECTILE_SPEED with the draw. */
export const BOW_TAP_SPEED = K.num('BOW_TAP_SPEED');
/** Arrow drop (m/s²) of a tap — fine at 10–15 m and clearly low past ~25 m; lerps to BOW_FULL_GRAVITY. */
export const BOW_TAP_GRAVITY = K.num('BOW_TAP_GRAVITY');
/** Arrow drop (m/s²) at full draw (flies nearly straight to the crosshair). */
export const BOW_FULL_GRAVITY = K.num('BOW_FULL_GRAVITY');

/* 바주카: LMB impact rocket; RMB air-burst rocket (knockback when fired at the floor → super jump; no self damage since 2026-09-14). */
export const BAZOOKA_DAMAGE = K.num('BAZOOKA_DAMAGE');
export const BAZOOKA_RADIUS = K.num('BAZOOKA_RADIUS');
export const BAZOOKA_SPEED = K.num('BAZOOKA_SPEED');
/** Seconds after launch when the RMB rocket detonates on its own. */
export const BAZOOKA_ALT_FUSE = K.num('BAZOOKA_ALT_FUSE');
export const BAZOOKA_ALT_DAMAGE = K.num('BAZOOKA_ALT_DAMAGE');
export const BAZOOKA_ALT_RADIUS = K.num('BAZOOKA_ALT_RADIUS');
/** 2026-09-14 은퇴 — 바주카는 자해 피해가 없다. 읽는 곳이 없고 계약 export 만 남는다 (옛 뜻: 폭발 반경 안의 고정 자해 피해). */
export const BAZOOKA_SELF_DAMAGE = K.num('BAZOOKA_SELF_DAMAGE');
/** Knockback speed away from the blast when the player is inside the radius. */
export const BAZOOKA_KNOCKBACK = K.num('BAZOOKA_KNOCKBACK');
/** Extra vertical impulse when the blast is below the player's feet while airborne (rocket jump). */
export const BAZOOKA_SUPER_JUMP = K.num('BAZOOKA_SUPER_JUMP');
/**
 * 2026-09-14: rocket-jump horizontal boost (m/s) along the player's horizontal velocity at the blast, scaled by
 * `min(1, speed / PLAYER_WALK_SPEED)` — standing still gets none.
 */
export const BAZOOKA_JUMP_FORWARD = K.num('BAZOOKA_JUMP_FORWARD');
/** 2026-09-15: distance multiplier for Hammerhead knockback + airborne rocket jump — speeds are scaled by its square root. */
export const BAZOOKA_KNOCKBACK_DIST_MUL = K.num('BAZOOKA_KNOCKBACK_DIST_MUL');
/** 2026-09-15: further distance multiplier when the shooter was grounded at the blast (square root on speed); no rocket jump then. */
export const BAZOOKA_GROUNDED_DIST_MUL = K.num('BAZOOKA_GROUNDED_DIST_MUL');
export const BAZOOKA_FIRE_RATE = K.num('BAZOOKA_FIRE_RATE');

/* 미니건: LMB hold spins up, fires once spun; movement slowed while spinning. */
export const MINIGUN_SPINUP_TIME = K.num('MINIGUN_SPINUP_TIME');
export const MINIGUN_SPINDOWN_TIME = K.num('MINIGUN_SPINDOWN_TIME');
export const MINIGUN_DAMAGE = K.num('MINIGUN_DAMAGE');
export const MINIGUN_FIRE_RATE = K.num('MINIGUN_FIRE_RATE');
export const MINIGUN_SPREAD_DEG = K.num('MINIGUN_SPREAD_DEG');
/** Move speed multiplier while spinning (`setSpeedModifier('minigun', …)`). */
export const MINIGUN_MOVE_MUL = K.num('MINIGUN_MOVE_MUL');

/** Rounds per stack of the unique calibres (extends AMMO_STACK_ROUNDS for the new AmmoType values). */
export const UNIQUE_AMMO_STACK_ROUNDS: Readonly<Record<string, number>> = numberMap('tables.csv', 'UNIQUE_AMMO_STACK_ROUNDS');

/* ── stat XP (owner: progression) ── */
/** Raw XP for the next stat point at stat value v: STAT_XP_BASE × v^STAT_XP_EXPONENT (5 → 1118, 10 → 3162). */
export const STAT_XP_BASE = K.num('STAT_XP_BASE');
export const STAT_XP_EXPONENT = K.num('STAT_XP_EXPONENT');
/** Stats never drop below this (cheat / debuff floor). */
export const STAT_MIN = K.num('STAT_MIN');

/* ── ship housing (owner: housing/ rules, hub/ geometry) ── */
export const SHIP_STORAGE_KEY = 'scav.ship';
/** Bumped to 2 in Phase 8: `ShipState.plots` / `nameLocked` and the one-off `furn_repair_bench` grant. */
/**
 * Phase 9: 3 = `books` / `bookDex` (absent → empty; no data migration).
 * 온실 개편 (2026-09-11): **4** = `grows` (재배 스테이션 칸). A v3 save loses its 재배층 — every `furn_grow_rack`,
 * placed or stored, is refunded as materials into the 함선 창고 and its `plots` are dropped (사용자 결정: 옛 것 폐기).
 * 연구실 (2026-09-11): **5** = `analyses` / `sampleDex` (분석기). 없으면 빈 것으로 migrate — 버릴 데이터가 없다.
 * 배양조 (2026-09-11, A-14): **6** = `cultures`. v5 → v6 도 없던 필드가 생기는 것뿐이라 환불 경로가 없다.
 * 방 시설 레벨 제거 (2026-09-12): **7** — 모양은 같다. `RoomState.level` 이 늘 1 이 되고, v6 이하 세이브의 작업실 ·
 * 사격장 레벨은 관물대 · 시뮬레이션 허브 레벨로 옮겨지거나 재료로 환불된다 (`housing/ShipState.sanitize`, 한 번만).
 */
export const SHIP_STATE_VERSION = 12;  // 2026-09-12: 9 = 서재 매체 (`media` · `mediaDex` · `toggled`, A-3e) · 2026-09-13: 10 = 조종석 전용 시설 + 조종석 꾸밈 가구 (모양은 같다 — 한 번만 옮기려고 올렸다) · 11 = 요리 재료 티어 (흙 · 배지 내구도와 소켓 · 배양 스캐폴드 · 분석 결과 · 계열 경험치 · 분석 도감) · 2026-09-16: 12 = 표본 개편 · 프로세서 직접 장착 (`sampleLevels` · `ComputeClusterSlot.processors` — 사용자 결정으로 이관 없음: 표본 레벨은 0 부터, 옛 `cores` 는 새것 내구도의 프로세서로 읽는다)
export const SHIP_ROOM_COUNT = K.num('SHIP_ROOM_COUNT');
/** Room floor grid (cells) and cell size (m): 8 × 8 × 0.5 = a 4 × 4 m room. */
export const ROOM_GRID_COLS = K.num('ROOM_GRID_COLS');
export const ROOM_GRID_ROWS = K.num('ROOM_GRID_ROWS');
export const HOUSING_CELL_SIZE = K.num('HOUSING_CELL_SIZE');
export const GENERATOR_MAX_LEVEL = K.num('GENERATOR_MAX_LEVEL');
/** appended (2026-09-13 — 전력 할당 폐지): a new ship's generator level (it runs from the start; an old Lv.0 save is raised to this). */
export const GENERATOR_START_LEVEL = K.num('GENERATOR_START_LEVEL');
export const STORAGE_MAX_LEVEL = K.num('STORAGE_MAX_LEVEL');
export const WORKSHOP_MAX_LEVEL = K.num('WORKSHOP_MAX_LEVEL');
export const RANGE_MAX_LEVEL = K.num('RANGE_MAX_LEVEL');
export const BENCH_MAX_LEVEL = K.num('BENCH_MAX_LEVEL');
/** Stash rows by storage level (index = level, level 0 = STASH_ROWS). Columns stay STASH_COLS. */
export const STASH_ROWS_BY_STORAGE_LEVEL: readonly number[] = numberList('tables.csv', 'STASH_ROWS_BY_STORAGE_LEVEL');
/** Loadout presets by range level (index = level; 0 = no range room). */
export const PRESETS_BY_RANGE_LEVEL: readonly number[] = numberList('tables.csv', 'PRESETS_BY_RANGE_LEVEL');
/** Gun-skill XP multiplier bonus per range level (level 3 → ×1.3). */
export const RANGE_SKILL_GAIN_PER_LEVEL = K.num('RANGE_SKILL_GAIN_PER_LEVEL');
/** Craft material discount per workshop level above 1 (level 3 → ×0.8). */
export const WORKSHOP_COST_DISCOUNT_PER_LEVEL = K.num('WORKSHOP_COST_DISCOUNT_PER_LEVEL');
/** Facility upgrade costs (`[level-1]` = cost to reach `level`; level 1 of a room comes free with its purpose). */
export const GENERATOR_UPGRADE_COST: readonly { defId: string; qty: number }[][] = costLevels('facility_upgrades.csv', 'facility', 'generator');
export const STORAGE_UPGRADE_COST: readonly { defId: string; qty: number }[][] = costLevels('facility_upgrades.csv', 'facility', 'storage');
export const WORKSHOP_UPGRADE_COST: readonly { defId: string; qty: number }[][] = costLevels('facility_upgrades.csv', 'facility', 'workshop');
export const RANGE_UPGRADE_COST: readonly { defId: string; qty: number }[][] = costLevels('facility_upgrades.csv', 'facility', 'range');

/* ══ appended: Phase 5 — meta progression (2026-09-06) ═══════════════════════════════════════════════════ */
/** localStorage key of the meta save (credits / reputation / contracts / quests, `meta/`). */
export const META_STORAGE_KEY = 'scav.meta';
/** localStorage key of the persisted bag + loadout + quick slots (`inventory/Loadout.ts`). */
export const LOADOUT_STORAGE_KEY = 'scav.loadout';

/* ══ appended: Phase 7 — known follow-ups (2026-09-06) ═══════════════════════════════════════════════════ */
/* squad wipe */
/** Result screen after a raid failure returns everyone to the ship by itself after this many seconds. */
export const RAID_FAILED_AUTO_RETURN_S = K.num('RAID_FAILED_AUTO_RETURN_S');

/* container search (감정) — owner: inventory */
/** Seconds to reveal one item by rarity, before bulk (`1 + (w·h − 1) × 0.05`) and `derived.searchSpeedMul` (÷). */
export const SEARCH_TIME_BY_RARITY: Readonly<Record<Rarity, number>> =
  numberMap<Rarity>('tables.csv', 'SEARCH_TIME_BY_RARITY');
/** Searching only runs while the container window is open and the player is within this many metres of it. */
export const SEARCH_MAX_DISTANCE = K.num('SEARCH_MAX_DISTANCE');

/* training range (시뮬레이션 훈련장) — owner: world */
/** Arena side (m), flat, bounded by invisible walls (no ceiling since 2026-09-15); the player spawns at the south end facing the lanes. */
export const TRAINING_ARENA_SIZE = K.num('TRAINING_ARENA_SIZE');
/** Pop-up targets: count, hp, seconds to pop back up after a knock-down. */
export const TRAINING_TARGET_COUNT = K.num('TRAINING_TARGET_COUNT');
export const TRAINING_TARGET_HP = K.num('TRAINING_TARGET_HP');
export const TRAINING_TARGET_RESPAWN_S = K.num('TRAINING_TARGET_RESPAWN_S');
/** Skill XP in a training: only `gun_*` skills rise, scaled by this on top of the 사격장 bonus. */
export const TRAINING_SKILL_GAIN_MUL = K.num('TRAINING_SKILL_GAIN_MUL');

/* rogue AI v2 — owner: enemies */
/** Rounds per magazine (3 bursts of ROGUE_BURST) and the reload pause (no shots, anim hint 12). */
export const ROGUE_MAG_ROUNDS = K.num('ROGUE_MAG_ROUNDS');
export const ROGUE_RELOAD_TIME = K.num('ROGUE_RELOAD_TIME');
/** Cover must actually block the line of sight; candidates are scored by `distance + ROGUE_COVER_FLANK_WEIGHT × (1 − |sin(angle to the target's facing)|)`. */
export const ROGUE_COVER_FLANK_WEIGHT = K.num('ROGUE_COVER_FLANK_WEIGHT');
/** Grenade toss when the target has been behind cover (no LOS) for this long; cooldown per rogue; fuse / damage / radius. */
export const ROGUE_GRENADE_HOLD_S = K.num('ROGUE_GRENADE_HOLD_S');
export const ROGUE_GRENADE_COOLDOWN = K.num('ROGUE_GRENADE_COOLDOWN');
export const ROGUE_GRENADE_FUSE = K.num('ROGUE_GRENADE_FUSE');
export const ROGUE_GRENADE_DAMAGE = K.num('ROGUE_GRENADE_DAMAGE');
export const ROGUE_GRENADE_RADIUS = K.num('ROGUE_GRENADE_RADIUS');
export const ROGUE_GRENADE_RANGE = K.num('ROGUE_GRENADE_RANGE');
/** Seconds the throw pose plays before release (anim hint 13). */
export const ROGUE_GRENADE_WINDUP = K.num('ROGUE_GRENADE_WINDUP');

/* ghosts — owner: player (host) */
/** Bleed rate of a downed ghost (same as a live player: PLAYER_DOWN_BLEED_PER_SEC), kept here for the host loop. */
export const GHOST_BLEED_PER_SEC = K.num('GHOST_BLEED_PER_SEC');

/* ══ appended: Phase 8 — UI/UX pass (2026-09-06) ═══════════════════════════════════════════════════════════ */

/* ── 온실 재배 (owner: housing rules, hub geometry, items seed data) ── */
/** Plots in one 재배층. */
export const GROW_PLOTS_PER_RACK = K.num('GROW_PLOTS_PER_RACK');
/** How many 재배층 may share one floor footprint (each on its own `PlacedFurniture.layer`). */
export const GROW_RACK_STACK_LIMIT = K.num('GROW_RACK_STACK_LIMIT');
/** Vertical spacing (m) between stacked 재배층 layers. */
export const GROW_RACK_LAYER_HEIGHT = K.num('GROW_RACK_LAYER_HEIGHT');
/**
 * 원예 skill speeds a *new* planting up by at most this fraction (skill SKILL_LEVEL_MAX → grow time × (1 − this)).
 * Applied once when the seed goes in; `GrowPlot.readyAt` is then fixed so a later skill change never moves the timer.
 */
export const GROW_SKILL_SPEEDUP = K.num('GROW_SKILL_SPEEDUP');
/** Real hours a seed needs by its rarity, before `GROW_SKILL_SPEEDUP` (items' `ItemDef.seed.growHours` overrides it). */
export const SEED_GROW_HOURS_BY_RARITY: Readonly<Record<Rarity, number>> =
  numberMap<Rarity>('tables.csv', 'SEED_GROW_HOURS_BY_RARITY');

/* ── 온실 개편 — 토양 궁합 (2026-09-11, owner: housing rules, items soil data) ── */
/**
 * 씨앗의 `soilTag` 와 부어 둔 토양의 태그가 **같을 때** 성장 시간이 이 비율만큼 줄어든다.
 * 다르면 대신 `SOIL_MISMATCH_PENALTY` 만큼 늘어난다 — 토양 없이 심는 경우는 없으므로(칸을 먼저 채워야 한다)
 * 이 둘이 곧 기준선이다. 심는 순간 `GrowSlot.readyAt` 에 확정되고 뒤에 바뀌지 않는다.
 */
export const SOIL_MATCH_SPEEDUP = K.num('SOIL_MATCH_SPEEDUP');
/** 궁합이 맞지 않는 토양에 심었을 때 성장 시간이 늘어나는 비율. */
export const SOIL_MISMATCH_PENALTY = K.num('SOIL_MISMATCH_PENALTY');
/** 한 번 부은 토양이 견디는 수확 횟수 — 등급 곡선 (`ItemDef.soil.uses` 가 실제 값이다). */
export const SOIL_USES_BY_RARITY: Readonly<Record<Rarity, number>> =
  numberMap<Rarity>('tables.csv', 'SOIL_USES_BY_RARITY');

/* ── audio settings (owner: audio) ── */
/** localStorage key of the volume settings (`AudioSettings`). */
export const AUDIO_STORAGE_KEY = 'scav.audio';
export const AUDIO_DEFAULT_MASTER = K.num('AUDIO_DEFAULT_MASTER');
export const AUDIO_DEFAULT_SFX = K.num('AUDIO_DEFAULT_SFX');
/** appended (2026-09-14): BGM 채널 기본 음량. 지금은 소리를 내지 않고 음악 재생 창의 볼륨 표시가 이 채널을 읽는다. */
export const AUDIO_DEFAULT_BGM = K.num('AUDIO_DEFAULT_BGM');

/* ── ship doors + room lighting (owner: hub) ── */
/**
 * A room / cockpit door slides open when the player is within this many metres of its threshold.
 * **Unused since 2026-09-16** (the ships' sliding 자동문 were removed — user decision); kept because `src/shared` is add-only.
 */
export const DOOR_OPEN_DISTANCE = K.num('DOOR_OPEN_DISTANCE');
/** Door slide speed (fraction of full travel per second). **Unused since 2026-09-16** (see `DOOR_OPEN_DISTANCE`). */
export const DOOR_SLIDE_SPEED = K.num('DOOR_SLIDE_SPEED');
/**
 * Real point lights reserved for the rooms. Kept **constant** (toggling `light.visible` recompiles every shader):
 * the pool is created once and re-anchored to the nearest non-empty rooms, with `intensity` ramped instead.
 */
export const ROOM_LIGHT_POOL = K.num('ROOM_LIGHT_POOL');
/** Point-light intensity / distance of a lit (non-empty) room. */
export const ROOM_LIGHT_INTENSITY = K.num('ROOM_LIGHT_INTENSITY');
export const ROOM_LIGHT_DISTANCE = K.num('ROOM_LIGHT_DISTANCE');
/** `emissiveIntensity` of a room's wall strips when the room is empty vs. assigned a purpose. */
export const ROOM_STRIP_DIM = K.num('ROOM_STRIP_DIM');
export const ROOM_STRIP_LIT = K.num('ROOM_STRIP_LIT');

/* ══ appended: Phase 9 — known follow-ups II (2026-09-06) ═══════════════════════════════════════════════════ */

/* ── jump pad (owner: gadgets) ── */
/** A player who was just launched by a pad cannot be launched by the same pad again for this long (was a 0.7 s per-pad literal). */
export const JUMP_PAD_RETRIGGER_S = K.num('JUMP_PAD_RETRIGGER_S');

/* ── 서재 책장 (owner: housing rules, hub geometry, items book data) ── */
/** Book slots per 책장. */
export const BOOKS_PER_SHELF = K.num('BOOKS_PER_SHELF');
/** Skill-XP multiplier bonus per shelved book, weighted by `BOOK_RARITY_MUL[rarity]`: mul = 1 + BOOK_XP_PER_BOOK × Σ weight. */
export const BOOK_XP_PER_BOOK = K.num('BOOK_XP_PER_BOOK');
export const BOOK_RARITY_MUL: Readonly<Record<Rarity, number>> =
  numberMap<Rarity>('tables.csv', 'BOOK_RARITY_MUL');
/** Cap of the 서재 multiplier for one skill. */
export const BOOK_GAIN_MAX = K.num('BOOK_GAIN_MAX');

/* ── appended (2026-09-12): 서재 매체 — 디스크 · 레코드 · 보조 가구 (A-3e; owner: housing rules, hub geometry, items data) ── */
/** 디스크 전시대 · 레코드랙 한 대의 칸 수 (책장은 `BOOKS_PER_SHELF`). */
export const DISC_SLOTS_PER_STAND = K.num('DISC_SLOTS_PER_STAND');
export const RECORD_SLOTS_PER_RACK = K.num('RECORD_SLOTS_PER_RACK');
/** 한 장이 그 숙련의 몫에 더하는 값 (× `BOOK_RARITY_MUL[rarity]`) — 책의 `BOOK_XP_PER_BOOK` 과 같은 자리. */
export const DISC_XP_PER_ITEM = K.num('DISC_XP_PER_ITEM');
export const RECORD_XP_PER_ITEM = K.num('RECORD_XP_PER_ITEM');
/** 매체별 몫의 상한 (`1 + 몫 ≤ 이 값`) — 책의 `BOOK_GAIN_MAX` 와 같은 자리. 세 매체의 몫은 따로 잘린 뒤 더해진다. */
export const DISC_GAIN_MAX = K.num('DISC_GAIN_MAX');
export const RECORD_GAIN_MAX = K.num('RECORD_GAIN_MAX');
/** 보조 가구가 배치돼 있으면 그 매체의 몫 × (1 + 이 값) — 흔들의자(책) · TV(디스크) · 축음기 · 주크박스 · 턴테이블(레코드, 셋 중 하나만). */
export const SHELF_AUX_BONUS_BOOK = K.num('SHELF_AUX_BONUS_BOOK');
export const SHELF_AUX_BONUS_DISC = K.num('SHELF_AUX_BONUS_DISC');
export const SHELF_AUX_BONUS_RECORD = K.num('SHELF_AUX_BONUS_RECORD');

/* ── appended (2026-09-12): 헬스장 (A-3a; owner: progression rules, housing minigames, hub geometry) ── */
/** 운동 · 게임 한 세션 만점(점수 1)이 능력치 경험치 바에 넣는 경험치 — 실제 = round(GYM_SESSION_XP × 점수). 2026-09-17: 능력치 경험치 단위. */
export const GYM_SESSION_XP = K.num('GYM_SESSION_XP');
/** 은퇴 (2026-09-17, 읽는 코드 없음 — shared 는 추가 전용): 옛 단련 전용 바의 필요 경험치. */
export const GYM_TRAIN_XP_BASE = K.num('GYM_TRAIN_XP_BASE');
export const GYM_TRAIN_XP_EXPONENT = K.num('GYM_TRAIN_XP_EXPONENT');
/** 능력치 하나가 운동으로 얻는 단련 보너스의 상한. */
export const GYM_TRAINED_MAX = K.num('GYM_TRAINED_MAX');
/** 운동을 끝낸 뒤 그 능력치에 걸리는 디버프(근육통 · 심폐 피로)의 현실 시간(시간). */
export const GYM_FATIGUE_HOURS = K.num('GYM_FATIGUE_HOURS');
/** 디버프 중 같은 능력치 운동의 상승 배율 — 0 = −100 %. */
export const GYM_FATIGUE_GAIN_MUL = K.num('GYM_FATIGUE_GAIN_MUL');
/** 박자 게임(호흡 달리기 · 사이클링)의 예비 박자 수 — 첫 표식이 판정선까지 걸어오는 동안, 입력은 무시한다. */
export const GYM_LEAD_BEATS = K.num('GYM_LEAD_BEATS');
/** 판정 한 번이 세션 점수(판정들의 평균)에 넣는 값 — 완벽 · 성공 (실패는 0). */
export const GYM_SCORE_PERFECT = K.num('GYM_SCORE_PERFECT');
export const GYM_SCORE_GOOD = K.num('GYM_SCORE_GOOD');
/** 벤치프레스(벤치 랙 · 스미스 머신): 판정 횟수, 커서 속도(바 폭/초)와 회차마다 더하는 속도, 성공 · 완벽 구역 반폭(바 폭 비율). */
export const GYM_PRESS_REPS = K.num('GYM_PRESS_REPS');
export const GYM_PRESS_SPEED = K.num('GYM_PRESS_SPEED');
export const GYM_PRESS_SPEED_STEP = K.num('GYM_PRESS_SPEED_STEP');
export const GYM_PRESS_ZONE = K.num('GYM_PRESS_ZONE');
export const GYM_PRESS_PERFECT = K.num('GYM_PRESS_PERFECT');
/** 호흡(트레드밀): 후-후-하 묶음 수, 박자 간격(초), 「하」 길이(초), 탭 판정 창(±초), 「하」 를 떼는 판정 창(±초). */
export const GYM_BREATH_CYCLES = K.num('GYM_BREATH_CYCLES');
export const GYM_BREATH_BEAT_S = K.num('GYM_BREATH_BEAT_S');
export const GYM_BREATH_HOLD_S = K.num('GYM_BREATH_HOLD_S');
export const GYM_BREATH_WINDOW_S = K.num('GYM_BREATH_WINDOW_S');
export const GYM_BREATH_HOLD_TOL_S = K.num('GYM_BREATH_HOLD_TOL_S');
/** 사이클링: A · D 를 번갈아 밟는 횟수, 박자 간격(초), 판정 창(±초). */
export const GYM_CYCLE_STROKES = K.num('GYM_CYCLE_STROKES');
export const GYM_CYCLE_BEAT_S = K.num('GYM_CYCLE_BEAT_S');
/** appended (2026-09-14): 「좋음」 띠의 반폭 = 완벽 띠(= 판정 창) × 이 값. 완벽 = 화면에 보이는 표식 크기라는 규약의 짝이다. */
export const GYM_GOOD_OF_PERFECT = K.num('GYM_GOOD_OF_PERFECT');
export const GYM_CYCLE_WINDOW_S = K.num('GYM_CYCLE_WINDOW_S');

/* ── appended (2026-09-12): 캐릭터 버프 (owner: player 목록, net 와이어, ui 썸네일) ── */
/** 한 캐릭터의 버프 목록이 와이어에 실을 수 있는 최대 개수 — 받는 쪽 `sanitizeCharBuffs` 가 넘치는 것을 버린다. */
export const CHAR_BUFF_WIRE_MAX = K.num('CHAR_BUFF_WIRE_MAX');
/** 스냅샷 `bfr` 가 가진 리비전과 달라 `cbufq sync` 를 보낸 뒤 같은 사람에게 다시 묻기까지 기다리는 시간(초). 답하는 쪽도 요청자별로 이만큼 막는다. */
export const CHAR_BUFF_SYNC_COOLDOWN_S = K.num('CHAR_BUFF_SYNC_COOLDOWN_S');

/* ── 시뮬레이션 훈련장 target modes (owner: world) ── */
/** 이동 표적: sweep half-width (m, keeps the target inside its lane), speed (m/s) and the pause at each end. */
export const TRAINING_MOVING_SPAN = K.num('TRAINING_MOVING_SPAN');
export const TRAINING_MOVING_SPEED = K.num('TRAINING_MOVING_SPEED');
export const TRAINING_MOVING_PAUSE_S = K.num('TRAINING_MOVING_PAUSE_S');
/** 타임 코스: knock-downs needed, seconds allowed, cooldown before the next course can start. */
export const TRAINING_COURSE_TARGETS = K.num('TRAINING_COURSE_TARGETS');
export const TRAINING_COURSE_TIME_S = K.num('TRAINING_COURSE_TIME_S');
export const TRAINING_COURSE_COOLDOWN_S = K.num('TRAINING_COURSE_COOLDOWN_S');
/** localStorage key of the best timed-course time. */
export const TRAINING_BEST_STORAGE_KEY = 'scav.training';

/* ══ appended: Phase 10 — UI 개선 pass (2026-09-07) ═════════════════════════════════════════════════════════ */

/* ── 배리어 = 들고 다니는 방패 (owner: implants; the 7 × 3.2 m deployed panel constants above stay for nothing —
 *    they are superseded by the CARRY_* pair, kept only so an older save / smoke that reads them still compiles) ── */
/**
 * Hand-shield panel size (m). Phase 12 (2026-09-08): widened 1.5 → 3.2 so the shield covers the carrier **and** a
 * squadmate at their shoulder, and doubles as a wall for bugs (`ImplantsRef.resolveBarrierCollision`); the 실드 배쉬
 * strikes over this same width. Height unchanged.
 */
export const IMPLANT_BARRIER_CARRY_WIDTH = K.num('IMPLANT_BARRIER_CARRY_WIDTH');
export const IMPLANT_BARRIER_CARRY_HEIGHT = K.num('IMPLANT_BARRIER_CARRY_HEIGHT');
/**
 * Metres in front of the player axis the panel plane sits. **Must stay > `PLAYER_RADIUS`** or enemy hitscan clamps to
 * the player capsule before the barrier query runs (`enemies/EnemySystem.fireGun`) and the shield never blocks.
 */
export const IMPLANT_BARRIER_CARRY_OFFSET = K.num('IMPLANT_BARRIER_CARRY_OFFSET');
/** Height of the panel's bottom edge above the feet (`BarrierField.intersect` measures dy from `position.y`). */
export const IMPLANT_BARRIER_CARRY_BASE_Y = K.num('IMPLANT_BARRIER_CARRY_BASE_Y');
/** Movement multiplier while the shield is up (`player.setSpeedModifier('shield', …)`). */
export const IMPLANT_BARRIER_CARRY_SPEED_MUL = K.num('IMPLANT_BARRIER_CARRY_SPEED_MUL');
/** Half-angle (rad) around the carrier's forward inside which the raised shield blocks; wider shots pass by. */
export const IMPLANT_BARRIER_CARRY_ARC = Math.PI / 2;
/** Shield hp removed per blocked hostile projectile (was the module-local `BARRIER_BLOCK_DAMAGE`). */
export const IMPLANT_BARRIER_BLOCK_DAMAGE = K.num('IMPLANT_BARRIER_BLOCK_DAMAGE');
/** Regen per second while the shield is raised, after `IMPLANT_BARRIER_CARRY_REGEN_DELAY` without a hit. */
export const IMPLANT_BARRIER_CARRY_REGEN = K.num('IMPLANT_BARRIER_CARRY_REGEN');
export const IMPLANT_BARRIER_CARRY_REGEN_DELAY = K.num('IMPLANT_BARRIER_CARRY_REGEN_DELAY');

/* ── 다각화된 적 사망 + 확률 루팅 (owner: enemies; the chance table is `CORPSE_LOOT_CHANCE` in types.ts) ── */
/** Seconds of `Enemy.deathTimer` over which the fall pose blends in (bugs and rogues). */
export const DEATH_FALL_TIME = K.num('DEATH_FALL_TIME');
/** Terminal speed (m/s) of a body that died in the air and is still falling to the terrain. */
export const CORPSE_FALL_MAX_SPEED = K.num('CORPSE_FALL_MAX_SPEED');
/** A mid-air kill registers its `corpse:<id>` interactable only once the body lands, or after this long. */
export const CORPSE_LAND_TIMEOUT = K.num('CORPSE_LAND_TIMEOUT');

/* ── 컨테이너 실시간 동기화 연출 (owner: inventory grid view) ── */
/** Length of the "float up + fade out" a container tile plays when someone else takes it (seconds). */
export const CONTAINER_TAKE_ANIM_S = K.num('CONTAINER_TAKE_ANIM_S');
/** How far the vanishing tile floats up, in grid px, and the scale it ends at. */
export const CONTAINER_TAKE_RISE_PX = K.num('CONTAINER_TAKE_RISE_PX');
export const CONTAINER_TAKE_END_SCALE = K.num('CONTAINER_TAKE_END_SCALE');

/* ── 루팅 표시 = 빛기둥 (replaces the light-blue fresnel sphere of Detection / ScanReveal) ── */
/** In-range interactable pillar: height (m), bottom / top radius (m), peak opacity at the base. */
export const INTERACT_PILLAR_HEIGHT = K.num('INTERACT_PILLAR_HEIGHT');
export const INTERACT_PILLAR_RADIUS_BOTTOM = K.num('INTERACT_PILLAR_RADIUS_BOTTOM');
export const INTERACT_PILLAR_RADIUS_TOP = K.num('INTERACT_PILLAR_RADIUS_TOP');
export const INTERACT_PILLAR_OPACITY = K.num('INTERACT_PILLAR_OPACITY');
/** Vertical fraction at which the pillar has faded to nothing (1 = fades exactly at the top). */
export const INTERACT_PILLAR_FADE = K.num('INTERACT_PILLAR_FADE');
/** The scan-reveal (through-wall) pillar is taller so it still reads behind geometry. */
export const SCAN_PILLAR_HEIGHT = K.num('SCAN_PILLAR_HEIGHT');
/** Per-pickup pillar (replaces the 5.5 m `PickupVisuals.BEAM_HEIGHT` beam). */
export const PICKUP_PILLAR_HEIGHT = K.num('PICKUP_PILLAR_HEIGHT');
export const PICKUP_PILLAR_OPACITY = K.num('PICKUP_PILLAR_OPACITY');

/* ── 부상자 들쳐메기 (owner: player) ── */
/** Max distance (m) at which an F tap can shoulder a downed squadmate. */
export const PLAYER_CARRY_RANGE = K.num('PLAYER_CARRY_RANGE');
/** Pick-up / put-down animation length (s); the carrier's controls are locked for it. */
export const PLAYER_CARRY_PICKUP_S = K.num('PLAYER_CARRY_PICKUP_S');
export const PLAYER_CARRY_DROP_S = K.num('PLAYER_CARRY_DROP_S');
/** Speed multiplier while carrying. Walking and sprinting are allowed; every other action drops the body first. */
export const PLAYER_CARRY_SPEED_MUL = K.num('PLAYER_CARRY_SPEED_MUL');
/** Carried body's local offset in the carrier's right-shoulder socket. */
export const PLAYER_CARRY_OFFSET: readonly [number, number, number] =
  numberList('tables.csv', 'PLAYER_CARRY_OFFSET') as unknown as readonly [number, number, number];

/* ── 회복약 (was 스팀; the `stim` def id / `ItemCategory 'stim'` / `applyStim` are unchanged) ── */
/**
 * Fallback hold for a 회복 소모품 whose def carries no `heal` block. Since 2026-09-07 every real one states its
 * own `ItemDef.heal.useTime` (붕대 5 s · 약초 붕대 5 s · 회복주사 2 s) and the HUD reads the duration off the event.
 */
export const HEAL_HOLD_S = K.num('HEAL_HOLD_S');
/** Taking damage does not cancel the hold (moving never did). Kept as a constant so the HUD mirrors the rule. */
export const HEAL_HOLD_CANCEL_ON_DAMAGE = K.bool('HEAL_HOLD_CANCEL_ON_DAMAGE');

/* ── appended: 소모품 사용 (2026-09-07) ── */
/** Movement speed multiplier while a consumable is being used / channelled (`PlayerRef.setSpeedModifier`). */
export const CONSUMABLE_SLOW_MUL = K.num('CONSUMABLE_SLOW_MUL');
/** `setSpeedModifier` key weapons uses for that slow, so nothing else can clash with it. */
export const CONSUMABLE_SLOW_KEY = 'consumable';
/** Seconds LMB must be held with a 제세동기 in hand before the revive fires. */
export const DEFIB_USE_TIME_S = K.num('DEFIB_USE_TIME_S');
/** 회복 스프레이: gauge of a fresh can (the instance's `durability`) and the radius its ticks heal in. */
export const HEAL_SPRAY_GAUGE = K.num('HEAL_SPRAY_GAUGE');   // 2026-09-08: 100 → 200; an empty can stays at 0 (repairable in the ship) instead of vanishing
export const HEAL_SPRAY_RADIUS = K.num('HEAL_SPRAY_RADIUS');

/* ── 발사 준비 패널 (owner: hub, portraits from player/) ── */
/** Cells in the READY panel. Kept separate from the lobby size so the panel never resizes. */
export const HUB_READY_CELLS = K.num('HUB_READY_CELLS');
/**
 * Body yaw of a portrait (rad). The soldier model's front is −Z, so yaw θ points the body at
 * `(−sin θ, 0, −cos θ)`; the portrait camera sits on +Z. 2026-09-14: the value moved to `data/constants.csv`
 * (「수치는 코드에 적지 않는다」) and became −3π/4 — 카메라 쪽을 보면서 화면 오른쪽으로 튼 3/4 뷰.
 */
export const HUB_READY_PORTRAIT_YAW = K.num('HUB_READY_PORTRAIT_YAW');
/** `ctx.uiBlockers` token the READY panel holds while it is open. */
export const HUB_READY_BLOCKER = 'ready';
/** Debounce for re-broadcasting my own `crew card` (seconds). */
export const CREW_CARD_MIN_INTERVAL_S = K.num('CREW_CARD_MIN_INTERVAL_S');
/** Don't answer `crewq loadout` from the same peer more often than this (seconds). */
export const CREW_LOADOUT_COOLDOWN_S = K.num('CREW_LOADOUT_COOLDOWN_S');

/* ── 마우스 커서 (owner: shared/cursor.ts + Input; the art is ui/hud/GameCursor) ── */
/*
 * 2026-09-07 rework: the virtual cursor is gone. A cursor screen releases the pointer lock and the **real** OS cursor
 * comes back, restyled as the game's own arrow through a procedurally drawn CSS `cursor:` image — so there is no
 * sensitivity, no sprite position and no synthetic double-click window to tune any more.
 */
/** Side of the drawn cursor image in CSS px (a 2× copy is generated for HiDPI through `image-set`). */
export const GAME_CURSOR_SIZE = K.num('GAME_CURSOR_SIZE');
/**
 * `ctx.uiBlockers` token the Alt 커서 (a free cursor with no screen behind it) held while it was up.
 * 2026-09-10: 그 기능이 제거돼 아무도 이 토큰을 쓰지 않는다 — 계약이라 export 만 남았다.
 */
export const FREE_CURSOR_BLOCKER = 'cursor';

/** How long a denied pointer-lock request keeps waiting for the next real user gesture to retry (ms). */
export const LOCK_GESTURE_RETRY_MS = K.num('LOCK_GESTURE_RETRY_MS');
export const LOCK_BOUNCE_GRACE_MS = K.num('LOCK_BOUNCE_GRACE_MS');
/** Escape 를 뗀 뒤 포인터 락을 다시 요청하기까지 기다리는 시간 (ms) — `Input` 의 재잠금 지연. */
export const LOCK_ESCAPE_DEFER_MS = K.num('LOCK_ESCAPE_DEFER_MS');
/** 사용자가 Escape 로 락을 푼 뒤 Chromium 이 재요청을 거부하는 쿨다운 (ms). */
export const LOCK_USER_EXIT_COOLDOWN_MS = K.num('LOCK_USER_EXIT_COOLDOWN_MS');
/** 타이밍 때문에 거부된 포인터 락 요청을 스스로 다시 보내는 최대 횟수. */
export const LOCK_RELOCK_RETRIES = K.num('LOCK_RELOCK_RETRIES');

/* ══ appended: Phase 11 — 행성 선택 · 소셜 (2026-09-07) ═════════════════════════════════════════════════════ */

/* ── 행성 이동 (owner: hub; 2026-09-09: an in-ship 창문 워프 — `interiors/WarpStreaks.ViewportWarp` — not a cutscene) ── */
/** Seconds of the 행성 이동 warp (ramp up → cruise → ramp down). Shorter than `HUB_DOCKING_DURATION` — a hop, not an arrival. */
export const HUB_TRAVEL_DURATION = K.num('HUB_TRAVEL_DURATION');
/** How far the warp stretches a star (multiplier on its own length at full `hub:warpProgress.speed`). */
export const HUB_TRAVEL_WARP_STRETCH = K.num('HUB_TRAVEL_WARP_STRETCH');
/* 2026-09-09 창문 워프: the trip is watched from inside the ship (no cutscene, controls stay on). */
/** Seconds the warp takes to ramp up at the start and down at the end (`hub:warpProgress.speed` 0→1 / 1→0). */
export const HUB_WARP_RAMP_S = K.num('HUB_WARP_RAMP_S');
/** `camera:shake` intensity at full warp speed (fed every `HUB_WARP_SHAKE_INTERVAL_S`, scaled by `speed`). */
export const HUB_WARP_SHAKE_PEAK = K.num('HUB_WARP_SHAKE_PEAK');
/** Seconds between hull-shake pulses while the warp runs. */
export const HUB_WARP_SHAKE_INTERVAL_S = K.num('HUB_WARP_SHAKE_INTERVAL_S');

/* ── 터미널 (owner: hub/ui/HubMenu — full-screen since Phase 11) ── */
/** Side of the square WebGL canvas the planet hologram renders into (device px are scaled by the DPR cap). */
export const PLANET_HOLOGRAM_PX = K.num('PLANET_HOLOGRAM_PX');
/** Idle spin of the hologram sphere (rad/s) and the tilt it is seen at (rad). */
export const PLANET_HOLOGRAM_SPIN = K.num('PLANET_HOLOGRAM_SPIN');
export const PLANET_HOLOGRAM_TILT = K.num('PLANET_HOLOGRAM_TILT');
/** Seconds the hologram takes to swap planets when the player steps left / right. */
export const PLANET_SWAP_TIME = K.num('PLANET_SWAP_TIME');

/* ── 소셜 UI (owner: ui) ── */
/** `ctx.uiBlockers` token the ship's 커뮤니티 panel holds while open (the ESC screen is inside the `'menu'` token). */
export const COMMUNITY_BLOCKER = 'community';
/** Profile cards per row in the 친구 / 최근 플레이어 lists (the spec's 가로 2개씩). */
export const SOCIAL_CARDS_PER_ROW = K.num('SOCIAL_CARDS_PER_ROW');
/** Rows the 친구 list and the 최근 플레이어 list show before they scroll (2 × 3.5 and 2 × 5.5 in the spec). */
export const SOCIAL_FRIEND_ROWS = K.num('SOCIAL_FRIEND_ROWS');
export const SOCIAL_RECENT_ROWS = K.num('SOCIAL_RECENT_ROWS');
/** Squad voice sliders are UI-only in Phase 11 (no voice chat yet); this is their stored default. */
export const SQUAD_VOICE_DEFAULT = K.num('SQUAD_VOICE_DEFAULT');


/* ══ appended: 2026-09-08 batch — 임플란트 아이템 · 배리어 rework · 정찰 rework · 총알 추적 · 실드 배쉬 ═══════════════ */

/* ── 임플란트(능력치 장착 아이템) 칸 (owner: progression) ── */
export const IMPLANT_SLOTS_BASE = K.num('IMPLANT_SLOTS_BASE');
/** +1 slot per this many character levels. */
export const IMPLANT_SLOTS_PER_LEVELS = K.num('IMPLANT_SLOTS_PER_LEVELS');
export const IMPLANT_SLOTS_MAX = K.num('IMPLANT_SLOTS_MAX');

/* ── 실드 배쉬 (owner: implants) ── */
/** Stamina spent per bash (same units as `PlayerRef.consumeStamina`). */
export const IMPLANT_SHIELD_BASH_STAMINA = K.num('IMPLANT_SHIELD_BASH_STAMINA');
/** Base damage per enemy in the arc (× `derived.meleeDamageMul` only — no weapon / 개머리판 bonus). */
export const IMPLANT_SHIELD_BASH_DAMAGE = K.num('IMPLANT_SHIELD_BASH_DAMAGE');
/** Reach in front of the shield plane, metres. Width = the shield's own carry width. */
export const IMPLANT_SHIELD_BASH_RANGE = K.num('IMPLANT_SHIELD_BASH_RANGE');
export const IMPLANT_SHIELD_BASH_COOLDOWN = K.num('IMPLANT_SHIELD_BASH_COOLDOWN');
/** Knockback impulse applied to each struck enemy (m/s along the shield forward). */
export const IMPLANT_SHIELD_BASH_KNOCKBACK = K.num('IMPLANT_SHIELD_BASH_KNOCKBACK');
/** Seconds the bash pose / FX play. */
export const IMPLANT_SHIELD_BASH_SWING_S = K.num('IMPLANT_SHIELD_BASH_SWING_S');

/* ── 정찰 rework (owner: implants) — one wide instant pulse ── */
/** Radius of the single pulse, metres. */
export const IMPLANT_SCAN_RADIUS = K.num('IMPLANT_SCAN_RADIUS');
/** Seconds the reveal lasts (self + squad). Replaces `IMPLANT_SCAN_REVEAL_TIME` (10) for the new implant. */
export const IMPLANT_SCAN_REVEAL_TIME_V2 = K.num('IMPLANT_SCAN_REVEAL_TIME_V2');
export const IMPLANT_SCAN_COOLDOWN_V2 = K.num('IMPLANT_SCAN_COOLDOWN_V2');

/* ── 총알 추적 (owner: enemies) ── */
/** An enemy this close to the bullet path (metres, closest approach) reacts even without perceiving the shooter. */
export const ENEMY_SHOT_ALERT_DIST = K.num('ENEMY_SHOT_ALERT_DIST');
/** … or this close to the impact point. */
export const ENEMY_SHOT_IMPACT_DIST = K.num('ENEMY_SHOT_IMPACT_DIST');
/** Seconds the enemy faces the origin with a widened perception cone before it starts advancing. */
export const ENEMY_SHOT_ALERT_WATCH_S = K.num('ENEMY_SHOT_ALERT_WATCH_S');
/** Perception range multiplier toward the shot origin during the watch (and while advancing). */
export const ENEMY_SHOT_ALERT_CONE_MUL = K.num('ENEMY_SHOT_ALERT_CONE_MUL');
/** Give up the investigation after this many seconds without finding anyone (returns to the previous behaviour). */
export const ENEMY_SHOT_ALERT_GIVE_UP_S = K.num('ENEMY_SHOT_ALERT_GIVE_UP_S');

/* ── 나침반 적 표시 (owner: ui) ── */
/** Compass tick colour for enemies inside `derived.enemyDetectRadius` / a 정찰 reveal. */
export const COMPASS_ENEMY_COLOR = '#ff4d4d';

/* ── 브라우저 재개 게이트 (owner: game) ── */
/** `ctx.uiBlockers` token the '좌측 클릭으로 게임 재개' gate holds (browser only, never in the Electron shell). */
export const RESUME_GATE_BLOCKER = 'resumegate';
/* ── 일시정지 메뉴 토큰 (2026-09-08; ESC 닫기 규칙은 2026-09-09) ── */
/**
 * `ctx.uiBlockers` token every full-screen menu (`ui/menus/MenuBase`) holds — the 일시정지 메뉴 above all. Screens
 * whose own key doubles as their close key (Tab / M / P / E) test for it so that key does not reach through the
 * pause menu stacked on top of them.
 */
export const MENU_BLOCKER = 'menu';

/**
 * 커뮤니티 패널 (2026-09-08): `Keys.INVITE` (P) is **tap = open / close the panel, hold = 분대 초대 수락**. A press
 * released within this long counts as the tap; anything longer was an aborted invite hold and does nothing. With no
 * invite on screen there is nothing to hold for, so any release toggles.
 */
export const COMMUNITY_TAP_MAX_S = K.num('COMMUNITY_TAP_MAX_S');

/* ── 공용 함선 격납고 (2026-09-08, owner: hub) ─────────────────────────────── */
/**
 * Debounce for re-broadcasting my own `ship state` (seconds). A ship layout changes far less often than a crew card
 * and costs a few kB, so it is slower than `CREW_CARD_MIN_INTERVAL_S` on purpose.
 */
export const SHIP_VISIT_MIN_INTERVAL_S = K.num('SHIP_VISIT_MIN_INTERVAL_S');
/** Don't answer `shipq state` from the same peer more often than this (seconds). */
export const SHIP_VISIT_COOLDOWN_S = K.num('SHIP_VISIT_COOLDOWN_S');
/** Seconds a bay waits for a peer's `ship state` before the visit is refused with a toast. */
export const SHIP_VISIT_WAIT_S = K.num('SHIP_VISIT_WAIT_S');
/**
 * Placed pieces a `ship state` may carry. Enforced on **both** sides: the sender truncates so the frame stays under
 * the relay's `MAX_MESSAGE_BYTES` (a frame over it is dropped with no error and would never be retried), and the
 * receiver truncates so a hostile document cannot make a visitor build thousands of colliders.
 */
export const SHIP_VISIT_MAX_FURNITURE = K.num('SHIP_VISIT_MAX_FURNITURE');

/* ── 캐릭터 슬롯 · 생성 (2026-09-09, owner: shared/saveSlot · shared/character) ── */
/** 타이틀 캐릭터 선택창의 칸 수. 슬롯마다 세이브가 완전히 분리된다 (`scav.s<n>.*`). */
/** 튜토리얼 (2026-09-09): delay before the spotlight / guide of a new step appears, and the dim fade-in. */
export const TUTORIAL_STEP_DELAY_S = K.num('TUTORIAL_STEP_DELAY_S');
export const TUTORIAL_DIM_FADE_S = K.num('TUTORIAL_DIM_FADE_S');
export const CHARACTER_SLOTS = K.num('CHARACTER_SLOTS');
/** 캐릭터 생성창에서 한 능력치가 가질 수 있는 최소값. */
export const CHAR_STAT_MIN = K.num('CHAR_STAT_MIN');
/** 캐릭터 생성창에서 한 능력치가 가질 수 있는 최대값 (게임 안 성장 상한 `STAT_MAX` 와는 별개). */
export const CHAR_STAT_MAX = K.num('CHAR_STAT_MAX');
/** 캐릭터 생성창에서 다섯 능력치의 합. 남는 배분 점수는 이 값 − 5 × `CHAR_STAT_MIN`. */
export const CHAR_STAT_TOTAL = K.num('CHAR_STAT_TOTAL');
/** 이름 주사위가 붙이는 숫자의 상한 (`스캐빈저1234`). */
export const CHAR_NAME_RANDOM_MAX = K.num('CHAR_NAME_RANDOM_MAX');

/* ── 위험한 버튼의 홀드 확정 (2026-09-09, owner: ui) ── */
/** 파티 떠나기 · 타이틀로 · 게임 종료 확정 버튼을 눌러 두어야 하는 시간(초). */
export const UI_HOLD_CONFIRM_S = K.num('UI_HOLD_CONFIRM_S');
/** appended (2026-09-12): 시설 관리에서 가구를 꾹 눌러 위치 이동 상태로 드는 시간 (hub/HousingMode · ui 의 커서 게이지). */
export const HOUSING_MOVE_HOLD_S = K.num('HOUSING_MOVE_HOLD_S');
/** appended (2026-09-17): 메신저 — NPC 의 마지막 말풍선이 붙은 뒤 대사 선택지가 뜨기까지의 시간(초) (`ui/menus/messenger/ChatTab`). */
export const MESSENGER_CHOICE_DELAY_S = K.num('MESSENGER_CHOICE_DELAY_S');

/* ══ 2026-09-09: 사망 · 시체 · 구조선 · 안개 · 지형지물 ═════════════════════════════════════════════════════ */

/* ── 사망 · 시체 (owner: game/parts/Death · player · inventory) ── */
/**
 * **자동 부활은 없다** (2026-09-09). `PLAYER_RESPAWN_DELAY` 는 계약에 남아 있지만 아무도 읽지 않는다 —
 * 완전히 사망하면 시체가 되고, 되살아나는 길은 분대원의 `rescue_drop` 뿐이다.
 */
/** 사망한 플레이어의 시체를 열 수 있는 거리(m). */
export const PLAYER_CORPSE_LOOT_RANGE = K.num('PLAYER_CORPSE_LOOT_RANGE');
/** 시체 루팅 격자의 칸 수 — 사망 시점의 장비 + 가방 전부가 들어가야 하므로 상자(6×4)보다 크다. */
export const PLAYER_CORPSE_COLS = K.num('PLAYER_CORPSE_COLS');
export const PLAYER_CORPSE_ROWS = K.num('PLAYER_CORPSE_ROWS');

/* ── 구조선 투하 (owner: stratagems/parts/Rescue) ── */
/** 레이드 한 판에 분대가 공용으로 쓰는 구조선 횟수. **호출 확정 시** 1 차감된다 (취소는 환불 없음). */
export const RESCUE_DROPS_PER_RAID = K.num('RESCUE_DROPS_PER_RAID');
/** 지정 지점 주변 이 반경(m) 안의 임의 지점에 구조 포드가 떨어진다. */
export const RESCUE_SCATTER_RADIUS = K.num('RESCUE_SCATTER_RADIUS');
/** 동시에 떨어지는 포드끼리 최소 이만큼(m) 떨어뜨린다 (겹침 방지). */
export const RESCUE_POD_MIN_GAP = K.num('RESCUE_POD_MIN_GAP');
/** 구조선으로 부활한 분대원이 시작하는 체력 (장비는 시체에 남으므로 빈손이다). */
export const RESCUE_REVIVE_HP = K.num('RESCUE_REVIVE_HP');

/* ── 분대장 기기 (owner: game/parts/Leader) ── */
/** 분대장 기기를 상호작용으로 꾹 눌러야 하는 시간(초). */
export const LEADER_DEVICE_HOLD_S = K.num('LEADER_DEVICE_HOLD_S');
/** 분대장 기기 상호작용 거리(m). */
export const LEADER_DEVICE_RANGE = K.num('LEADER_DEVICE_RANGE');

/* ── 전장의 안개 (owner: world/Fog) ── */
/** 안개 그리드 한 칸의 한 변(m). `MAP_SIZE / FOG_CELL_M` 이 격자 해상도가 된다. */
export const FOG_CELL_M = K.num('FOG_CELL_M');
/** 분대원 한 명이 자기 주위로 밝히는 반경(m). */
export const FOG_REVEAL_RADIUS = K.num('FOG_REVEAL_RADIUS');
/** 안개 그리드를 다시 칠하는 빈도(회/초). */
export const FOG_UPDATE_HZ = K.num('FOG_UPDATE_HZ');

/* ── 대형 적 스폰 여유 공간 (owner: enemies/Spawner) ── */
/** 이 반경(m) 이상인 적은 구조물이 빽빽한 곳에 스폰하지 않는다. */
export const ENEMY_BIG_RADIUS = K.num('ENEMY_BIG_RADIUS');
/** 대형 적이 검사하는 원의 반경 = 자기 반경 × 이 값. */
export const ENEMY_SPAWN_CLEARANCE_MUL = K.num('ENEMY_SPAWN_CLEARANCE_MUL');
/** 검사 원 안의 장애물 점유 면적이 이 비율을 넘으면 그 지점을 버린다. */
export const ENEMY_SPAWN_BLOCK_RATIO = K.num('ENEMY_SPAWN_BLOCK_RATIO');
/** 버려진 지점을 다시 뽑는 최대 횟수. */
export const ENEMY_SPAWN_RETRIES = K.num('ENEMY_SPAWN_RETRIES');

/* ── 지형지물 위에 올라서기 (owner: world/WorldSystem) ── */
/** 걷다가 그냥 올라설 수 있는 장애물 윗면의 높이 차(m). 이보다 높으면 벽처럼 막힌다. */
export const PROP_STEP_UP_MAX = K.num('PROP_STEP_UP_MAX');
/** 장애물 윗면 판정에 쓰는 여유(m) — 가장자리에서 미끄러져 떨어지지 않게 한다. */
export const PROP_TOP_MARGIN = K.num('PROP_TOP_MARGIN');

/* ── 선로 회랑 (2026-09-10, owner: world/layout) ── */
/**
 * 선로 중심선 좌우로 **아무것도 놓지 않는** 회랑의 반폭(m). 구조물 · 폐허 전초 · 둥지 · 크레이터 ·
 * 소품 · 상자 · 채집 노드가 전부 이 거리를 비운다 — 검사는 `clearance + 그 물건의 반지름` 이다.
 * 플랫폼은 예외이고 그 자리는 `platform` 패드가 막는다.
 */
export const RAIL_CLEARANCE_M = K.num('RAIL_CLEARANCE_M');
/** 플랫폼 **호출 콘솔**의 홀드 시간(초). 운전실 시동(`TRAM_START_HOLD_S`)보다 길다 — 호출은 남이 타고
 * 있을 수도 있는 차를 통째로 불러오고, 잘못 부르면 분대가 반대편까지 걸어야 한다. */
export const TRAM_CALL_HOLD_S = K.num('TRAM_CALL_HOLD_S');
/** 플랫폼 호출 콘솔의 상호작용 거리(m). */
export const TRAM_CALL_RANGE = K.num('TRAM_CALL_RANGE');
/** 2026-09-10 — 「전차가 곧 출발합니다」 알림을 받는 거리(m, 차체 단면 바깥). 멀리서 부른 사람은 보지 않는다. */
export const TRAM_DEPART_NOTICE_RANGE = K.num('TRAM_DEPART_NOTICE_RANGE');

/* ── 핑 v3 (2026-09-09, owner: ui/hud/Pings) ── */
/** 한 플레이어가 동시에 유지하는 핑 수 (나도 분대원도). 넘치면 그 사람의 가장 오래된 핑이 사라진다. */
export const PING_MAX_PER_PLAYER = K.num('PING_MAX_PER_PLAYER');
/** 핑 조준 보정 — 조준점에서 이 화면 거리(px) 안의 적 · 아이템 · 상자 · 분대 핑은 정확히 맞추지 않아도 찍힌다. */
export const PING_AIM_ASSIST_PX = K.num('PING_AIM_ASSIST_PX');

/* ══ appended: 2026-09-09 — 레이드 플레이 개선 ═════════════════════════════════════════════════════════════
 * 값은 전부 `data/constants.csv` · `data/tables.csv` 다. 여기는 이름 · 주석 · 타입만 소유한다.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── 의사소통 휠 (owner: ui/hud/CommsWheel; 배치와 문구는 `shared/comms.ts`) ── */
/** `Keys.COMMS` 를 이만큼(초) 누르고 있어야 휠이 열린다. 짧게 톡 누르면 아무 일도 없다. */
export const COMMS_WHEEL_HOLD_S = K.num('COMMS_WHEEL_HOLD_S');
/** 휠 중심에서 이 화면 거리(px)를 넘겨야 한 칸이 선택된다 (포인터 락 델타 누적). */
export const COMMS_WHEEL_DEAD_PX = K.num('COMMS_WHEEL_DEAD_PX');
/** 같은 사람이 다시 한 마디를 보낼 수 있게 되기까지의 시간(초). */
export const COMMS_COOLDOWN_S = K.num('COMMS_COOLDOWN_S');

/* ── 버려진 구조물 (owner: world/Structures) ── */
/** 구조물 컴퓨터의 **행성 스캔**이 안개를 걷는 반경(m). 구조물당 1회. */
export const STRUCTURE_SCAN_RADIUS = K.num('STRUCTURE_SCAN_RADIUS');
/** 행성 스캔 콘솔의 홀드 시간(초). */
export const STRUCTURE_SCAN_HOLD_S = K.num('STRUCTURE_SCAN_HOLD_S');
/** 열쇠 · 키카드로 잠긴 문(전진기지 지하실 · 연구소 잠긴 방)을 여는 홀드 시간(초). */
export const STRUCTURE_UNLOCK_HOLD_S = K.num('STRUCTURE_UNLOCK_HOLD_S');
/** 구조물 문 · 컴퓨터 상호작용 거리(m). */
export const STRUCTURE_INTERACT_RANGE = K.num('STRUCTURE_INTERACT_RANGE');

/* ── 선로 · 전차 (owner: world/Rails) ── */
/** 구역에 선로가 놓일 확률 (0 = 언제나 없음). */
export const RAIL_CHANCE = K.num('RAIL_CHANCE');
/**
 * 구역에 **탐사 차량 흙길**이 놓일 확률 (0 = 언제나 없음). 2026-09-14 (사용자 결정) — 선로와 같은 확률 배치.
 * 전에는 굴림 없이 늘 계획해 실측 배치율이 100 % 였고, 그러면 정보상의 「탐사 차량 확정」 줄이 아무것도 사지 못한다.
 * 굴림은 `world/layout.ts` 가 **탐사 차량 전용 fork 의 첫 draw** 로 소비한다 — 정보상으로 확정해도 그 draw 는 그대로다.
 */
export const ROVER_CHANCE = K.num('ROVER_CHANCE');
/** 전차 **최고** 주행 속도(m/s). 2026-09-10: 출발 직후가 아니라 `TRAM_ACCEL_S` 에 걸쳐 여기까지 오른다. */
export const TRAM_SPEED = K.num('TRAM_SPEED');
/** 플랫폼 콘솔에서 전차에 시동을 거는 홀드 시간(초). */
export const TRAM_START_HOLD_S = K.num('TRAM_START_HOLD_S');
/** 2026-09-10 — 시동 알림이 뜬 뒤 전차가 실제로 움직이기 시작할 때까지의 시간(초). */
export const TRAM_START_DELAY_S = K.num('TRAM_START_DELAY_S');
/** 2026-09-10 — 움직이기 시작한 뒤 `TRAM_SPEED` 에 닿을 때까지의 시간(초). 가속 곡선은 cubic ease-in. */
export const TRAM_ACCEL_S = K.num('TRAM_ACCEL_S');
/** 전차가 플랫폼에 정차해 있는 시간(초). */
export const TRAM_DOCK_S = K.num('TRAM_DOCK_S');

/* ── 로그 강하 (owner: enemies/RogueDrop) ── */
/** 구조물 · 플랫폼을 조사할 때 강하가 트리거될 확률. **구역당 한 번만** 굴린다. */
export const ROGUE_DROP_CHANCE = K.num('ROGUE_DROP_CHANCE');
/** 예고에서 착지까지의 시간(초). */
export const ROGUE_DROP_ETA_S = K.num('ROGUE_DROP_ETA_S');
/** 착지 지점이 흩어지는 반경(m). */
export const ROGUE_DROP_RADIUS = K.num('ROGUE_DROP_RADIUS');
/** 강하 인원의 하한 — **index 0 = 분대 1명**, 3 = 분대 4명 (`data/tables.csv`). */
export const ROGUE_DROP_COUNT_MIN = numberList('tables.csv', 'ROGUE_DROP_COUNT_MIN');
/** 강하 인원의 상한 (같은 색인 규칙). */
export const ROGUE_DROP_COUNT_MAX = numberList('tables.csv', 'ROGUE_DROP_COUNT_MAX');
/** 그 강하에 **로그 분대장**이 섞일 확률 (같은 색인 규칙: 1명 0 · 2명 0.5 · 3명 이상 1). */
export const ROGUE_DROP_BOSS_CHANCE = numberList('tables.csv', 'ROGUE_DROP_BOSS_CHANCE');
/**
 * 2026-09-10 — 탈출 웨이브 규모 배수 (index 0 = 분대 1명 … 3 = 분대 4명).
 * 웨이브 표는 4인 분대 기준이라 1인 분대가 세 번째 웨이브에서 점프 사냥꾼 두 마리를 한꺼번에 받았다.
 * 로그 강하(`ROGUE_DROP_*`)가 이미 쓰던 것과 같은 "분대 인원별 표" 규약이다.
 */
export const WAVE_SQUAD_SCALE = numberList('tables.csv', 'WAVE_SQUAD_SCALE');

/* ── 환경 재해 (owner: world/Hazard) ── */
/** 재해 시작 시각의 하한(초, 레이드 시작 기준). */
export const HAZARD_START_MIN_S = K.num('HAZARD_START_MIN_S');
/** 재해 시작 시각의 상한(초). */
export const HAZARD_START_MAX_S = K.num('HAZARD_START_MAX_S');
/** 시작 시각을 이 간격(초)으로 끊어 뽑는다 — 6분 30초 · 7분 00초 같은 값만 나온다. */
export const HAZARD_START_STEP_S = K.num('HAZARD_START_STEP_S');
/** 시작 이 초 전에 예고(`hazard:announced`)가 나간다. */
export const HAZARD_WARN_S = K.num('HAZARD_WARN_S');
/** 피해 구역 안에서 초당 받는 피해. */
export const HAZARD_DPS = K.num('HAZARD_DPS');
/** 피해를 주는 주기(초). */
export const HAZARD_TICK_S = K.num('HAZARD_TICK_S');
/** 재해가 시작해서 **맵을 완전히 덮기까지**의 시간(초). 이후에는 안전지대가 없다 = 사실상 강제 탈출. */
export const HAZARD_FULL_S = K.num('HAZARD_FULL_S');
/** 피해 구역 안에서 포그 농도에 곱하는 배수 (`atmo:override.fogMul`). */
export const HAZARD_FOG_MUL = K.num('HAZARD_FOG_MUL');
/** 구역 경계의 페더 폭(m) — 화면 효과가 이 폭에 걸쳐 서서히 올라온다. */
export const HAZARD_EDGE_M = K.num('HAZARD_EDGE_M');
/** 폭풍의 눈: 처음 안전 원의 반경(m). */
export const STORM_EYE_RADIUS_START = K.num('STORM_EYE_RADIUS_START');
/** 폭풍의 눈: 끝까지 좁아졌을 때의 반경(m). */
export const STORM_EYE_RADIUS_END = K.num('STORM_EYE_RADIUS_END');
/** 독성 포자만은 시작 시각이 고정이다(초) — 6분. */
export const SPORE_START_S = K.num('SPORE_START_S');
/** 거대 버섯 군락(= 포자 발생지)의 최소 개수. */
export const SPORE_SOURCES_MIN = K.num('SPORE_SOURCES_MIN');
/** 거대 버섯 군락의 최대 개수. */
export const SPORE_SOURCES_MAX = K.num('SPORE_SOURCES_MAX');
/** 발생지가 하나씩 더 피어오르는 간격(초). */
export const SPORE_SOURCE_INTERVAL_S = K.num('SPORE_SOURCE_INTERVAL_S');
/** 발생지 하나가 끝까지 자랐을 때의 반경(m). */
export const SPORE_RADIUS_MAX = K.num('SPORE_RADIUS_MAX');
/** 발생지 반경이 자라는 속도(m/s). */
export const SPORE_GROWTH_MPS = K.num('SPORE_GROWTH_MPS');

/* ══ 발소리 (2026-09-10) ══════════════════════════════════════════════════════════════════════════════
 * 로컬 플레이어 본인의 발소리는 **감쇠 대상이 아니다** — 늘 같은 크기로 들린다. 원격 분대원만
 * `(1 - d / FOOTSTEP_AUDIBLE_RANGE) ^ FOOTSTEP_FALLOFF_EXP` 로 줄어들고 사거리 밖이면 재생조차 하지 않는다.
 */
/** 원격 분대원 발소리가 들리는 최대 거리(m). */
export const FOOTSTEP_AUDIBLE_RANGE = K.num('FOOTSTEP_AUDIBLE_RANGE');
/** 거리 감쇠 곡선의 지수 — 크게 할수록 가까이서만 들린다. */
export const FOOTSTEP_FALLOFF_EXP = K.num('FOOTSTEP_FALLOFF_EXP');
/** 원격 발소리에 곱하는 기본 배수 (거리 감쇠를 먹기 전). */
export const FOOTSTEP_REMOTE_GAIN = K.num('FOOTSTEP_REMOTE_GAIN');
/** 달리기 발소리 크기. */
export const FOOTSTEP_VOL_SPRINT = K.num('FOOTSTEP_VOL_SPRINT');
/** 걷기 발소리 크기. */
export const FOOTSTEP_VOL_WALK = K.num('FOOTSTEP_VOL_WALK');
/** 웅크림 발소리 크기. */
export const FOOTSTEP_VOL_CROUCH = K.num('FOOTSTEP_VOL_CROUCH');
/** 엎드림(기어가기) 발소리 크기. */
export const FOOTSTEP_VOL_PRONE = K.num('FOOTSTEP_VOL_PRONE');
/** 한 사람의 발소리 사이 최소 간격(초) — 스냅샷이 튀어도 연발되지 않는다. */
export const FOOTSTEP_MIN_INTERVAL_S = K.num('FOOTSTEP_MIN_INTERVAL_S');

/* ── appended: 적이 벽에 대고 쏘지 않게 (2026-09-10) ────────────────────────── */
/**
 * 원거리 적이 사격할 때 총구와 장애물 사이에 두어야 하는 최소 거리(m).
 * 사선 검사(`enemies/ai/FireLine`)는 총구에서 이만큼 **뒤로** 물러난 지점에서 레이를 쏜다 —
 * 총구가 벽 안에 박혀 있으면 벽 안쪽에서 밖으로 쏘게 되어 "뚫렸다" 로 읽히기 때문이다.
 */
export const ENEMY_WALL_STANDOFF = K.num('ENEMY_WALL_STANDOFF');
/** 총구 → 표적 사선 검사 주기(초). 적별로 결과를 캐시한다(핫 패스). */
export const ENEMY_FIRE_LOS_S = K.num('ENEMY_FIRE_LOS_S');
/** 사선이 막힌 원거리 적이 한 번에 옆으로 비켜서는 시간(초). */
export const ENEMY_FIRE_STRAFE_S = K.num('ENEMY_FIRE_STRAFE_S');

/* == 방탄복 = 실드 (2026-09-10) ====================================================================
 * 방탄복은 피해를 깎지 않고 **실드(추가 체력)** 를 준다. 실드량 자체는 `data/armor.csv` 의 `shield`
 * (번호 방탄복은 `tables.csv` 의 `ARMOR_SHIELD_BY_TIER`)이고, 여기 있는 것은 HUD 게이지의 눈금뿐이다.
 */
/** 좌하단 체력 · 실드 게이지 한 칸이 나타내는 양 (체력 100 = 5칸, 방탄복 V 실드 100 = 5칸). */
export const ARMOR_SHIELD_PER_SEGMENT = K.num('ARMOR_SHIELD_PER_SEGMENT');

/* ══ 위험 인디케이터 (2026-09-10) ══════════════════════════════════════════════════════════════════════
 * `ui/hud/DangerIndicators` 가 곡사포탄 · 수류탄 · 함선 호출 낙하물을 하나의 언어로 그린다. 포탄에만 걸려 있던
 * 인지력 반경(`derived.enemyDetectRadius`) 게이트는 그대로 두되, **착탄 지점이 이 거리 안이면 인지력과 무관하게**
 * 보여 준다 — 인디케이터의 목적이 "날아오는 줄도 모르는 것" 을 알리는 것이기 때문이다.
 */
/** 인지력 반경 밖이라도 무조건 경고하는 착탄 거리(m). */
export const DANGER_NEAR_RADIUS = K.num('DANGER_NEAR_RADIUS');

/* ══ 로그 강하 경보 (2026-09-10) ══════════════════════════════════════════════════════════════════════
 * 강하는 대기를 찢으며 떨어지는 굉음이라 **평소의 인지력 게이트를 쓰지 않는다** — 경보음도 HUD 위험 표시도
 * `ROGUE_DROP_ALERT_RADIUS`(인지력 `DETECT_ENEMY_BASE_RADIUS` 26 m 의 10 배) 하나만 본다. 그 대신
 * **거리 감쇠는 남긴다**: 원격 발소리(`FOOTSTEP_*`)와 같은 철학이라 반경 밖은 아예 재생하지 않고 안쪽은
 * `(1 - d / radius) ^ ROGUE_DROP_ALERT_FALLOFF_EXP` 를 곱한다. 소유자는 `audio/AudioSystem`(소리) 과
 * `ui/hud/DangerIndicators`(표시)이고, 강하 자체의 규칙은 `enemies/RogueDrop` 그대로다.
 */
/** 강하 경보 전용 반경(m). 이 안이면 인지력과 무관하게 들리고 보인다. */
export const ROGUE_DROP_ALERT_RADIUS = K.num('ROGUE_DROP_ALERT_RADIUS');
/** 강하음의 거리 감쇠 지수 — `(1 - d / ROGUE_DROP_ALERT_RADIUS) ^ exp`. */
export const ROGUE_DROP_ALERT_FALLOFF_EXP = K.num('ROGUE_DROP_ALERT_FALLOFF_EXP');
/** 강하 경보음(`rogue_drop_alarm`)의 밑 크기 — 거리 감쇠를 먹기 전. */
export const ROGUE_DROP_ALARM_VOLUME = K.num('ROGUE_DROP_ALARM_VOLUME');
/** 강하 낙하음(`rogue_pod_fall`)의 밑 크기 — 거리 감쇠를 먹기 전. */
export const ROGUE_DROP_FALL_VOLUME = K.num('ROGUE_DROP_FALL_VOLUME');
/** 이 크기 밑으로 줄어든 강하음은 보이스를 만들지 않는다. */
export const ROGUE_DROP_MIN_VOLUME = K.num('ROGUE_DROP_MIN_VOLUME');
/** 착지 몇 초 전에 낙하 굉음이 시작되는가 (`rogue_pod_fall` 의 길이와 맞춘다). */
export const ROGUE_DROP_FALL_LEAD_S = K.num('ROGUE_DROP_FALL_LEAD_S');

/* ══ 전차 탑승 · 전차 충돌 · 플랫폼 계단 (2026-09-10) ═════════════════════════════════════════════════
 * 값은 전부 `data/constants.csv`. 소유자는 `player/PlayerController`(RIDE_*) 와 `world/Rails`(TRAM_HIT_* ·
 * TRAM_CONSOLE_RANGE · RAIL_STAIR_*).
 *
 * **왜 `Obstacle.velocity` 만으로는 모자랐나**: 예전에는 "지금 밟고 있는 발판" 을 매 프레임 새로 찾아
 * 그 속도를 위치에 더했다. 한 프레임이라도 발판 질의에서 빠지면(점프 · 경사 · 문틈) 그 프레임만큼 차량이
 * 발밑에서 빠져나가고, 몇 프레임이면 차 밖이다. 그래서 **탑승을 상태로 들고**(진입 · 유지 · 이탈) 유지 조건을
 * 발판 질의가 아니라 **차량 OBB + 헤드룸**으로 본다.
 */
/** 발판 윗면에서 이 높이(m) 안이면 아직 탑승 — 점프해도 차량과 함께 날아간다. */
export const RIDE_HEADROOM = K.num('RIDE_HEADROOM');
/** 발판 윗면보다 이만큼(m) 아래까지는 아직 탑승 (경사 · 프레임 요동 여유). */
export const RIDE_FOOT_DROP = K.num('RIDE_FOOT_DROP');
/** 차량 콜라이더 단면 밖으로 이만큼(m) 벗어나도 아직 탑승. */
export const RIDE_EDGE_MARGIN = K.num('RIDE_EDGE_MARGIN');
/** 하차 뒤 차량 관성이 남아 있는 최대 시간(초). */
export const RIDE_INERTIA_S = K.num('RIDE_INERTIA_S');
/** 하차 관성의 지수 감쇠 계수(1/초). */
export const RIDE_INERTIA_DAMP = K.num('RIDE_INERTIA_DAMP');

/** 이 속도(m/s) 밑으로 달리는 전차는 부딪혀도 안전하다. */
export const TRAM_HIT_SPEED_MIN = K.num('TRAM_HIT_SPEED_MIN');
/** `TRAM_SPEED` 로 달리는 전차에 치였을 때의 피해 (실제 피해는 그때 속도에 비례). */
export const TRAM_HIT_DAMAGE = K.num('TRAM_HIT_DAMAGE');
/** 치였을 때 튕겨 나가는 속도(m/s, 최고 속도 기준). */
export const TRAM_HIT_KNOCKBACK = K.num('TRAM_HIT_KNOCKBACK');
/** 같은 사람이 다시 치일 수 있게 되기까지의 시간(초). */
export const TRAM_HIT_COOLDOWN_S = K.num('TRAM_HIT_COOLDOWN_S');
/** 전차 바닥보다 발이 이만큼(m) 아래여야 치인 것 — 탑승자 · 플랫폼 위를 판정에서 빼는 값이다. */
export const TRAM_HIT_FLOOR_CLEAR = K.num('TRAM_HIT_FLOOR_CLEAR');
/** 전차 바닥에서 아래로 이만큼(m) 까지가 치이는 높이 범위. */
export const TRAM_HIT_REACH = K.num('TRAM_HIT_REACH');
/** 전차 운전실 콘솔의 상호작용 거리(m). */
export const TRAM_CONSOLE_RANGE = K.num('TRAM_CONSOLE_RANGE');

/** 플랫폼 계단 한 단의 최대 높이(m) — `PROP_STEP_UP_MAX` 보다 낮아야 걸어 올라간다. */
export const RAIL_STAIR_MAX_RISE = K.num('RAIL_STAIR_MAX_RISE');
/** 플랫폼 계단 한 단의 깊이(m). */
export const RAIL_STAIR_DEPTH = K.num('RAIL_STAIR_DEPTH');

/* ── 2026-09-10: 셰이더 선컴파일 · 광원 예산 (owner: core/LightBudget · core/ShaderWarmup · hub/interiors/LightPool) ── */
/** 씬에 늘 보이는 점광원 개수 — 모자란 만큼 intensity 0 여분이 채운다 (`core/LightBudget`). 레이드의 실제 개수와 같게 둔다. */
export const SCENE_POINT_LIGHT_BUDGET = K.num('SCENE_POINT_LIGHT_BUDGET');
/** 함선 인테리어가 한꺼번에 켜는 점광원 개수 — 플레이어에게 가까운 광원 자리부터 (`hub/interiors/LightPool`). */
export const HUB_POINT_LIGHTS = K.num('HUB_POINT_LIGHTS');
/** 셰이더 선컴파일을 기다리며 화면을 멈춰 두는 최대 시간(초, `ctx.shaders`). */
export const SHADER_WARMUP_TIMEOUT_S = K.num('SHADER_WARMUP_TIMEOUT_S');

/* ── 2026-09-11: 구조물 조명 · 사다리 · 계단 보간 · 투척 궤적 · 옥상 스캐너 ── */
/** 버려진 구조물이 한꺼번에 켜는 점광원 개수 — 플레이어에게 가까운 광원 자리부터 (`world/Structures`). */
export const STRUCTURE_POINT_LIGHTS = K.num('STRUCTURE_POINT_LIGHTS');
/** 옥상 맵 스캐너의 파동이 맵 끝까지 퍼지는 시간(초). */
export const STRUCTURE_SCAN_WAVE_S = K.num('STRUCTURE_SCAN_WAVE_S');
/** 사다리 발치 · 꼭대기에서 매달릴 수 있는 거리(m). */
export const LADDER_GRAB_RANGE = K.num('LADDER_GRAB_RANGE');
/** 사다리 오르내리기 속도(m/s). */
export const LADDER_CLIMB_SPEED = K.num('LADDER_CLIMB_SPEED');
/** 달리기 키를 누른 채 오르내리는 속도(m/s, 스태미나 소모). */
export const LADDER_SPRINT_SPEED = K.num('LADDER_SPRINT_SPEED');
/** 사다리에서 빠르게 오르내리는 동안 초당 스태미나 소모. */
export const LADDER_SPRINT_DRAIN = K.num('LADDER_SPRINT_DRAIN');
/** 사다리 점프 — 사다리를 놓고 위로 뛰는 속도(m/s). */
export const LADDER_JUMP_SPEED = K.num('LADDER_JUMP_SPEED');
/** 사다리 점프의 수평 속도(m/s, 사다리 너머 = `-LadderDef.normal` 방향). */
export const LADDER_JUMP_PUSH = K.num('LADDER_JUMP_PUSH');
/** E 로 사다리를 놓을 때 떨어져 나가는 수평 속도(m/s, `+LadderDef.normal` 방향). */
export const LADDER_DROP_PUSH = K.num('LADDER_DROP_PUSH');
/** 꼭대기에서 옥상으로 올라서는 동작 길이(초). */
export const LADDER_MOUNT_S = K.num('LADDER_MOUNT_S');
/** 단차를 오르내릴 때 모델이 물리 위치를 따라잡는 감쇠 계수(1/초). */
export const STEP_SMOOTH_RATE = K.num('STEP_SMOOTH_RATE');
/** 이보다 큰 한 프레임 높이 변화(m)는 보간하지 않는다 (순간이동). */
export const STEP_SMOOTH_MAX = K.num('STEP_SMOOTH_MAX');
/** 투척 궤적 미리보기가 그리는 비율 (실제 수평 비거리의 이만큼, 착지 표시 없음). */
export const THROW_ARC_PREVIEW_FRACTION = K.num('THROW_ARC_PREVIEW_FRACTION');
/**
 * 뜬 상자 콜라이더의 밑면이 발에서 이만큼(m) 위면 몸을 밀어내지 않는다 (`world/obb` · `world/WorldSystem.resolveCollision`).
 * `player/PlayerController` 의 점프 천장 클램프가 같은 값을 쓴다 (2026-09-11 — 그 전에는 두 폴더가 2.1 을 따로 적었다).
 */
export const BOX_HEADROOM = K.num('BOX_HEADROOM');

/* ── 2026-09-11: 설치 미리보기 · 원격 지뢰 (owner: gadgets) ── */
/** 손에 든 설치형 가젯을 조준점에 놓을 수 있는 최대 거리(m, 발에서 수평). */
export const GADGET_PLACE_RANGE = K.num('GADGET_PLACE_RANGE');
/** 대형 설치물(바리케이드 · 점프대 · 포탑)이 서는 바닥의 최소 법선 y (1 = 완전 평지). */
export const GADGET_PLACE_LARGE_MIN_NORMAL_Y = K.num('GADGET_PLACE_LARGE_MIN_NORMAL_Y');
/** 소형 설치물(지뢰 · 원격 지뢰)이 서는 바닥의 최소 법선 y. */
export const GADGET_PLACE_SMALL_MIN_NORMAL_Y = K.num('GADGET_PLACE_SMALL_MIN_NORMAL_Y');
/** 대형 설치물 발자국 안의 바닥 높이 차가 이보다 크면 설치 불가(m). */
export const GADGET_PLACE_LARGE_MAX_STEP = K.num('GADGET_PLACE_LARGE_MAX_STEP');
export const GADGET_REMOTE_MINE_DAMAGE = K.num('GADGET_REMOTE_MINE_DAMAGE');
export const GADGET_REMOTE_MINE_RADIUS = K.num('GADGET_REMOTE_MINE_RADIUS');
export const GADGET_REMOTE_MINE_ARM_TIME = K.num('GADGET_REMOTE_MINE_ARM_TIME');
export const GADGET_REMOTE_MINE_HP = K.num('GADGET_REMOTE_MINE_HP');
/** 같은 기폭에서 한 대상이 두 번째 이후로 맞는 원격 지뢰의 피해 배수 (첫 발 = 가장 센 한 발만 온전히). */
export const GADGET_REMOTE_MINE_STACK_MUL = K.num('GADGET_REMOTE_MINE_STACK_MUL');
/** 한 플레이어가 동시에 월드에 둘 수 있는 원격 지뢰 수 (넘으면 가장 오래된 것부터 사라진다). */
export const GADGET_REMOTE_MINE_MAX_LIVE = K.num('GADGET_REMOTE_MINE_MAX_LIVE');
/** 드론 위에 올린 지뢰가 적을 감지하는 반경(m) — 움직이는 드론이라 바닥 지뢰(1.5 m)보다 넓다. 적만 감지한다. */
export const GADGET_MOUNTED_MINE_TRIGGER_RADIUS = K.num('GADGET_MOUNTED_MINE_TRIGGER_RADIUS');
/** 설치 자리가 발 높이에서 위아래로 이만큼(m) 넘게 벗어나면 `너무 멀다` (gadgets/parts/Preview). */
export const GADGET_PLACE_VERTICAL_REACH = K.num('GADGET_PLACE_VERTICAL_REACH');

/* ── 2026-09-11: 드론 (owner: gadgets/drones — shared/drones.ts) ── */
/** 드론 아이템을 손에 들고 조종을 잡기까지 R 을 누르는 시간(초). 조종 중 같은 홀드로 PC 로 돌아온다. */
export const DRONE_CONTROL_HOLD_S = K.num('DRONE_CONTROL_HOLD_S');
/** 사거리 비율이 이 값을 넘으면 화면 외곽이 지지직거린다. */
export const DRONE_LINK_WARN_RATIO = K.num('DRONE_LINK_WARN_RATIO');
export const DRONE_GROUND_HP = K.num('DRONE_GROUND_HP');
export const DRONE_AIR_HP = K.num('DRONE_AIR_HP');
/** 소유자 PC 로부터 조종이 유지되는 거리(m, 3D). */
export const DRONE_GROUND_RANGE = K.num('DRONE_GROUND_RANGE');
export const DRONE_AIR_RANGE = K.num('DRONE_AIR_RANGE');
/** 지상 드론 걷기 속도 = `PLAYER_WALK_SPEED` × 이 값 (조용함, 어그로 없음). */
export const DRONE_GROUND_WALK_MUL = K.num('DRONE_GROUND_WALK_MUL');
/** 지상 드론 질주 속도 = `PLAYER_SPRINT_SPEED` × 이 값 (스태미나 없음, 소리 · 어그로). */
export const DRONE_GROUND_SPRINT_MUL = K.num('DRONE_GROUND_SPRINT_MUL');
/** 지상 드론 점프의 최고 높이(m) — PC 눈높이. */
export const DRONE_GROUND_JUMP_HEIGHT = K.num('DRONE_GROUND_JUMP_HEIGHT');
/** 질주하는 지상 드론의 소음이 적에게 들리는 반경(m). */
export const DRONE_NOISE_RADIUS = K.num('DRONE_NOISE_RADIUS');
/** 질주를 멈춘 뒤에도 적이 드론을 노릴 수 있는 시간(초) = `DroneRef.aggroable`. */
export const DRONE_NOISE_MEMORY_S = K.num('DRONE_NOISE_MEMORY_S');
/** `world:noise` 를 드론 하나당 초당 최대 몇 번 내는가. */
export const DRONE_NOISE_EMIT_HZ = K.num('DRONE_NOISE_EMIT_HZ');
export const DRONE_AIR_SPEED = K.num('DRONE_AIR_SPEED');
export const DRONE_AIR_CLIMB_SPEED = K.num('DRONE_AIR_CLIMB_SPEED');
/** 공중 드론이 지형(또는 발밑 표면) 위로 오를 수 있는 최대 고도(m). */
export const DRONE_AIR_MAX_ALTITUDE = K.num('DRONE_AIR_MAX_ALTITUDE');
/** 드론 옆에서 E 를 누르고 있어야 회수되는 시간(초). */
export const DRONE_RECOVER_HOLD_S = K.num('DRONE_RECOVER_HOLD_S');
/** `drone state` 방송 빈도(Hz). */
export const DRONE_NET_HZ = K.num('DRONE_NET_HZ');
/** 지상 드론을 PC 정면 몇 m 에 내려놓는가 · 공중 드론을 PC 눈 앞 몇 m / 위 몇 m 에 띄우는가. */
export const DRONE_DEPLOY_DIST_GROUND = K.num('DRONE_DEPLOY_DIST_GROUND');
export const DRONE_DEPLOY_DIST_AIR = K.num('DRONE_DEPLOY_DIST_AIR');
export const DRONE_DEPLOY_LIFT_AIR = K.num('DRONE_DEPLOY_LIFT_AIR');
/** 지상 드론 가속 · 제동 · 점프 중 조향 가속 (m/s²). */
export const DRONE_GROUND_ACCEL = K.num('DRONE_GROUND_ACCEL');
export const DRONE_GROUND_BRAKE = K.num('DRONE_GROUND_BRAKE');
export const DRONE_GROUND_AIR_ACCEL = K.num('DRONE_GROUND_AIR_ACCEL');
/** 공중 드론 회수 반경 가산(m). */
export const DRONE_RECOVER_AIR_BONUS = K.num('DRONE_RECOVER_AIR_BONUS');
/** 공중 드론 수평 가속 응답(1/s) · 몸 밑 최소 여유(m). */
export const DRONE_AIR_ACCEL = K.num('DRONE_AIR_ACCEL');
export const DRONE_AIR_MIN_CLEARANCE = K.num('DRONE_AIR_MIN_CLEARANCE');

/* ── 2026-09-11: 네임드 로그 (owner: enemies — shared/named.ts) ── */
/** 레이드 시작 스폰 지점에서 네임드가 서지 않는 최소 거리(m). */
export const NAMED_ROGUE_MIN_SPAWN_DIST = K.num('NAMED_ROGUE_MIN_SPAWN_DIST');
/** 네임드 확정 드롭 장비의 내구도 범위 (최대 내구도 비율). */
export const NAMED_LOOT_DURABILITY_MIN = K.num('NAMED_LOOT_DURABILITY_MIN');
export const NAMED_LOOT_DURABILITY_MAX = K.num('NAMED_LOOT_DURABILITY_MAX');
/** 레이드에 네임드가 (셋 중 하나) 등장할 확률 — index 0 = 행성 난이도 1 … 4 = 5 (`planetTier − 1`). */
export const NAMED_ROGUE_CHANCE_BY_RANK: readonly number[] = numberList('tables.csv', 'NAMED_ROGUE_CHANCE_BY_RANK');
/** 헤비의 SMG 호위 인원 — index 0 = 분대 1명 … 3 = 4명. */
export const NAMED_HEAVY_ESCORTS_BY_SQUAD: readonly number[] = numberList('tables.csv', 'NAMED_HEAVY_ESCORTS_BY_SQUAD');

/* ── 2026-09-11: C 항목 배치 (커밋 `36e15e3`(계약)) ── */
/** 재해 구역 안의 적이 받는 조용한 초당 피해 (C-14, owner: enemies — world/Hazard 가 구역을 정한다). */
export const HAZARD_ENEMY_DPS = K.num('HAZARD_ENEMY_DPS');
/** 채집 노드 수량 굴림 (C-20, owner: world/Gather) — 고철 2개 · 약초 2개 확률, 고철 부가 코어 확률 · 개수. */
export const GATHER_SALVAGE_QTY2_CHANCE = K.num('GATHER_SALVAGE_QTY2_CHANCE');
export const GATHER_HERB_QTY2_CHANCE = K.num('GATHER_HERB_QTY2_CHANCE');
export const GATHER_SALVAGE_CORE_CHANCE = K.num('GATHER_SALVAGE_CORE_CHANCE');
export const GATHER_SALVAGE_CORE_QTY = K.num('GATHER_SALVAGE_CORE_QTY');
/** 2026-09-13 (owner: world/Gather): 고철 더미의 부가 미확인 광물(`spec_mineral`) 확률 · 개수 — 코어와 같은 규약, 자기 fork `gather_mineral`. */
export const GATHER_SALVAGE_MINERAL_CHANCE = K.num('GATHER_SALVAGE_MINERAL_CHANCE');
export const GATHER_SALVAGE_MINERAL_QTY = K.num('GATHER_SALVAGE_MINERAL_QTY');
/** 장착 가방이 레이드 1회마다 잃는 내구도 (C-36, owner: inventory). */
export const BAG_DURABILITY_PER_RAID = K.num('BAG_DURABILITY_PER_RAID');

/* ── 2026-09-11: 소셜 · 신뢰 · 연결 (커밋 `9bd72ce`(계약) · `b3fc2f0`(구현)) ── */
/** E-4 (owner: shared/buffRules — implants · gadgets 가 쓴다): 버프 사거리 여유(m). */
export const BUFF_RANGE_SLACK = K.num('BUFF_RANGE_SLACK');
/** E-4: 받는 쪽 치유 토큰 버킷 배수. */
export const BUFF_HEAL_RATE_MARGIN = K.num('BUFF_HEAL_RATE_MARGIN');
/** E-4 (owner: meta): 분대원 contractHit 초당 허용량 (보낸 사람 · 목표마다). */
export const META_HIT_RATE = K.num('META_HIT_RATE');
/** E-4 (owner: stratagems): 호스트가 받는 함선 호출의 최대 거리(m). */
export const STRAT_MAX_CALL_RANGE = K.num('STRAT_MAX_CALL_RANGE');
/* appended (2026-09-11, E-4 ⑤ — 추가만) */
/** E-4 (owner: stratagems): 호스트의 호출자별 공유 쿨타임 여유(초). */
export const STRAT_COOLDOWN_SLACK_S = K.num('STRAT_COOLDOWN_SLACK_S');
/** E-4 (owner: shared/buffRules): 받는 쪽 치유 버킷 크기(초). */
export const BUFF_HEAL_BURST_S = K.num('BUFF_HEAL_BURST_S');
/** E-4 (owner: enemies): 호스트가 받는 hit 요청의 보낸 사람별 초당 피해 상한 · 버킷 크기(초). */
export const HIT_REQUEST_DPS_MAX = K.num('HIT_REQUEST_DPS_MAX');
export const HIT_REQUEST_BURST_S = K.num('HIT_REQUEST_BURST_S');
/** X-6 (owner: enemies): 넉백 요청 기하 검사의 거리 여유(m). */
export const HIT_KNOCKBACK_RANGE_SLACK = K.num('HIT_KNOCKBACK_RANGE_SLACK');
/** C-57 (owner: world): `crate opened` 거리 검사의 여유(m). */
export const CRATE_OPEN_RANGE_SLACK = K.num('CRATE_OPEN_RANGE_SLACK');
/* appended (2026-09-11, E-8 — docs/DECISIONS.md 「2026-09-11 — 신뢰 경로의 남은 틈」 — 추가만) */
/** E-8 (owner: enemies): explode 요청의 거리 검사 여유(m). 기준은 `STRAT_MAX_CALL_RANGE` 다. */
export const EXPLODE_REQUEST_RANGE_SLACK = K.num('EXPLODE_REQUEST_RANGE_SLACK');
/** E-8 (owner: enemies): 상태이상 요청의 거리 검사 여유(m). 기준은 `max(FLAME_RANGE, SHOCK_RANGE)` 다. */
export const STATUS_REQUEST_RANGE_SLACK = K.num('STATUS_REQUEST_RANGE_SLACK');
/** E-8 (owner: enemies): 상태이상 요청의 보낸 사람별 초당 건수 상한 · 버킷 크기(초). */
export const STATUS_REQUEST_RATE_MAX = K.num('STATUS_REQUEST_RATE_MAX');
export const STATUS_REQUEST_BURST_S = K.num('STATUS_REQUEST_BURST_S');
/** E-5 (owner: game/SoloRaid): 시계 역행 허용 폭(ms). */
export const SOLO_CLOCK_BACK_TOLERANCE_MS = K.num('SOLO_CLOCK_BACK_TOLERANCE_MS');
/** E-5: 지금까지 본 가장 늦은 `Date.now()` 를 적어 두는 키 (`slotKey` 를 통과시킨다). */
export const SOLO_CLOCK_HIGH_KEY = 'scav.clockHigh';
/** B-4 (owner: net/SocialSync): 개인 대화(옛 귓속말) 기록 — 상대당 줄 수 · 상대 수 · 키(`slotKey`). */
export const WHISPER_HISTORY_PER_PEER = K.num('WHISPER_HISTORY_PER_PEER');
export const WHISPER_HISTORY_PEERS = K.num('WHISPER_HISTORY_PEERS');
export const WHISPER_STORAGE_KEY = 'scav.whispers';

/* ── 2026-09-11: 연구실 — 분석기 · 행성 환경 (A-12 · A-13) ──
 * 2026-09-16 (사용자 결정): 옛 `ANALYZE_DEX_SPEEDUP`(도감 진척률 × 0.5) · `ANALYZE_KNOWN_SPEEDUP`(아는 표본이면 ×0.6)
 * 두 항은 **삭제**됐다 — 아래 `ANALYSIS_*` 다섯 항이 대신한다. csv 줄도 함께 지웠다: 읽는 코드가 없는 키는
 * `npm run data:check` 가 「아무도 읽지 않는 키」로 잡으므로 코드와 csv 를 한 번에 치워야 한다. */

/* ── 2026-09-16 (사용자 결정): 해석 시간 단축의 새 규칙 (owner: housing) ──
 * 옛 `ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP` 두 항을 대체한다. 바뀐 점은 둘이다:
 *   ① 도감 보너스는 「그 종류의 해석이 빨라진다」가 아니라 **도감을 한 칸 채울 때마다 같은 등급 표본 전체**가 빨라진다.
 *   ② 같은 표본을 거듭 해석하면 그 표본의 **레벨**이 올라 보너스가 더 붙되, 곡선을 앞으로 몰아 놨다 —
 *      처음 해석해 레벨 1 이 되는 순간 `FIRST`(+3 %)를 통째로 주고, 그 뒤 한 레벨마다 `STEP`(+0.5 %)만 얹는다.
 *      「처음 등록했을 때 보너스를 많이 주는 식」이라는 사용자 요구가 이 두 값의 차이 그 자체다.
 * 도감 + 레벨을 **더한** 단축은 `ANALYSIS_SPEEDUP_CAP` 에서 잘린다. 계열 분석 레벨의 시간 배수
 * (`ANALYSIS_TIME_MUL_BY_LEVEL`) 는 이것과 별개로 곱해진다.
 */
/** 해석 도감 한 칸마다, **같은 등급** 표본의 해석 시간이 줄어드는 비율. */
export const ANALYSIS_DEX_BONUS_PER_ENTRY = K.num('ANALYSIS_DEX_BONUS_PER_ENTRY');
/** 그 표본을 처음 해석해 레벨 1 이 됐을 때의 단축 — 레벨당 증분보다 훨씬 크다 (앞으로 몰아 놓은 곡선). */
export const ANALYSIS_SAMPLE_LEVEL_FIRST = K.num('ANALYSIS_SAMPLE_LEVEL_FIRST');
/** 레벨 1 이후 한 레벨 오를 때마다 더 붙는 단축. */
export const ANALYSIS_SAMPLE_LEVEL_STEP = K.num('ANALYSIS_SAMPLE_LEVEL_STEP');
/** 한 표본의 레벨 상한. */
export const ANALYSIS_SAMPLE_LEVEL_MAX = K.num('ANALYSIS_SAMPLE_LEVEL_MAX');
/** 도감 + 표본 레벨을 더한 단축의 상한 (0.5 = 절반까지). */
export const ANALYSIS_SPEEDUP_CAP = K.num('ANALYSIS_SPEEDUP_CAP');

/* ── 2026-09-16 (사용자 결정): 행성 광맥 · 채광 (owner: world) ──
 * 광맥은 약초 · 표본과 같은 채집 노드의 한 종류다. 캐면 **미확인 광물**만 나오고, 그 등급은
 * 총기와 같은 확률 표(`data/loot_tiers.csv` 의 `tier = 행성 threat` 줄, `mythic` 열 포함)로 굴린다 —
 * 두 번째 표를 만들지 않는다. 난이도 1 은 그 줄이 희귀까지만 가중치를 주므로 저절로 희귀에서 멈춘다.
 * 채광 숙련은 `DerivedStats.miningRarityBonus` 로 그 굴림의 상위 등급 쪽만 밀어 준다 (상한은 못 넘는다).
 */
/** 광맥 하나를 캐는 E 홀드 시간(초). `interactSpeedMul` 이 나눈다. */
export const MINING_NODE_HOLD_S = K.num('MINING_NODE_HOLD_S');
/** 광맥 하나에서 나오는 미확인 광물 개수의 하한 · 상한 (정수 균등). */
export const MINING_YIELD_MIN = K.num('MINING_YIELD_MIN');
export const MINING_YIELD_MAX = K.num('MINING_YIELD_MAX');
/** 이 기울기(tan θ) 이상인 사면에만 광맥이 선다 — 사용자 결정 「주로 언덕쪽 위주」. */
export const MINING_HILL_MIN_SLOPE = K.num('MINING_HILL_MIN_SLOPE');
/** 광맥 하나를 캘 때 오르는 `mining` 숙련 경험치. */
export const MINING_SKILL_XP = K.num('MINING_SKILL_XP');
/**
 * A-13 (owner: player): 맞는 준비물 없이 상시 환경 행성(`PlanetDef.env`)에 있을 때 초당 깎이는 **체력**.
 * 방탄복 실드는 대기를 막지 못하므로 실드를 건너뛴다 (사용자 결정: 준비물이 있으면 100 % 상쇄).
 */
export const PLANET_ENV_DPS = K.num('PLANET_ENV_DPS');
/** A-13 (owner: player): 환경 피해를 적용하는 주기(초). 1 tick 당 `PLANET_ENV_DPS × 이 값`. */
export const PLANET_ENV_TICK_S = K.num('PLANET_ENV_TICK_S');
/**
 * A-11 · A-12 (owner: world/Gather): 야생 씨앗 군락 · 미확인 표본 채집지의 홀드 시간(초)과 상호작용 반경(m).
 * 약초 · 고철 · 토양이 `Gather.ts` 안에 숫자로 박혀 있던 것과 달리 처음부터 csv 에 둔다 (「수치는 코드에 적지
 * 않는다」 그대로) — 옛 셋도 손볼 일이 생기면 여기로 따라 나온다.
 */
export const SEED_INTERACT_TIME = K.num('SEED_INTERACT_TIME');
export const SEED_NODE_RADIUS = K.num('SEED_NODE_RADIUS');
export const SAMPLE_INTERACT_TIME = K.num('SAMPLE_INTERACT_TIME');
export const SAMPLE_NODE_RADIUS = K.num('SAMPLE_NODE_RADIUS');

/* ── 2026-09-11: 주방 · 배양조 · 프린터 (A-3c · A-14 · A-15) ── */
/**
 * A-15 (owner: inventory): 장비칸의 **주머니 칸 수**. 사용자 결정으로 고정 1칸이다 — 넷 중 하나만 끼운다.
 * 가방이 정하지 않는다 (`BagDef` 는 손대지 않았다).
 */
export const POUCH_SLOTS = K.num('POUCH_SLOTS');
/**
 * A-3c (owner: housing — 공유 함선 식탁): `분대에 차리기` 가 먹이는 반경(m). 이 안에 있는 분대원만 받는다
 * — 호스트가 스냅샷 거리로 검사한다 (`shared/buffRules` 의 거리 가드와 같은 결).
 */
export const MEAL_SERVE_RANGE = K.num('MEAL_SERVE_RANGE');

/* ── 2026-09-12: 하이브리드 사격 판정 (owner: weapons/parts/AimLine) ── */
/**
 * 총구 앞 몇 m 안의 장애물까지 "총구가 막혔다" 로 보는가. 이 안에서 총구 선에 걸리면 총알은 거기에 맞고
 * (벽에 빨간 원 · 크로스헤어 경고색), 그보다 먼 것은 크로스헤어 선이 판정한다 — 먼 바위 모서리에 조준하지 않은 총알이
 * 왼쪽으로 박히던 것을 없앤다.
 */
export const WEAPON_MUZZLE_BLOCK_RANGE = K.num('WEAPON_MUZZLE_BLOCK_RANGE');

/* ══ 2026-09-12 — 소모품 · 임플란트 · 열쇠 · 드론 스캔 · 즐겨찾기 · 헬스 (docs/DECISIONS.md 「2026-09-12 — 전투 소모품」) ══
 * 병렬 에이전트마다 **자기 블록 안에만** 추가한다. 값은 data/constants.csv 의 같은 표식 블록에. */
/* ── [A1] 소모품 3종 ── */
/**
 * owner: player (`parts/Boosts`). 아드레날린 주사의 효과 시간(초) — 스태미나 전량 회복 + 이 시간 동안 **지속 소모만** 0.
 * 한 번 소모(점프 · 구르기 · 근접 · 실드 배쉬)는 그대로다.
 */
export const BOOST_ADRENALINE_DURATION_S = K.num('BOOST_ADRENALINE_DURATION_S');
/** owner: player. 각성제의 효과 시간(초). 아드레날린과 서로 지운다 (나중 것이 이긴다). */
export const BOOST_STIMULANT_DURATION_S = K.num('BOOST_STIMULANT_DURATION_S');
/** 각성제 동안 장전 속도 배수 (>1 = 빠름). weapons 가 `PlayerRef.boostReloadSpeedMul` 로 읽는다. */
export const BOOST_STIMULANT_RELOAD_SPEED_MUL = K.num('BOOST_STIMULANT_RELOAD_SPEED_MUL');
/** 각성제 동안 정조준 전환 속도 배수 (>1 = 빠름). player 가 ADS 블렌드 감쇠율에 곱한다. */
export const BOOST_STIMULANT_ADS_SPEED_MUL = K.num('BOOST_STIMULANT_ADS_SPEED_MUL');
/** 각성제 동안 조준 흔들림 배수 (<1 = 줄어듦). `PlayerRef.aimSwayMul` 로 게시된다. */
export const BOOST_STIMULANT_AIM_SWAY_MUL = K.num('BOOST_STIMULANT_AIM_SWAY_MUL');
/** 각성제의 대가: 스태미나 소모 배수 — 지속 소모와 한 번 소모 모두. */
export const BOOST_STIMULANT_STAMINA_COST_MUL = K.num('BOOST_STIMULANT_STAMINA_COST_MUL');
/* ── end [A1] ── */
/* ── [A2] 조준 흔들림 ── */
/**
 * 조준 흔들림 (owner: player/CameraRig · 계열별 크기는 `data/aim_sway.csv` → weapons/AimSway). 정조준 중 카메라가 8자로 떠돈다 —
 * 위아래 크기는 좌우 × `AIM_SWAY_PITCH_RATIO`(두 배 빠르게 돈다). 자세 · 이동 배수는 앉기 · 엎드리기 · 걷기 속도에서의 값이다.
 */
export const AIM_SWAY_PITCH_RATIO = K.num('AIM_SWAY_PITCH_RATIO');
export const AIM_SWAY_CROUCH_MUL = K.num('AIM_SWAY_CROUCH_MUL');
export const AIM_SWAY_PRONE_MUL = K.num('AIM_SWAY_PRONE_MUL');
export const AIM_SWAY_MOVE_MUL = K.num('AIM_SWAY_MOVE_MUL');
/** 흔들림 크기(자세 · 이동 · 무기 교체 · 정조준 게이트)가 목표를 따라가는 `damp` 속도. */
export const AIM_SWAY_BLEND_RATE = K.num('AIM_SWAY_BLEND_RATE');
/* ── end [A2] ── */
/* ── [B] 전술 임플란트 · 함선 호출 준비 연출 ── */
/**
 * (owner: implants/parts/Devices.refundGrapple) 갈고리 쿨타임 환급 — 비율은 전부 실효 쿨타임(`ImplantsRef.cooldownTotal`) 기준.
 * 붙은 뒤 놓았으면: 붙은 순간 → 놓은 순간의 실제 이동 거리 d(관성 제외)로 `REFUND_MAX × max(0, 1 − d / REFUND_DIST)`.
 * 붙기 전에 끝났으면(날아가는 중 Q 회수 · 드론 앵커 소실): `CANCEL_REFUND`, 단 남은 쿨타임은 `CANCEL_MIN_S` 이상.
 */
export const IMPLANT_GRAPPLE_REFUND_MAX = K.num('IMPLANT_GRAPPLE_REFUND_MAX');
export const IMPLANT_GRAPPLE_REFUND_DIST = K.num('IMPLANT_GRAPPLE_REFUND_DIST');
export const IMPLANT_GRAPPLE_CANCEL_REFUND = K.num('IMPLANT_GRAPPLE_CANCEL_REFUND');
export const IMPLANT_GRAPPLE_CANCEL_MIN_S = K.num('IMPLANT_GRAPPLE_CANCEL_MIN_S');
/* ── end [B] ── */
/* ── [C] 열쇠 · 키카드 · 잠긴 방 · 개구멍 ── */
/* ── end [C] ── */
/* ── [D] 지상드론 스캔 ── */
/**
 * owner: gadgets/drones (`parts/Scan`). 지상 드론 조종 중 조준을 유지한 채 좌클릭을 누르고 있어야 하는 시간(초) —
 * 채우면 대상 안의 **최고 등급**이 레이드 내내 대상 위에 뜬다 (분대 공유). 조준이 벗어나거나 멀어지면 0 부터.
 */
export const DRONE_SCAN_HOLD_S = K.num('DRONE_SCAN_HOLD_S');
/** 드론 렌즈 → 대상 중심의 최대 3-D 거리(m). */
export const DRONE_SCAN_RANGE = K.num('DRONE_SCAN_RANGE');
/** 조준 판정 구 반지름(m) — 렌즈 중심 광선이 대상 중심에서 이만큼 안을 지나면 조준된 것이다. */
export const DRONE_SCAN_AIM_RADIUS = K.num('DRONE_SCAN_AIM_RADIUS');
/** 조준됐지만 사거리 밖인 대상에 「더 가까이」 안내를 띄우는 거리(m). */
export const DRONE_SCAN_HINT_RANGE = K.num('DRONE_SCAN_HINT_RANGE');
/** owner: ui (`hud/DroneScanLabels`). 월드 라벨 높이(m, 대상 바닥 기준) · 보이는 최대 거리(m, 카메라 기준). */
export const DRONE_SCAN_LABEL_HEIGHT = K.num('DRONE_SCAN_LABEL_HEIGHT');
export const DRONE_SCAN_LABEL_MAX_DIST = K.num('DRONE_SCAN_LABEL_MAX_DIST');
/** 받는 쪽: 보낸 사람의 지상 드론 복제본이 대상에서 `DRONE_SCAN_RANGE` + 이 값(m) 안일 때만 분대원 스캔을 믿는다. */
export const DRONE_SCAN_SHARE_SLACK = K.num('DRONE_SCAN_SHARE_SLACK');
/* ── end [D] ── */
/* ── [E1] 즐겨찾기 코어 ── */
/* ── end [E1] ── */
/* ── [E2] 즐겨찾기 칩 · 아이템 회수 계약 ── */
/* ── end [E2] ── */
/* ── [F] 헬스 미니게임 ── */
/* ── end [F] ── */
/* ── [H] 재해 세기 · 독성 포자 배치 · 탈출 패드 수 (2026-09-13, owner: world/Hazard · world/layout) ── */
/** 재해가 맵을 다 덮었을 때(진행도 1)의 초당 피해 — `HAZARD_DPS`(시작)에서 진행도에 비례해 오른다 (`HazardRef.damageMul`). */
export const HAZARD_DPS_MAX = K.num('HAZARD_DPS_MAX');
/** 시야 제한 세기 배율 — `hazards.csv` fogMul 의 (fogMul − 1) 에 곱한다. 시작값 → 진행도 1 의 끝값. */
export const HAZARD_FOG_RAMP_START = K.num('HAZARD_FOG_RAMP_START');
export const HAZARD_FOG_RAMP_END = K.num('HAZARD_FOG_RAMP_END');
/** 그리는 입자 비율 (`hazards.csv` particleCount 에 곱한다). 시작값 → 진행도 1 의 끝값. */
export const HAZARD_PARTICLE_RAMP_START = K.num('HAZARD_PARTICLE_RAMP_START');
export const HAZARD_PARTICLE_RAMP_END = K.num('HAZARD_PARTICLE_RAMP_END');
/** 모래 폭풍 · 눈보라 전선은 강하 지점이 붙은 가장자리 쪽에서 들어온다 — 그 방향에서 ± 이 각도(rad). */
export const HAZARD_FRONT_SPAWN_JITTER_RAD = K.num('HAZARD_FRONT_SPAWN_JITTER_RAD');
/** 폭풍의 눈 처음 반경 = 눈 중심에서 가장 먼 맵 꼭짓점까지 + 이 값(m). `STORM_EYE_RADIUS_START` 는 그 하한으로만 남는다. */
export const STORM_EYE_START_MARGIN_M = K.num('STORM_EYE_START_MARGIN_M');
/** 독성 포자 레이드: 강하 지점 반경(맵 중심 기준, m) · 군락이 서는 중앙 반경 · 군락 ↔ 강하 지점 간격 · 중앙 군락끼리 간격. */
export const SPORE_SPAWN_CENTER_M = K.num('SPORE_SPAWN_CENTER_M');
export const SPORE_CENTER_RADIUS_M = K.num('SPORE_CENTER_RADIUS_M');
export const SPORE_GROVE_SPAWN_GAP_M = K.num('SPORE_GROVE_SPAWN_GAP_M');
export const SPORE_CENTER_GROVE_GAP_M = K.num('SPORE_CENTER_GROVE_GAP_M');
/** 독성 포자 레이드의 탈출 패드는 맵 중심에서 x · z 중 큰 쪽이 이 값(m) 이상인 외곽에만 선다. */
export const EXTRACTION_OUTER_MIN_M = K.num('EXTRACTION_OUTER_MIN_M');
/** 독성 포자 레이드의 탈출 패드 수 범위 (행성 threat 와 무관). */
export const EXTRACTION_PADS_SPORES_MIN = K.num('EXTRACTION_PADS_SPORES_MIN');
export const EXTRACTION_PADS_SPORES_MAX = K.num('EXTRACTION_PADS_SPORES_MAX');
/** 행성 threat 1..3 (인덱스 0..2) 별 탈출 패드 수 범위 — 미션 시드로 그 사이를 뽑는다 (`world/layout.extractionPadCount`). */
export const EXTRACTION_PADS_MIN_BY_THREAT: readonly number[] = numberList('tables.csv', 'EXTRACTION_PADS_MIN_BY_THREAT');
export const EXTRACTION_PADS_MAX_BY_THREAT: readonly number[] = numberList('tables.csv', 'EXTRACTION_PADS_MAX_BY_THREAT');
/* ── end [H] ── */
/* ── [2026-09-13] 탈출 개편 (owner: extraction · game · ui) ── */
/** 출발 스위치(또는 자동 출발) 뒤 실제 이륙까지의 유예(초). 취소 불가 · 그동안에도 탑승 가능. */
export const EXTRACTION_DEPART_GRACE_S = K.num('EXTRACTION_DEPART_GRACE_S');
/** 착륙 뒤 아무도 출발 스위치를 누르지 않으면 이 시간(초) 뒤 자동으로 출발 유예가 시작된다. */
export const EXTRACTION_AUTO_DEPART_IDLE_S = K.num('EXTRACTION_AUTO_DEPART_IDLE_S');
/** 이륙부터 탑승자의 결과 화면까지(초) — 외부 카메라 연출이 이 안에서 끝난다. */
export const EXTRACTION_LIFTOFF_TO_COMPLETE_S = K.num('EXTRACTION_LIFTOFF_TO_COMPLETE_S');
/** 이륙 연출: 캐릭터 카메라 → 함선 외부 카메라 전환 시간(초). */
export const EXTRACTION_CINEMATIC_BLEND_S = K.num('EXTRACTION_CINEMATIC_BLEND_S');
/** 이륙 연출: 전투 HUD 가 사라지는 시간(초). */
export const EXTRACTION_HUD_FADE_S = K.num('EXTRACTION_HUD_FADE_S');
/* ── end [2026-09-13] 탈출 개편 ── */

/* ══ appended (2026-09-13): 버그 굴착 스폰 · 땅굴벌레 이벤트 (owner: enemies) ═════════════════════════════════════
 * 값은 전부 `data/constants.csv` 의 `BURROW_*` · `SANDWORM_*` 와 `data/tables.csv` 의 `SANDWORM_*` 표. 규칙은 `src/enemies/README.md`.
 */
/** 플레이 중 스폰되는 버그가 땅을 파고 올라오는 시간(초). */
export const BURROW_EMERGE_S = K.num('BURROW_EMERGE_S');
/** 굴착 시작 때 몸 높이보다 더 묻혀 있는 깊이(m). */
export const BURROW_SINK_EXTRA_M = K.num('BURROW_SINK_EXTRA_M');
/** 굴착 흔들림이 나는 로컬 플레이어 거리(m). */
export const BURROW_SHAKE_RADIUS = K.num('BURROW_SHAKE_RADIUS');
/** 굴착 흔들림 세기. */
export const BURROW_SHAKE_INTENSITY = K.num('BURROW_SHAKE_INTENSITY');
/** 굴착 흔들림 사이 최소 간격(초) — 겹치지 않는다. */
export const BURROW_SHAKE_GAP_S = K.num('BURROW_SHAKE_GAP_S');
/* ── appended (2026-09-16): 벌레 소리 — 굴착음 · 발소리 · 포탄 낙하음 (owner: audio · enemies). 값은 `data/constants.csv`. ── */
/** `burrow_emerge` 동시 보이스 상한 (`audio/AudioSystem.VOICE_CAP`). */
export const BURROW_EMERGE_VOICE_CAP = K.num('BURROW_EMERGE_VOICE_CAP');
/** 같은 무리로 세는 굴착음 창(초) — k 번째 소리 × 1/√k (`enemies/parts/Burrow`). */
export const BURROW_EMERGE_BATCH_S = K.num('BURROW_EMERGE_BATCH_S');
/** 벌레 발소리 사거리(m) — `bug_step_skitter` · `bug_step_heavy`; 베헤모스 `bug_step_giant` 는 GIANT. */
export const BUG_STEP_RANGE_M = K.num('BUG_STEP_RANGE_M');
export const BUG_STEP_GIANT_RANGE_M = K.num('BUG_STEP_GIANT_RANGE_M');
/** 벌레 발소리 세 id 를 합친 동시 보이스 상한. */
export const BUG_STEP_VOICE_CAP = K.num('BUG_STEP_VOICE_CAP');
/** 「걷고 있는 가까운 벌레」 를 세는 창(초) — 발소리 × 1/√n (`enemies/model.emitEnemyStep`). */
export const BUG_STEP_CROWD_WINDOW_S = K.num('BUG_STEP_CROWD_WINDOW_S');
/** 포탄 낙하음: 착탄 몇 초 전 · 착탄점 사거리(m) · floor · 밑 크기 · 동시 보이스 상한. 발사 쿵의 사거리(m). */
export const SHELL_INCOMING_LEAD_S = K.num('SHELL_INCOMING_LEAD_S');
export const SHELL_INCOMING_RANGE_M = K.num('SHELL_INCOMING_RANGE_M');
export const SHELL_INCOMING_FLOOR = K.num('SHELL_INCOMING_FLOOR');
export const SHELL_INCOMING_VOLUME = K.num('SHELL_INCOMING_VOLUME');
export const SHELL_INCOMING_VOICE_CAP = K.num('SHELL_INCOMING_VOICE_CAP');
export const SHELL_LAUNCH_RANGE_M = K.num('SHELL_LAUNCH_RANGE_M');
/** 땅굴벌레가 일어날 수 있는 레이드 시각 창(초, `ctx.missionTime`). */
export const SANDWORM_WINDOW_START_S = K.num('SANDWORM_WINDOW_START_S');
export const SANDWORM_WINDOW_END_S = K.num('SANDWORM_WINDOW_END_S');
/** 발동 시각 뒤 조건을 다시 보는 간격(초). */
export const SANDWORM_CHECK_S = K.num('SANDWORM_CHECK_S');
/** 멀티에서 「같이 다닌다」 반경(m). */
export const SANDWORM_GROUP_RADIUS = K.num('SANDWORM_GROUP_RADIUS');
/** 전조 → 분출(초). */
export const SANDWORM_WARN_S = K.num('SANDWORM_WARN_S');
/** 전조 · 분출 흔들림이 느껴지는 반경(m). */
export const SANDWORM_ALERT_RADIUS = K.num('SANDWORM_ALERT_RADIUS');
/** 전조 흔들림 한 번의 최대 세기. */
export const SANDWORM_SHAKE_MAX = K.num('SANDWORM_SHAKE_MAX');
/** 분출 판정 반경(m) · 피해 · 넉백(m/s). */
export const SANDWORM_ERUPT_RADIUS = K.num('SANDWORM_ERUPT_RADIUS');
export const SANDWORM_ERUPT_DAMAGE = K.num('SANDWORM_ERUPT_DAMAGE');
export const SANDWORM_ERUPT_KNOCKBACK = K.num('SANDWORM_ERUPT_KNOCKBACK');
/** 땅굴벌레 최대 체력 범위 (호스트가 굴린다). */
export const SANDWORM_HP_MIN = K.num('SANDWORM_HP_MIN');
export const SANDWORM_HP_MAX = K.num('SANDWORM_HP_MAX');
/** 몸통이 다 솟는 시간(초). */
export const SANDWORM_RISE_S = K.num('SANDWORM_RISE_S');
/** 분출 버그 무리의 링 반경(m). */
export const SANDWORM_BURST_RING_MIN = K.num('SANDWORM_BURST_RING_MIN');
export const SANDWORM_BURST_RING_MAX = K.num('SANDWORM_BURST_RING_MAX');
/** 버그 뱉기 단계의 길이 · 간격(초) · 한 번의 수 · 비행 시간(초) · 착지 거리(m). */
export const SANDWORM_SPIT_PHASE_S = K.num('SANDWORM_SPIT_PHASE_S');
export const SANDWORM_SPIT_INTERVAL_S = K.num('SANDWORM_SPIT_INTERVAL_S');
export const SANDWORM_SPIT_COUNT = K.num('SANDWORM_SPIT_COUNT');
export const SANDWORM_SPIT_FLIGHT_S = K.num('SANDWORM_SPIT_FLIGHT_S');
export const SANDWORM_SPIT_MIN_M = K.num('SANDWORM_SPIT_MIN_M');
export const SANDWORM_SPIT_MAX_M = K.num('SANDWORM_SPIT_MAX_M');
/** 버그를 뱉을 때의 전체 적 생존 상한. */
export const SANDWORM_ALIVE_CAP = K.num('SANDWORM_ALIVE_CAP');
/** 독극물 단계: 사거리(m) · 간격(초) · 한 번의 덩어리 수. */
export const SANDWORM_ACID_RANGE = K.num('SANDWORM_ACID_RANGE');
export const SANDWORM_ACID_INTERVAL_S = K.num('SANDWORM_ACID_INTERVAL_S');
export const SANDWORM_ACID_VOLLEY = K.num('SANDWORM_ACID_VOLLEY');
/** 레이드당 이벤트 확률 — index 0 = 행성 threat 1 (`data/tables.csv`). */
export const SANDWORM_CHANCE_BY_THREAT = numberList('tables.csv', 'SANDWORM_CHANCE_BY_THREAT');
/** 분출 버그 무리 수 — index 0 = 분대 1명. */
export const SANDWORM_BURST_BY_SQUAD = numberList('tables.csv', 'SANDWORM_BURST_BY_SQUAD');
/* ── end 2026-09-13 굴착 스폰 · 땅굴벌레 ── */

/* ── 2026-09-13 탐사 차량 — 공용 (값은 data/constants.csv, 규칙은 shared/types.ts 의 탐사 차량 절) ── */
/** 탑승 · 하차 E 홀드 시간(초). */
export const ROVER_BOARD_HOLD_S = K.num('ROVER_BOARD_HOLD_S');
export const ROVER_EXIT_HOLD_S = K.num('ROVER_EXIT_HOLD_S');
/** 정류장 정차 시간(초) — 탑승자가 있고 결제 전이면 줄지 않는다. */
export const ROVER_DWELL_S = K.num('ROVER_DWELL_S');
/** 결제 뒤 출발 유예(초). */
export const ROVER_DEPART_GRACE_S = K.num('ROVER_DEPART_GRACE_S');
/** 차량 체력. */
export const ROVER_HP = K.num('ROVER_HP');
/** 재해 구역 안에서 받는 재해 피해 배수. */
export const ROVER_HAZARD_DAMAGE_MUL = K.num('ROVER_HAZARD_DAMAGE_MUL');
/** 요금 = 10 단위 반올림(MIN + 거리 × PER_M) 을 [MIN, MAX] 로 자른다. 식의 원본은 `RoverRef.fareTo`. */
export const ROVER_FARE_MIN = K.num('ROVER_FARE_MIN');
export const ROVER_FARE_MAX = K.num('ROVER_FARE_MAX');
export const ROVER_FARE_PER_M = K.num('ROVER_FARE_PER_M');
/* ── [R1] 경로 · 정류장 · 흙길 (owner: world/rover RoverRoad · world/layout) ── */
/** 흙길 회랑 반폭(m) — 이 안에는 아무것도 놓지 않는다 (`layout.roverClearance` · `isSpotFree`). */
export const ROVER_ROUTE_CLEARANCE_M = K.num('ROVER_ROUTE_CLEARANCE_M');
/** 정류장 수 범위 (시드). */
export const ROVER_STATION_COUNT_MIN = K.num('ROVER_STATION_COUNT_MIN');
export const ROVER_STATION_COUNT_MAX = K.num('ROVER_STATION_COUNT_MAX');
/** 정류장끼리 최소 거리(m). */
export const ROVER_STATION_MIN_GAP_M = K.num('ROVER_STATION_MIN_GAP_M');
/** 정류장 각도 흔들기 (각도 칸 폭 비율 ±). */
export const ROVER_STATION_ANGLE_JITTER = K.num('ROVER_STATION_ANGLE_JITTER');
/** 정류장 부지(평탄화 패드) 반지름 · 가장자리 폭(m). */
export const ROVER_STATION_PAD_R = K.num('ROVER_STATION_PAD_R');
export const ROVER_STATION_PAD_BLEND = K.num('ROVER_STATION_PAD_BLEND');
/** 흙길 · 정류장의 맵 중심 최소 거리(m) (순환 선로가 있으면 자동으로 넓힌다). */
export const ROVER_RING_MIN_M = K.num('ROVER_RING_MIN_M');
/** 흙길 중심선의 |x| · |z| 최대(m). */
export const ROVER_ROUTE_BOUND_M = K.num('ROVER_ROUTE_BOUND_M');
/** 순환 선로 회랑과 흙길 회랑 사이 여유(m). */
export const ROVER_RAIL_GAP_M = K.num('ROVER_RAIL_GAP_M');
/** 강하 지점 부지와의 여유(m). */
export const ROVER_SPAWN_GAP_M = K.num('ROVER_SPAWN_GAP_M');
/** 정류장 사이 구간의 최대 휨(m). */
export const ROVER_ROUTE_WIGGLE_M = K.num('ROVER_ROUTE_WIGGLE_M');
/** 레이아웃 경로 점 간격(m) · 계획 재시도 수 · 최소 회전 반경(m). */
export const ROVER_PLAN_STEP_M = K.num('ROVER_PLAN_STEP_M');
export const ROVER_PLAN_ATTEMPTS = K.num('ROVER_PLAN_ATTEMPTS');
export const ROVER_MIN_TURN_RADIUS_M = K.num('ROVER_MIN_TURN_RADIUS_M');
/** 세운 경로 점 간격(m) · 노면 평활화 횟수. */
export const ROVER_ROUTE_STEP_M = K.num('ROVER_ROUTE_STEP_M');
export const ROVER_ROUTE_SMOOTH_PASSES = K.num('ROVER_ROUTE_SMOOTH_PASSES');
/** 흙길 그림 반폭 · 띄우기(m). */
export const ROVER_ROAD_HALF_WIDTH_M = K.num('ROVER_ROAD_HALF_WIDTH_M');
export const ROVER_ROAD_LIFT_M = K.num('ROVER_ROAD_LIFT_M');
/** 표지 기둥의 흙길 중심선 옆 거리 · 높이(m). */
export const ROVER_POLE_OFFSET_M = K.num('ROVER_POLE_OFFSET_M');
export const ROVER_POLE_HEIGHT_M = K.num('ROVER_POLE_HEIGHT_M');
/* ── end [R1] ── */
/* ── [R2] 차량 · 포탑 · 동기화 (owner: world/rover Rover) ── */
/** 순환 · 결제 이동 최고 속도(m/s) · 가속 · 감속(m/s²). */
export const ROVER_PATROL_SPEED = K.num('ROVER_PATROL_SPEED');
export const ROVER_TRIP_SPEED = K.num('ROVER_TRIP_SPEED');
export const ROVER_ACCEL = K.num('ROVER_ACCEL');
export const ROVER_BRAKE = K.num('ROVER_BRAKE');
/** 제자리 회전 속도(rad/s) · 출발 허용 정렬 각(rad). */
export const ROVER_TURN_RATE = K.num('ROVER_TURN_RATE');
export const ROVER_ALIGN_EPS = K.num('ROVER_ALIGN_EPS');
/** 좌석 수 · 탑승 상호작용 거리(m) · 호스트의 탑승 요청 거리 검사(m). */
export const ROVER_SEATS = K.num('ROVER_SEATS');
export const ROVER_BOARD_RANGE = K.num('ROVER_BOARD_RANGE');
export const ROVER_BOARD_CHECK_RANGE = K.num('ROVER_BOARD_CHECK_RANGE');
/** 탑승 궤도 카메라 기본 거리(m). */
export const ROVER_CAMERA_DISTANCE = K.num('ROVER_CAMERA_DISTANCE');
/** 차체 반길이 · 반폭 · 전체 높이 · 콜라이더 높이(m). */
export const ROVER_HALF_LENGTH = K.num('ROVER_HALF_LENGTH');
export const ROVER_HALF_WIDTH = K.num('ROVER_HALF_WIDTH');
export const ROVER_HEIGHT = K.num('ROVER_HEIGHT');
export const ROVER_HULL_H = K.num('ROVER_HULL_H');
/** 포탑: 사거리(m) · 한 발 피해 · 간격(초) · 재조준(초) · 회전(rad/s) · 사격 원추(rad). */
export const ROVER_TURRET_RANGE = K.num('ROVER_TURRET_RANGE');
export const ROVER_TURRET_DAMAGE = K.num('ROVER_TURRET_DAMAGE');
export const ROVER_TURRET_INTERVAL_S = K.num('ROVER_TURRET_INTERVAL_S');
export const ROVER_TURRET_RETARGET_S = K.num('ROVER_TURRET_RETARGET_S');
export const ROVER_TURRET_TURN_RATE = K.num('ROVER_TURRET_TURN_RATE');
export const ROVER_TURRET_AIM_CONE = K.num('ROVER_TURRET_AIM_CONE');
/** 부딪힘: 최저 속도(m/s) · 적 피해 · 넉백(m/s) · 대상별 쿨다운(초). */
export const ROVER_HIT_SPEED_MIN = K.num('ROVER_HIT_SPEED_MIN');
export const ROVER_HIT_DAMAGE = K.num('ROVER_HIT_DAMAGE');
export const ROVER_HIT_KNOCKBACK = K.num('ROVER_HIT_KNOCKBACK');
export const ROVER_HIT_COOLDOWN_S = K.num('ROVER_HIT_COOLDOWN_S');
/** 방송 주기(초) · 클라이언트 스냅 거리(m). */
export const ROVER_NET_INTERVAL = K.num('ROVER_NET_INTERVAL');
export const ROVER_SNAP_M = K.num('ROVER_SNAP_M');
/** 하차 자리가 차체 가장자리에서 떨어진 거리(m). */
export const ROVER_EXIT_GAP_M = K.num('ROVER_EXIT_GAP_M');
/** 차량 피격음 최소 간격(초, audio). */
export const ROVER_CLANG_GAP_S = K.num('ROVER_CLANG_GAP_S');
/* ── end [R2] ── */
/* ── [R3] 탑승 모드 · 궤도 카메라 (owner: player) ── */
/** 궤도 카메라 고도각 범위 · 시작값(도, 초점 기준). */
export const ROVER_CAM_ELEV_MIN_DEG = K.num('ROVER_CAM_ELEV_MIN_DEG');
export const ROVER_CAM_ELEV_MAX_DEG = K.num('ROVER_CAM_ELEV_MAX_DEG');
export const ROVER_CAM_ELEV_START_DEG = K.num('ROVER_CAM_ELEV_START_DEG');
/** 휠 확대 · 축소 범위(기본 거리 배수) · 한 칸 비율 · 충돌 뒤 풀리는 감쇠율. */
export const ROVER_CAM_ZOOM_MIN_MUL = K.num('ROVER_CAM_ZOOM_MIN_MUL');
export const ROVER_CAM_ZOOM_MAX_MUL = K.num('ROVER_CAM_ZOOM_MAX_MUL');
export const ROVER_CAM_ZOOM_STEP = K.num('ROVER_CAM_ZOOM_STEP');
export const ROVER_CAM_ZOOM_RATE = K.num('ROVER_CAM_ZOOM_RATE');
/** 위치 추종 감쇠율 · 충돌 여유(m) · 최소 거리(m) · 지형 위 최소 높이(m). */
export const ROVER_CAM_SMOOTH_RATE = K.num('ROVER_CAM_SMOOTH_RATE');
export const ROVER_CAM_COLLISION_PAD = K.num('ROVER_CAM_COLLISION_PAD');
export const ROVER_CAM_MIN_DIST = K.num('ROVER_CAM_MIN_DIST');
export const ROVER_CAM_FLOOR = K.num('ROVER_CAM_FLOOR');
/** 탑승 중 세이브 · 강제 해제가 몸을 두는 거리(m, 차량 오른쪽). */
export const ROVER_SAFE_SIDE_M = K.num('ROVER_SAFE_SIDE_M');
/** 원격 분대원이 내린 뒤 아바타를 더 숨기는 시간(초). */
export const ROVER_REMOTE_EXIT_HIDE_S = K.num('ROVER_REMOTE_EXIT_HIDE_S');
/* ── end [R3] ── */
/* ── [R4] 적이 차량을 노린다 (owner: enemies) ── */
/** 차량에 맞은 적(과 무리)이 차량을 노리는 시간(초). */
export const ROVER_AGGRO_S = K.num('ROVER_AGGRO_S');
/** 차량에 맞은 적과 함께 차량을 노리게 되는 같은 팩션 무리의 반경(m). */
export const ROVER_AGGRO_GROUP_RADIUS = K.num('ROVER_AGGRO_GROUP_RADIUS');
/** 서 있는 차량을 알아채는 거리(m, 차체 가장자리까지 · 사선 필요). */
export const ROVER_NOTICE_STOPPED_M = K.num('ROVER_NOTICE_STOPPED_M');
/* ── end [R4] ── */
/* ── end 2026-09-13 탐사 차량 ── */

/* ── 2026-09-13 서재 시리즈 · 비디오게임 · 요리/연구 숙련 (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ── */
/** 서재 시리즈 몫 — 전권이 아니면 꽂힌 서로 다른 권마다 전권 보너스의 이만큼 (`librarySeriesFraction`). */
export const SHELF_SERIES_VOLUME_SHARE = K.num('SHELF_SERIES_VOLUME_SHARE');
/** 게임 디스크 전시대 한 대의 칸 수 (`SHELF_SLOTS.game`). */
export const GAME_DISC_SLOTS_PER_STAND = K.num('GAME_DISC_SLOTS_PER_STAND');
/** 요리 숙련 최대치의 조리 단계 점수 가산 (`derived.cookScoreBonus`). */
export const COOK_SKILL_SCORE_AT_MAX = K.num('COOK_SKILL_SCORE_AT_MAX');
/** 조리 한 번의 요리 숙련 경험치 (× max(0.25, 점수)). */
export const COOK_SKILL_XP = K.num('COOK_SKILL_XP');
/** 연구 숙련 최대치의 분석 시간 감소 비율 (`derived.researchTimeMul` = 1 − 이 값 × 숙련 비율). */
export const RESEARCH_TIME_AT_MAX = K.num('RESEARCH_TIME_AT_MAX');
/** 연구 숙련 최대치의 재료 환급 확률 (`derived.researchRefundChance`). */
export const RESEARCH_REFUND_CHANCE_AT_MAX = K.num('RESEARCH_REFUND_CHANCE_AT_MAX');
/** 환급 비율 — 숙련 0 / 최대 (`derived.researchRefundFrac`). */
export const RESEARCH_REFUND_FRAC_MIN = K.num('RESEARCH_REFUND_FRAC_MIN');
export const RESEARCH_REFUND_FRAC_MAX = K.num('RESEARCH_REFUND_FRAC_MAX');
/** 연구 숙련 경험치 — 분석 회수 한 칸 / 연구실 작업대 제작 1개. */
export const RESEARCH_XP_ANALYSIS = K.num('RESEARCH_XP_ANALYSIS');
export const RESEARCH_XP_CRAFT = K.num('RESEARCH_XP_CRAFT');
/* ── end 2026-09-13 서재 시리즈 ── */

/* ── 2026-09-14 튜토리얼 개편 · 낙하 피해 (docs/DECISIONS.md 「2026-09-14 — 튜토리얼 개편」) ── */
/** 낙하 피해가 시작되는 높이 (m) — 이것까지는 공짜다. */
export const FALL_DAMAGE_SAFE_M = K.num('FALL_DAMAGE_SAFE_M');
/** 안전 높이를 넘은 1 m 당 피해 (실드 → 체력 순). */
export const FALL_DAMAGE_PER_M = K.num('FALL_DAMAGE_PER_M');
/** 한 번의 낙하가 줄 수 있는 피해 상한. */
export const FALL_DAMAGE_MAX = K.num('FALL_DAMAGE_MAX');
/** 튜토리얼 전용 적의 감지 반경 · 이탈 거리 (m). */
export const TUTORIAL_ENEMY_SENSE_M = K.num('TUTORIAL_ENEMY_SENSE_M');
export const TUTORIAL_ENEMY_LEASH_M = K.num('TUTORIAL_ENEMY_LEASH_M');
/** 튜토리얼 사망 → 체크포인트 부활까지 (초). */
export const TUTORIAL_RESPAWN_DELAY_S = K.num('TUTORIAL_RESPAWN_DELAY_S');
/** 오프닝 기상 연출 길이 (초) — `PlayerRef.playIntroWake` 에 넘길 값. */
export const TUTORIAL_INTRO_WAKE_S = K.num('TUTORIAL_INTRO_WAKE_S');
/** appended (2026-09-14): 기상 연출이 끝난 뒤 나침반이 나타나는 시간 (초) — `ui/hud/Compass` 가 코드로 opacity 를 올린다. */
export const TUTORIAL_COMPASS_FADE_S = K.num('TUTORIAL_COMPASS_FADE_S');
/** appended (2026-09-16): 기상 연출이 끝난 뒤 크로스헤어가 나타나는 시간 (초) — `ui/hud/Reticle` 이 코드로 opacity 를 올린다. */
export const TUTORIAL_RETICLE_FADE_S = K.num('TUTORIAL_RETICLE_FADE_S');
/** 튜토리얼 레이드 완주 보상 XP (레벨 2 에 닿는다). */
export const TUTORIAL_RAID_XP = K.num('TUTORIAL_RAID_XP');
/**
 * 자세별 몸 높이 (발 위 클리어런스, m) — `WorldRef.resolveCollision(pos, r, height?)` 에 넘길 값.
 * 서 있을 때는 넘기지 않는다 (= `BOX_HEADROOM`), 그래서 본편 동선은 한 곳도 안 바뀐다.
 */
export const PLAYER_CROUCH_CLEARANCE_M = K.num('PLAYER_CROUCH_CLEARANCE_M');
export const PLAYER_PRONE_CLEARANCE_M = K.num('PLAYER_PRONE_CLEARANCE_M');
/**
 * **은퇴** (2026-09-14 2차, 사용자 결정 — 「처음에 딸피가 아닌 풀피로 시작, 부활할 때에도 풀피」).
 * 읽는 곳이 없다. 이름은 계약이라 남긴다 (`airstrike` · `secondary` 와 같은 처리 — `src/shared` 는 추가만).
 * 튜토리얼의 긴장은 이제 **낙하 피해**가 만들고, 깎인 체력은 `heal` 단계의 붕대가 되돌린다.
 */
export const TUTORIAL_START_HP = K.num('TUTORIAL_START_HP');
/* ── end 2026-09-14 튜토리얼 ── */

/* ── 2026-09-15 낙하 피드백 · 화염 지대 · 병사 림 (docs/TODO.md B-14 · B-16 · D-7) ── */
/** 낙하 피해 → `camera:shake` (owner: player `parts/Fall`). intensity = min(MAX, damage × PER_DAMAGE). */
export const FALL_SHAKE_PER_DAMAGE = K.num('FALL_SHAKE_PER_DAMAGE');
export const FALL_SHAKE_MAX = K.num('FALL_SHAKE_MAX');
export const FALL_SHAKE_S = K.num('FALL_SHAKE_S');
/** 낙하 붉은 비네트 (owner: ui). 세기 = min(1, damage / FULL_DAMAGE), `FALL_VIGNETTE_S` 동안 사라진다. */
export const FALL_VIGNETTE_S = K.num('FALL_VIGNETTE_S');
export const FALL_VIGNETTE_FULL_DAMAGE = K.num('FALL_VIGNETTE_FULL_DAMAGE');
/** 분대원 낙하 착지음 사거리 (m) — player 가 `FallMessage` 를 거르고 audio 가 감쇠에 쓴다. */
export const FALL_REMOTE_SOUND_RANGE = K.num('FALL_REMOTE_SOUND_RANGE');
/** G-10 소이 수류탄 화염 지대 (gadgets `GadgetId 'grenadeFire'`). */
export const GRENADE_INCENDIARY_RADIUS = K.num('GRENADE_INCENDIARY_RADIUS');
export const GRENADE_INCENDIARY_DURATION = K.num('GRENADE_INCENDIARY_DURATION');
/** G-10 소이 수류탄 폭발 (weapons `Grenade`) — 고폭 `GRENADE_DAMAGE` / `GRENADE_RADIUS` 대신 쓰는 작은 폭발. */
export const GRENADE_INCENDIARY_BLAST_DAMAGE = K.num('GRENADE_INCENDIARY_BLAST_DAMAGE');
export const GRENADE_INCENDIARY_BLAST_RADIUS = K.num('GRENADE_INCENDIARY_BLAST_RADIUS');
/** 화염 지대 공용 — 지지직 소리 간격 · 드론이 타는 높이 · HUD 표시 거리 (enemies · gadgets · ui). */
export const FIRE_ZONE_CRACKLE_S = K.num('FIRE_ZONE_CRACKLE_S');
export const FIRE_ZONE_DRONE_HEIGHT = K.num('FIRE_ZONE_DRONE_HEIGHT');
export const FIRE_ZONE_DANGER_RANGE = K.num('FIRE_ZONE_DANGER_RANGE');
/** 병사 림 (owner: player `SoldierModel`). */
export const SOLDIER_RIM_STRENGTH = K.num('SOLDIER_RIM_STRENGTH');
export const SOLDIER_RIM_POWER = K.num('SOLDIER_RIM_POWER');
/* ── end 2026-09-15 ── */
/* ── appended (2026-09-15): 튜토리얼 부활 연출 · 벌레 연쇄 스폰 · 어그로 해제 · 이륙 사격 ── */
/** 튜토리얼 부활 — 쓰러진 자세에서 일어서는 시간 (owner: player `parts/IntroWake`; caller: game `parts/Death.tutorialRespawn`). */
export const TUTORIAL_RESPAWN_WAKE_S = K.num('TUTORIAL_RESPAWN_WAKE_S');
/** 튜토리얼 벌레 매복 — 첫 벌레 뒤 다음 벌레까지 (owner: enemies `Tutorial.ts`). */
export const TUTORIAL_BUG_CHAIN_SPAWN_S = K.num('TUTORIAL_BUG_CHAIN_SPAWN_S');
/** 튜토리얼 이륙 사격 창 · 거리 (owner: enemies `Tutorial.ts`). */
export const TUTORIAL_LIFTOFF_FIRE_S = K.num('TUTORIAL_LIFTOFF_FIRE_S');
export const TUTORIAL_LIFTOFF_FIRE_RANGE_M = K.num('TUTORIAL_LIFTOFF_FIRE_RANGE_M');
/** 절벽 낙하 어그로 해제 높이 (owner: enemies `Tutorial.ts`). */
export const TUTORIAL_AGGRO_DROP_M = K.num('TUTORIAL_AGGRO_DROP_M');
/** 2026-09-16: 튜토리얼 적이 낭떠러지 가장자리에서 떨어져 서는 거리 (owner: enemies `Tutorial.ts` `tutorialEdgeGuard`). */
export const TUTORIAL_ENEMY_EDGE_MARGIN_M = K.num('TUTORIAL_ENEMY_EDGE_MARGIN_M');
/* ── end 2026-09-15 튜토리얼 부활 · 어그로 ── */

/* ── 2026-09-15 안드로이드 분대원 · 레이드 진입 로딩 (docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」; 계약 `shared/allies.ts`) ── */
import type { AllyStateId } from './allies';
/** 체력 배수 · 쓰러짐 출혈 풀 · 일으켜진 체력 (owner: allies). */
export const ALLY_HP_MUL = K.num('ALLY_HP_MUL');
export const ALLY_DOWN_HP = K.num('ALLY_DOWN_HP');
export const ALLY_REVIVE_HP = K.num('ALLY_REVIVE_HP');
/** 이동 (m/s, rad/s). */
export const ALLY_WALK_SPEED = K.num('ALLY_WALK_SPEED');
export const ALLY_RUN_SPEED = K.num('ALLY_RUN_SPEED');
export const ALLY_CARRY_SPEED = K.num('ALLY_CARRY_SPEED');
export const ALLY_TURN_RATE = K.num('ALLY_TURN_RATE');
/** 하네스 — 반경 · 한 방향 이동 시 줄어드는 하한 · 일관성 시간상수 · 움직임 판정 속도 · 가까이 붙지 않는 거리. */
export const ALLY_HARNESS_RADIUS_M = K.num('ALLY_HARNESS_RADIUS_M');
export const ALLY_HARNESS_MIN_FRAC = K.num('ALLY_HARNESS_MIN_FRAC');
export const ALLY_HARNESS_COMMIT_TAU_S = K.num('ALLY_HARNESS_COMMIT_TAU_S');
export const ALLY_HARNESS_COMMIT_SPEED = K.num('ALLY_HARNESS_COMMIT_SPEED');
export const ALLY_FOLLOW_NEAR_M = K.num('ALLY_FOLLOW_NEAR_M');
/** 반응 지연 — 무게 0 / 1 의 초 · 무작위 몫. 상태별 무게는 `ALLY_STATE_WEIGHT`. */
export const ALLY_REACT_MIN_S = K.num('ALLY_REACT_MIN_S');
export const ALLY_REACT_MAX_S = K.num('ALLY_REACT_MAX_S');
export const ALLY_REACT_JITTER = K.num('ALLY_REACT_JITTER');
/** 상태별 행동 무게 0..1 (`data/tables.csv` `ALLY_STATE_WEIGHT`) — 빠진 상태는 0. */
export const ALLY_STATE_WEIGHT: Readonly<Partial<Record<AllyStateId, number>>> = numberMap<AllyStateId>('tables.csv', 'ALLY_STATE_WEIGHT');
/** 요청 선착순 쿨다운 · 탈출 확인 창 (s). */
export const ALLY_REQUEST_COOLDOWN_S = K.num('ALLY_REQUEST_COOLDOWN_S');
export const ALLY_EXTRACT_CONFIRM_S = K.num('ALLY_EXTRACT_CONFIRM_S');
/** 전투 — 감지 · 사거리(m) · 조준 오차(°) · 피해 배수 · 연사 발 수 · 쉬는 시간 · 적 핑 간격. */
export const ALLY_SENSE_RADIUS_M = K.num('ALLY_SENSE_RADIUS_M');
export const ALLY_FIRE_RANGE_M = K.num('ALLY_FIRE_RANGE_M');
export const ALLY_AIM_ERROR_DEG = K.num('ALLY_AIM_ERROR_DEG');
export const ALLY_DAMAGE_MUL = K.num('ALLY_DAMAGE_MUL');
export const ALLY_BURST_MIN = K.num('ALLY_BURST_MIN');
export const ALLY_BURST_MAX = K.num('ALLY_BURST_MAX');
export const ALLY_BURST_PAUSE_S = K.num('ALLY_BURST_PAUSE_S');
export const ALLY_ENEMY_PING_COOLDOWN_S = K.num('ALLY_ENEMY_PING_COOLDOWN_S');
/** 루팅 · 건네기 — 칸당 초 · 손 닿는 거리 · 요청자 곁 거리 · 바라봄 내적 · 멈춤 속도 · 최대 대기 · 같은 말 간격. */
export const ALLY_LOOT_ITEM_S = K.num('ALLY_LOOT_ITEM_S');
export const ALLY_LOOT_REACH_M = K.num('ALLY_LOOT_REACH_M');
export const ALLY_DELIVER_RANGE_M = K.num('ALLY_DELIVER_RANGE_M');
export const ALLY_DELIVER_LOOK_DOT = K.num('ALLY_DELIVER_LOOK_DOT');
export const ALLY_DELIVER_STILL_SPEED = K.num('ALLY_DELIVER_STILL_SPEED');
export const ALLY_DELIVER_WAIT_MAX_S = K.num('ALLY_DELIVER_WAIT_MAX_S');
export const ALLY_CHAT_REPEAT_S = K.num('ALLY_CHAT_REPEAT_S');
/** 명령 — 도착 거리 · 가자 핑 머무름 · 주의 시간 · 앞장 거리. */
export const ALLY_MOVE_ARRIVE_M = K.num('ALLY_MOVE_ARRIVE_M');
export const ALLY_MOVE_HOLD_S = K.num('ALLY_MOVE_HOLD_S');
export const ALLY_WATCH_S = K.num('ALLY_WATCH_S');
export const ALLY_LEAD_AHEAD_M = K.num('ALLY_LEAD_AHEAD_M');
/** 구조 — 안전 판정 반경 · 재해 탈출 여유 (m). */
export const ALLY_RESCUE_SAFE_RADIUS_M = K.num('ALLY_RESCUE_SAFE_RADIUS_M');
export const ALLY_HAZARD_SAFE_MARGIN_M = K.num('ALLY_HAZARD_SAFE_MARGIN_M');
/** 동기화 주기 (s) · 조종실 슬롯 홀드 (s, owner: hub) · 함선 치트 추종 거리 (m). */
export const ALLY_NET_INTERVAL_S = K.num('ALLY_NET_INTERVAL_S');
export const ALLY_BAY_HOLD_S = K.num('ALLY_BAY_HOLD_S');
export const ALLY_HUB_FOLLOW_M = K.num('ALLY_HUB_FOLLOW_M');
/** 자유 탐색 (2026-09-16 사용자 결정) — 관심 지점 반경 · 선점 거리 · 최소 이동 · 둘러보는 시간. */
export const ALLY_ROAM_POI_RADIUS_M = K.num('ALLY_ROAM_POI_RADIUS_M');
export const ALLY_ROAM_POI_TAKEN_M = K.num('ALLY_ROAM_POI_TAKEN_M');
export const ALLY_ROAM_MIN_STEP_M = K.num('ALLY_ROAM_MIN_STEP_M');
export const ALLY_ROAM_PAUSE_MIN_S = K.num('ALLY_ROAM_PAUSE_MIN_S');
export const ALLY_ROAM_PAUSE_MAX_S = K.num('ALLY_ROAM_PAUSE_MAX_S');
/** 겹치지 않기 · 산개 (2026-09-16 사용자 결정). */
export const ALLY_SEPARATION_M = K.num('ALLY_SEPARATION_M');
export const ALLY_SPREAD_M = K.num('ALLY_SPREAD_M');
/** 「앞장서라」 — 하네스 배수 · 자동 해제 시간 (s). */
export const ALLY_LEAD_HARNESS_MUL = K.num('ALLY_LEAD_HARNESS_MUL');
export const ALLY_LEAD_DURATION_S = K.num('ALLY_LEAD_DURATION_S');
/** 무기별 교전 거리 — 피해가 이 비율까지 떨어지는 거리 · 그 하한 (m). */
export const ALLY_ENGAGE_DAMAGE_FRAC = K.num('ALLY_ENGAGE_DAMAGE_FRAC');
export const ALLY_ENGAGE_MIN_M = K.num('ALLY_ENGAGE_MIN_M');
/** 한가할 때만 줍는 상자의 반경 (m) — 핑으로 찍힌 상자는 제한이 없다. */
export const ALLY_IDLE_LOOT_M = K.num('ALLY_IDLE_LOOT_M');
/** 레이드 진입 로딩 (owner: hub 암전 시작 · game `parts/LoadGate` · ui 원형 게이지). */
export const RAID_LOAD_FADE_OUT_S = K.num('RAID_LOAD_FADE_OUT_S');
export const RAID_LOAD_FADE_IN_S = K.num('RAID_LOAD_FADE_IN_S');
export const RAID_LOAD_TIMEOUT_S = K.num('RAID_LOAD_TIMEOUT_S');
export const RAID_LOAD_REPORT_S = K.num('RAID_LOAD_REPORT_S');
export const RAID_LOAD_WORLD_SHARE = K.num('RAID_LOAD_WORLD_SHARE');
export const RAID_LOAD_MIN_BLACK_S = K.num('RAID_LOAD_MIN_BLACK_S');
/** 대기 상한 위의 여유 (s) — 엔진 hold 상한 · 호스트의 `go` 가 오지 않은 클라이언트의 자가 해제 시점. */
export const RAID_LOAD_HOLD_MARGIN_S = K.num('RAID_LOAD_HOLD_MARGIN_S');
/** 암전이 끝난 뒤 권위의 발사를 기다리는 여유 (s, owner: hub) — 넘기면 암전을 풀고 함선으로 돌아온다. */
export const RAID_LOAD_START_GRACE_S = K.num('RAID_LOAD_START_GRACE_S');
/* ── end 2026-09-15 안드로이드 분대원 · 레이드 진입 로딩 ── */

/* ══ appended (2026-09-15): 땅굴벌레 등장 판정 개편 — 누적 확률제 · 진동 장치 소환 · 위협 1 어린 개체 (owner: enemies/sandworm · world/BurrowGround)
 * docs/DECISIONS.md 「2026-09-15 — 땅굴벌레」. `SANDWORM_WINDOW_*` · `SANDWORM_CHANCE_BY_THREAT` 는 은퇴 (export 만 남는다).
 * 검사 한 번의 확률표는 `src/enemies/sandworm/Director.ts` 머리 주석.
 */
/** 검사 한 번의 위협 배수 — index 0 = 행성 threat 1 (`data/tables.csv`). threat 1 > 0 (어린 개체가 나온다). */
export const SANDWORM_BASE_CHANCE_BY_THREAT = numberList('tables.csv', 'SANDWORM_BASE_CHANCE_BY_THREAT');
/** 자연 등장에 필요한 자격 인원 최소 수 (조금 무거움 이상 + 달리기, 서로 `SANDWORM_GROUP_RADIUS` 안). */
export const SANDWORM_MIN_MEMBERS = K.num('SANDWORM_MIN_MEMBERS');
/** 자격 인원 한 명의 가중치 — light · heavy/over. */
export const SANDWORM_P_PER_LIGHT = K.num('SANDWORM_P_PER_LIGHT');
export const SANDWORM_P_PER_HEAVY = K.num('SANDWORM_P_PER_HEAVY');
/** 거리 계수: 평균 거리 ≤ NEAR 면 1, GROUP_RADIUS 에서 FAR_MUL (선형). */
export const SANDWORM_P_NEAR_M = K.num('SANDWORM_P_NEAR_M');
export const SANDWORM_P_FAR_MUL = K.num('SANDWORM_P_FAR_MUL');
/** 유인 수류탄: 확률 가산 · 인정 거리(m) · 분출 자리로 고를 확률. */
export const SANDWORM_P_LURE = K.num('SANDWORM_P_LURE');
export const SANDWORM_LURE_RANGE_M = K.num('SANDWORM_LURE_RANGE_M');
export const SANDWORM_LURE_SPOT_CHANCE = K.num('SANDWORM_LURE_SPOT_CHANCE');
/** 어린 땅굴벌레(`sandworm_weak`): 고정 최대 체력 · 몸 · 분출 반경 배수. */
export const SANDWORM_WEAK_HP = K.num('SANDWORM_WEAK_HP');
export const SANDWORM_WEAK_SCALE = K.num('SANDWORM_WEAK_SCALE');
/** `WorldRef.burrowGroundOk`: 디렉터가 요구하는 맨땅 반지름(m) · 고리 표본 수 · 높이차 상한(m) · 경사 상한 · 둥지 여유(m). */
export const BURROW_GROUND_CHECK_R = K.num('BURROW_GROUND_CHECK_R');
export const BURROW_GROUND_RING_SAMPLES = K.num('BURROW_GROUND_RING_SAMPLES');
export const BURROW_GROUND_MAX_RISE_M = K.num('BURROW_GROUND_MAX_RISE_M');
export const BURROW_GROUND_MAX_SLOPE = K.num('BURROW_GROUND_MAX_SLOPE');
export const BURROW_GROUND_NEST_CLEAR_M = K.num('BURROW_GROUND_NEST_CLEAR_M');
/* ── end 2026-09-15 땅굴벌레 등장 판정 개편 ── */

/* ── [2026-09-15] 진동 장치 (owner: gadgets — docs/DECISIONS.md 「2026-09-15 — 땅굴벌레 · 진동 장치」) ── */
/** 바닥을 내리치는 간격 (s) · 땅굴벌레를 부르는 타격 순번 · 설치 가능 판정 반경 (m, `WorldRef.burrowGroundOk`) · 내구도 · 흔들림 반경 (m) · 흔들림 세기. */
export const THUMPER_INTERVAL_S = K.num('THUMPER_INTERVAL_S');
export const THUMPER_STRIKES = K.num('THUMPER_STRIKES');
export const THUMPER_GROUND_R = K.num('THUMPER_GROUND_R');
export const THUMPER_HP = K.num('THUMPER_HP');
export const THUMPER_SHAKE_RADIUS = K.num('THUMPER_SHAKE_RADIUS');
export const THUMPER_SHAKE = K.num('THUMPER_SHAKE');
/* ── end 2026-09-15 진동 장치 ── */

/* ── 2026-09-16 튜토리얼 포복 구간 조작 가이드 (owner: tutorial `TutorialSystem.pollCrawlHint`) ── */
/** 무너진 통로를 이 비율만큼 지나면 조작 가이드에 발사 · 정조준 줄이 붙는다 (0 입구 · 1 출구). */
export const TUTORIAL_CRAWL_AIM_HINT_FRAC = K.num('TUTORIAL_CRAWL_AIM_HINT_FRAC');
/* ── 2026-09-17 증축 안내 마지막 레이드 (owner: tutorial `TutorialSystem.onBuildRaidEnd`) ── */
/** 레이드에서 얻은 아이템의 판매가 합이 이만큼 이상인 채로 탈출하면 증축 안내의 마지막 목표가 달성된다 (크레딧). */
export const TUTORIAL_RAID_EXTRACT_VALUE_C = K.num('TUTORIAL_RAID_EXTRACT_VALUE_C');

/* ── 2026-09-16 메신저 버튼 빨간 점 튀어오르기 (owner: ui — `hud/Community`) ── */
/** 새 NPC 메시지 → 메신저 버튼 빨간 점이 튀어올랐다 내려앉는 시간 (초). 토스트 대신이다. */
export const MESSENGER_DOT_POP_S = K.num('MESSENGER_DOT_POP_S');
/** 그 첫 봉우리 높이 (px). */
export const MESSENGER_DOT_POP_PX = K.num('MESSENGER_DOT_POP_PX');
