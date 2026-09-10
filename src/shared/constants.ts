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
  /* appended (2026-09-07, 커서 rework): Alt frees the mouse cursor during gameplay without opening any screen. */
  CURSOR: string;
  /* appended (2026-09-09): H 홀드 = 의사소통 휠. 톡 누르면 아무 일도 없다 (STIM 이 은퇴하며 비운 자리다). */
  COMMS: string;
}

/** Factory defaults; `Keys` is the live (rebindable) copy. Both are keyed by `KeyAction`. */
export const DEFAULT_KEYS: Readonly<KeyBindings> = {
  FORWARD: 'KeyW', BACK: 'KeyS', LEFT: 'KeyA', RIGHT: 'KeyD',
  SPRINT: 'ShiftLeft', JUMP: 'Space',
  /** C toggles crouch, Z toggles prone, V rolls (ends prone) — Alt is the 커서 호출 key since 2026-09-07. */
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
  /* 2026-09-07 (커서 rework): Alt = 커서 표시 / 숨기기. 구르기 moved off Alt onto V. */
  CURSOR: 'AltLeft',
  /* 2026-09-09: 의사소통 휠. 은퇴한 STIM 과 같은 H 를 쓴다 — 그 키는 아무 데도 안 걸려 있었다. */
  COMMS: 'KeyH',
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

/* ── appended: weapon package (2026-09-05) ── */
import type { SocketSlot, AmmoType, WeaponClass } from './types';
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
export const QUICK_USABLE_CATEGORIES: readonly string[] = ['grenade', 'stim', 'gadget'];
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
/** Airstrike: explosion radius (m) and damage at the centre (linear falloff). */
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
/** @deprecated default of `Keys.IMPLANT` — read `Keys.IMPLANT` (rebindable) instead. */
export const KEY_IMPLANT = DEFAULT_KEYS.IMPLANT;
/** @deprecated default of `Keys.MELEE` — read `Keys.MELEE` instead. */
export const KEY_MELEE = DEFAULT_KEYS.MELEE;
/** @deprecated default of `Keys.THROW_MODE` — read `Keys.THROW_MODE` instead. */
export const KEY_THROW_MODE = DEFAULT_KEYS.THROW_MODE;

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
export const GADGET_INCENDIARY_DURATION = K.num('GADGET_INCENDIARY_DURATION');
export const GADGET_INCENDIARY_RADIUS = K.num('GADGET_INCENDIARY_RADIUS');
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

/* 컴포짓 보우: DMR-rate arrows, shorter reach than a legendary SR. */
export const BOW_DAMAGE = K.num('BOW_DAMAGE');
export const BOW_RANGE = K.num('BOW_RANGE');
export const BOW_FIRE_RATE = K.num('BOW_FIRE_RATE');
export const BOW_PROJECTILE_SPEED = K.num('BOW_PROJECTILE_SPEED');

/* 바주카: LMB impact rocket; RMB air-burst rocket (self damage + knockback when fired at the floor → super jump). */
export const BAZOOKA_DAMAGE = K.num('BAZOOKA_DAMAGE');
export const BAZOOKA_RADIUS = K.num('BAZOOKA_RADIUS');
export const BAZOOKA_SPEED = K.num('BAZOOKA_SPEED');
/** Seconds after launch when the RMB rocket detonates on its own. */
export const BAZOOKA_ALT_FUSE = K.num('BAZOOKA_ALT_FUSE');
export const BAZOOKA_ALT_DAMAGE = K.num('BAZOOKA_ALT_DAMAGE');
export const BAZOOKA_ALT_RADIUS = K.num('BAZOOKA_ALT_RADIUS');
/** Self damage taken inside the blast (flat, ignores armor DR) and the knockback speed away from the blast. */
export const BAZOOKA_SELF_DAMAGE = K.num('BAZOOKA_SELF_DAMAGE');
export const BAZOOKA_KNOCKBACK = K.num('BAZOOKA_KNOCKBACK');
/** Extra vertical impulse when the blast is below the player's feet while airborne (rocket jump). */
export const BAZOOKA_SUPER_JUMP = K.num('BAZOOKA_SUPER_JUMP');
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
export const SHIP_STATE_VERSION = 3;   // Phase 9: 3 = `books` / `bookDex` (absent → empty; no data migration)
export const SHIP_ROOM_COUNT = K.num('SHIP_ROOM_COUNT');
/** Room floor grid (cells) and cell size (m): 8 × 8 × 0.5 = a 4 × 4 m room. */
export const ROOM_GRID_COLS = K.num('ROOM_GRID_COLS');
export const ROOM_GRID_ROWS = K.num('ROOM_GRID_ROWS');
export const HOUSING_CELL_SIZE = K.num('HOUSING_CELL_SIZE');
export const GENERATOR_MAX_LEVEL = K.num('GENERATOR_MAX_LEVEL');
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
export const SEARCH_TIME_BY_RARITY: Readonly<Record<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', number>> =
  numberMap<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'>('tables.csv', 'SEARCH_TIME_BY_RARITY');
/** Searching only runs while the container window is open and the player is within this many metres of it. */
export const SEARCH_MAX_DISTANCE = K.num('SEARCH_MAX_DISTANCE');

/* training range (시뮬레이션 훈련장) — owner: world */
/** Arena side (m), flat, walled; the player spawns at the south end facing the lanes. */
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
export const SEED_GROW_HOURS_BY_RARITY: Readonly<Record<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', number>> =
  numberMap<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'>('tables.csv', 'SEED_GROW_HOURS_BY_RARITY');

/* ── audio settings (owner: audio) ── */
/** localStorage key of the volume settings (`AudioSettings`). */
export const AUDIO_STORAGE_KEY = 'scav.audio';
export const AUDIO_DEFAULT_MASTER = K.num('AUDIO_DEFAULT_MASTER');
export const AUDIO_DEFAULT_SFX = K.num('AUDIO_DEFAULT_SFX');

/* ── ship doors + room lighting (owner: hub) ── */
/** A room / cockpit door slides open when the player is within this many metres of its threshold. */
export const DOOR_OPEN_DISTANCE = K.num('DOOR_OPEN_DISTANCE');
/** Door slide speed (fraction of full travel per second). */
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
export const BOOK_RARITY_MUL: Readonly<Record<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', number>> =
  numberMap<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'>('tables.csv', 'BOOK_RARITY_MUL');
/** Cap of the 서재 multiplier for one skill. */
export const BOOK_GAIN_MAX = K.num('BOOK_GAIN_MAX');

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
/** Body yaw of a portrait: turned diagonally toward the camera's right (the soldier model's front is −Z). */
export const HUB_READY_PORTRAIT_YAW = -Math.PI / 4;
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
/** `ctx.uiBlockers` token the Alt 커서 (a free cursor with no screen behind it) holds while it is up. */
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
/** 키카드로 지하실 문을 여는 홀드 시간(초). */
export const STRUCTURE_UNLOCK_HOLD_S = K.num('STRUCTURE_UNLOCK_HOLD_S');
/** 구조물 문 · 컴퓨터 상호작용 거리(m). */
export const STRUCTURE_INTERACT_RANGE = K.num('STRUCTURE_INTERACT_RANGE');

/* ── 선로 · 전차 (owner: world/Rails) ── */
/** 구역에 선로가 놓일 확률 (0 = 언제나 없음). */
export const RAIL_CHANCE = K.num('RAIL_CHANCE');
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
