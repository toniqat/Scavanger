/** Global gameplay constants shared by every module. Do not duplicate these elsewhere. */
export const MAP_SIZE = 640;                 // world is a square [-MAP_SIZE/2, MAP_SIZE/2] on X and Z (meters)
export const EXTRACTION_COUNTDOWN = 120;     // seconds from switch press to ship arrival
export const PLAYER_MAX_HP = 100;
export const PLAYER_RADIUS = 0.45;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_WALK_SPEED = 4.2;
export const PLAYER_SPRINT_SPEED = 7.2;
export const PLAYER_INTERACT_RANGE = 3.0;
export const INVENTORY_COLS = 10;
export const INVENTORY_ROWS = 6;
export const GRAVITY = 24;
export const PLAYER_MAX_STAMINA = 100;
export const PLAYER_CROUCH_SPEED = 2.4;
export const PLAYER_PRONE_SPEED = 1.3;
/** Seconds a ping marker stays on screen / map. */
export const PING_LIFETIME = 25;

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
  PRIMARY: string; PRIMARY2: string; SECONDARY: string; SWAP: string;
  INVENTORY: string; ROTATE_ITEM: string; MENU: string; MAP: string;
  DROP_ITEM: string; CHAT: string;
  QUICK: string; RESPAWN: string; GIVE_UP: string;
  SHIP_CALL: string;
  /* appended (key rebinding, 2026-09-06): the tactical-kit keys and the three mouse actions joined the table. */
  IMPLANT: string; MELEE: string; THROW_MODE: string;
  FIRE: string; AIM: string; PING: string;
  /* appended (dev console, 2026-09-06): ` opens the console on a dev client, Home = /movecheat fast move. */
  CONSOLE: string; MOVE_CHEAT: string;
}

/** Factory defaults; `Keys` is the live (rebindable) copy. Both are keyed by `KeyAction`. */
export const DEFAULT_KEYS: Readonly<KeyBindings> = {
  FORWARD: 'KeyW', BACK: 'KeyS', LEFT: 'KeyA', RIGHT: 'KeyD',
  SPRINT: 'ShiftLeft', JUMP: 'Space',
  /** C toggles crouch, Z toggles prone, Alt rolls (ends prone). */
  CROUCH: 'KeyC', PRONE: 'KeyZ', DIVE: 'AltLeft',
  RELOAD: 'KeyR', INTERACT: 'KeyE',
  /** Tactical kit: H puts a stim in hand directly (F is the melee attack). GRENADE is legacy (G = ship calls). */
  STIM: 'KeyH', GRENADE: 'KeyG',
  /** Weapon package: 1 = 주무기 I, 2 = 주무기 II, 3 = 보조무기. Tactical kit: V = previous weapon (Q is the implant). */
  PRIMARY: 'Digit1', PRIMARY2: 'Digit2', SECONDARY: 'Digit3', SWAP: 'KeyV',
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
  /* mouse actions (rebindable to other mouse buttons only) */
  FIRE: 'Mouse0', AIM: 'Mouse2', PING: 'Mouse1',
  /* dev console */
  CONSOLE: 'Backquote', MOVE_CHEAT: 'Home',
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
export const PING_DRAG_THRESHOLD_PX = 45;
/** Max seconds the middle button may be held before the gesture is treated as a plain ping. */
export const PING_HOLD_MAX = 1.2;
/** Chat log lines kept. */
export const CHAT_MAX_LINES = 60;
/** Seconds a dropped item pickup stays in the world (0 = forever). */
export const PICKUP_LIFETIME = 0;
/** Max simultaneous pickups per mission (oldest removed). */
export const PICKUP_MAX = 96;
/** Seconds between "everyone boarded" and mission launch in the hub. */
export const HUB_LAUNCH_COUNTDOWN = 3;
/** Docking cutscene length (s). */
export const HUB_DOCKING_DURATION = 6;

/* ── appended: weapon package (2026-09-05) ── */
import type { SocketSlot, AmmoType, WeaponClass } from './types';
/** Durability lost per trigger pull (shotgun pellets count once). */
export const WEAPON_DURABILITY_PER_SHOT = 1;
/** Fallback `WeaponDef.maxDurability`. */
export const WEAPON_DEFAULT_DURABILITY = 400;
/** Holster + draw time when swapping to a primary / secondary (s). */
export const WEAPON_SWAP_TIME_PRIMARY = 0.4;
export const WEAPON_SWAP_TIME_SECONDARY = 0.1;
/** Aim-in time (s) for primaries; secondaries use half. Stocks multiply it. */
export const WEAPON_ADS_TIME = 0.25;
/** Per grade above I: damage +12 %, max durability +25 %. */
export const WEAPON_GRADE_DAMAGE_STEP = 0.12;
export const WEAPON_GRADE_DURABILITY_STEP = 0.25;
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
export const AMMO_STACK_ROUNDS: Readonly<Record<AmmoType, number>> = {
  light: 120, medium: 90, heavy: 30, shell: 24,
  rifle: 90, pistol: 120, shotgun: 24, energy: 90,
  /* unique-weapon calibres (2026-09-06): 연료통 / 전지 / 표창 / 화살 / 로켓 / 탄띠 */
  fuel: 200, cell: 60, shuriken: 40, arrow: 30, rocket: 6, belt: 300,
};
/** Bag grid with no backpack equipped (half of a common bag). `INVENTORY_COLS × INVENTORY_ROWS` is the legendary bag. */
export const BAG_DEFAULT_COLS = 5;
export const BAG_DEFAULT_ROWS = 3;
export const BAG_DEFAULT_QUICK_SLOTS = 1;
/** Repair: 1 폐금속 per REPAIR_SCRAP_PER durability missing (rounded up); grade ≥ III also needs 1 합금 판 per REPAIR_ALLOY_PER. */
export const REPAIR_SCRAP_PER = 100;
export const REPAIR_ALLOY_PER = 250;

/* ── appended: Phase 2 — down / revive / respawn ── */
/** Separate health pool while 전투불능. */
export const PLAYER_DOWN_HP = 100;
/** Bleed per second while downed. */
export const PLAYER_DOWN_BLEED_PER_SEC = 1;
/** Crawl speed multiplier on top of PLAYER_PRONE_SPEED while downed. */
export const PLAYER_DOWN_SPEED_MUL = 0.6;
/** Teammate hold (s) and range (m) to revive; hp after a revive. */
export const PLAYER_REVIVE_HOLD = 10;
export const PLAYER_REVIVE_RANGE = 3;
export const PLAYER_REVIVE_HP = 10;
/** Seconds after death until the respawn (hellpod at the mission start point) is allowed. */
export const PLAYER_RESPAWN_DELAY = 30;
/** Holding Space this long while downed gives up (immediate death → respawn timer). */
export const PLAYER_GIVE_UP_HOLD = 1.5;

/* ── appended: Phase 2 — quick-use wheel / grenade cooking ── */
export const QUICK_SLOTS = 8;
/** Wheel directions by slot index. */
export const QUICK_SLOT_DIRS: readonly string[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const QUICK_SLOT_LABEL_KO: readonly string[] = ['위', '오른쪽 위', '오른쪽', '오른쪽 아래', '아래', '왼쪽 아래', '왼쪽', '왼쪽 위'];
/** Item categories that can sit in a wheel slot. */
export const QUICK_USABLE_CATEGORIES: readonly string[] = ['grenade', 'stim', 'gadget'];
/**
 * Which wheel slots a bag with `n` quick slots unlocks: the first `n` entries of this order (N, S, E, W, then the
 * diagonals), so a 2-slot bag gives up/down rather than up/up-right. Use `isQuickSlotActive`.
 */
export const QUICK_SLOT_UNLOCK_ORDER: readonly number[] = [0, 4, 2, 6, 1, 3, 5, 7];
export function isQuickSlotActive(index: number, count: number): boolean {
  const rank = QUICK_SLOT_UNLOCK_ORDER.indexOf(index);
  return rank >= 0 && rank < Math.max(0, Math.min(QUICK_SLOTS, count));
}
/** F held longer than this opens the wheel; shorter = re-equip the last quick item. */
export const QUICK_WHEEL_HOLD = 0.22;
/** Pointer-locked mouse travel (px) needed before a wheel direction counts. */
export const QUICK_WHEEL_DRAG_PX = 30;
/** Fuse after the pin is pulled; a grenade cooked this long explodes in the hand. */
export const GRENADE_FUSE = 3;
export const GRENADE_COOK_MAX = 3;
/** Underhand toss speed multiplier. */
export const GRENADE_UNDERHAND_SPEED_MUL = 0.45;

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
export const STRATAGEM_DEFS: readonly StratagemDef[] = [
  { id: 'orbital_laser', name: '궤도 폭격', cooldown: 90, delay: 5, targeting: 'topview', radius: 4, hint: '10초간 레이저 — 피아 무구분' },
  { id: 'airstrike', name: '항공 폭탄', cooldown: 90, delay: 5, targeting: 'topview', radius: 14, hint: '대형 폭발 — 피아 무구분' },
  { id: 'supply_drop', name: '보급품 투하', cooldown: 60, delay: 3, targeting: 'ground', radius: 2.5, hint: '소모품 상자 — 낙하 충돌 피해' },
  { id: 'structure_drop', name: '구조물 투하', cooldown: 60, delay: 3, targeting: 'ground', radius: 7, hint: '엄폐물 5개 — 낙하 충돌 피해' },
];
export const STRATAGEM_ORDER: readonly StratagemId[] = ['orbital_laser', 'airstrike', 'supply_drop', 'structure_drop'];
/** G held longer than this opens the wheel; a tap re-arms the last call. */
export const STRATAGEM_WHEEL_HOLD = 0.22;
/** LMB hold (s) before an orbital call switches to the top view. */
export const STRATAGEM_CHARGE_TIME = 3;
/** Top view: camera height above the player (m) and max cursor distance from the player (m). */
export const TOPVIEW_HEIGHT = 90;
export const TOPVIEW_RANGE = 120;
/** Pointer-locked mouse pixels → metres of cursor travel in the top view. */
export const TOPVIEW_CURSOR_SPEED = 0.12;
/** Ground targeting (drops): max distance of the aim-ray hit from the player (m). */
export const GROUND_TARGET_RANGE = 60;
/** Orbital laser: beam duration (s), damage radius (m), damage per second. */
export const LASER_DURATION = 10;
export const LASER_RADIUS = 4;
export const LASER_DPS = 240;
/** Airstrike: explosion radius (m) and damage at the centre (linear falloff). */
export const AIRSTRIKE_RADIUS = 14;
export const AIRSTRIKE_DAMAGE = 480;
/** Supply crate: fall time (s), impact damage radius (m) / damage, loot tier (see items LOOT_TABLES), lifetime after landing (s). */
export const SUPPLY_FALL_TIME = 2.2;
export const SUPPLY_IMPACT_RADIUS = 2.5;
export const SUPPLY_IMPACT_DAMAGE = 400;
export const SUPPLY_CRATE_TIER = 5;
/** Structures: count, hp, scatter radius around the target (m), impact damage radius / damage, fall time (s). */
export const STRUCTURE_COUNT = 5;
export const STRUCTURE_HP = 2000;
export const STRUCTURE_SCATTER = 7;
export const STRUCTURE_IMPACT_RADIUS = 2.2;
export const STRUCTURE_IMPACT_DAMAGE = 800;
export const STRUCTURE_FALL_TIME = 2.0;
/** Off-screen indicators: squadmate pings show an edge arrow for this many seconds after placement. */
export const OFFSCREEN_PING_SECONDS = 5;

/* ── appended: Phase 4 — rogues / enemy gimmicks / corpses ── */
/** Seconds a lootable corpse (and its interactable) stays in the world. */
export const CORPSE_LIFETIME = 45;
/** Corpse interaction radius (m). */
export const CORPSE_INTERACT_RADIUS = 2.4;
/** Rogue gunner: reaction delay before the first shot (s), aim error (radians) at hip / after settling, damage per hit, rounds per burst. */
export const ROGUE_REACTION = 0.9;
export const ROGUE_AIM_ERROR = 0.09;
export const ROGUE_AIM_ERROR_SETTLED = 0.045;
export const ROGUE_DAMAGE = 9;
export const ROGUE_BURST = 4;
/** Rogue engagement range (m) and the "rush the player" impulse chance per cover cycle. */
export const ROGUE_RANGE = 55;
export const ROGUE_RUSH_CHANCE = 0.2;
/** Boss rogue multipliers and escort count. */
export const ROGUE_BOSS_SCALE = 1.5;
export const ROGUE_BOSS_HP_MUL = 5;
export const ROGUE_BOSS_ESCORTS = 3;
/** Artillery bug: preferred stand-off range (m), shell flight time (s), blast radius (m) / damage, shell hit radius for interception (m). */
export const ARTILLERY_RANGE = 90;
export const SHELL_FLIGHT_TIME = 4.5;
export const SHELL_BLAST_RADIUS = 5;
export const SHELL_DAMAGE = 55;
export const SHELL_RADIUS = 0.6;
/** Toxic bug: burst radius (m), damage (players and enemies alike), trigger distance (m). */
export const TOXIC_RADIUS = 5;
export const TOXIC_DAMAGE = 70;
export const TOXIC_TRIGGER_DIST = 2.2;
/** Behemoth: scale vs a warrior, charge speed (m/s), charge damage, knockback speed (m/s), wind-up (s). */
export const BEHEMOTH_SCALE = 4;
export const BEHEMOTH_CHARGE_SPEED = 16;
export const BEHEMOTH_CHARGE_DAMAGE = 60;
export const BEHEMOTH_KNOCKBACK = 12;
export const BEHEMOTH_WINDUP = 1.4;
/** Ammo calibres that bounce off armour plate (`EnemyHit.armored`). */
export const ARMOR_IMMUNE_AMMO: readonly string[] = ['light', 'medium', 'shell', 'pistol', 'rifle', 'shotgun'];

/* ── appended: tactical kit (implants, gadgets, melee, gear, progression; merged 2026-09-06) ── */
/** @deprecated default of `Keys.IMPLANT` — read `Keys.IMPLANT` (rebindable) instead. */
export const KEY_IMPLANT = DEFAULT_KEYS.IMPLANT;
/** @deprecated default of `Keys.MELEE` — read `Keys.MELEE` instead. */
export const KEY_MELEE = DEFAULT_KEYS.MELEE;
/** @deprecated default of `Keys.THROW_MODE` — read `Keys.THROW_MODE` instead. */
export const KEY_THROW_MODE = DEFAULT_KEYS.THROW_MODE;

/* ── melee ── */
export const MELEE_DAMAGE = 45;
export const MELEE_RANGE = 2.4;
export const MELEE_STAMINA_COST = 12;
export const MELEE_COOLDOWN = 0.75;
/** Weapons whose stock adds melee damage list a multiplier; this is the default for everything else. */
export const MELEE_STOCK_MUL_DEFAULT = 1;

/* ── roll (구르기, replaces the dive on Alt) ── */
export const ROLL_DURATION = 0.55;
export const ROLL_DISTANCE = 4.2;
export const ROLL_STAMINA_COST = 22;
export const ROLL_COOLDOWN = 0.6;
/** Damage taken during the roll is multiplied by this (small i-frame substitute). */
export const ROLL_DAMAGE_MUL = 0.6;

/* ── weight ── */
export const WEIGHT_BASE_CAPACITY = 28;        // kg at strength 0
export const WEIGHT_PER_STRENGTH = 2.2;        // kg per 근력 point
export const WEIGHT_LIGHT_RATIO = 0.7;         // 조금 무거움
export const WEIGHT_HEAVY_RATIO = 0.9;         // 무거움
export const WEIGHT_OVER_RATIO = 1.0;          // 과적
export const WEIGHT_LIGHT_STAMINA_MUL = 0.7;   // -30 % stamina regen
export const WEIGHT_HEAVY_STAMINA_MUL = 0.5;   // -50 % stamina regen
export const WEIGHT_HEAVY_MOVE_MUL = 0.88;
export const WEIGHT_STATE_LABEL_KO: Record<string, string> = {
  normal: '보통', light: '조금 무거움', heavy: '무거움', over: '과적',
};

/* ── detection (감지 시스템) ── */
export const DETECT_BASE_RADIUS = 14;          // interactable highlight radius at 인지력 0
export const DETECT_PER_PERCEPTION = 1.6;      // + meters per 인지력 point
export const DETECT_ENEMY_BASE_RADIUS = 26;    // off-screen enemy arrow radius
export const DETECT_ENEMY_PER_PERCEPTION = 2.4;
/** Fresnel highlight colour for interactables / revealed objects. */
export const DETECT_HIGHLIGHT_COLOR = 0x8fe8ff;
export const DETECT_ENEMY_COLOR = 0xff4d4d;

/* ── tactical implants ── */
export const IMPLANT_GRAPPLE_RANGE = 45;
export const IMPLANT_GRAPPLE_SPEED = 26;       // pull speed (m/s)
export const IMPLANT_GRAPPLE_COOLDOWN = 6;
export const IMPLANT_DASH_CHARGES = 3;
export const IMPLANT_DASH_DISTANCE = 7.5;
export const IMPLANT_DASH_COOLDOWN = 5;        // per charge
export const IMPLANT_BARRIER_HP = 2000;
export const IMPLANT_BARRIER_WIDTH = 7;
export const IMPLANT_BARRIER_HEIGHT = 3.2;
/** Shield hp regenerated per second while it is stowed. */
export const IMPLANT_BARRIER_REGEN = 120;
/** After the shield collapses it is locked for this long; its hp regenerates from 0 to full over exactly this window (HUD gauge). */
export const IMPLANT_BARRIER_BREAK_LOCKOUT = 10;
export const IMPLANT_OVERCHARGE_RANGE = 22;
/** @deprecated legacy beam rate; the hold-to-channel overcharge uses SELF / ALLY rates below. */
export const IMPLANT_OVERCHARGE_HEAL_PER_SEC = 45;
/** Overcharge (hold Q): slow self heal, faster heal on the ally under the crosshair. */
export const IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC = 10;
export const IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC = 25;
/** Energy = seconds of continuous channelling; refills from empty in IMPLANT_OVERCHARGE_REGEN_TIME while released. */
export const IMPLANT_OVERCHARGE_ENERGY = 6;
export const IMPLANT_OVERCHARGE_REGEN_TIME = 12;
/** Speed / fire-rate buff applies while channelling only when the target's hp is at least this ratio. */
export const IMPLANT_OVERCHARGE_BUFF_HP_RATIO = 0.9;
export const IMPLANT_OVERCHARGE_SPEED_MUL = 1.28;
export const IMPLANT_OVERCHARGE_FIRERATE_MUL = 1.3;
export const IMPLANT_OVERCHARGE_DURATION = 4;  // buff lingers this long after the beam breaks
export const IMPLANT_SCAN_PULSE_INTERVAL = 1;
export const IMPLANT_SCAN_MAX_PULSES = 5;
export const IMPLANT_SCAN_RADIUS_STEP = 18;    // radius grows by this per pulse
export const IMPLANT_SCAN_REVEAL_TIME = 10;
export const IMPLANT_SCAN_COOLDOWN = 14;
export const IMPLANT_AT_DAMAGE = 420;
export const IMPLANT_AT_RADIUS = 7.5;
export const IMPLANT_AT_SPEED = 48;
export const IMPLANT_AT_COOLDOWN = 12;

/* ── gadgets ── */
export const GADGET_CLOAK_DURATION = 12;
export const GADGET_CLOAK_SHARE_RADIUS = 8;
export const GADGET_DOME_HP = 1000;
export const GADGET_DOME_RADIUS = 5;
export const GADGET_BARRICADE_HP = 1800;
export const GADGET_BARRICADE_RECOVER_TIME = 3;
export const GADGET_LURE_DURATION = 12;
export const GADGET_LURE_RADIUS = 40;
export const GADGET_SMOKE_DURATION = 16;
export const GADGET_SMOKE_RADIUS = 7;
export const GADGET_MINE_ARM_TIME = 3;
export const GADGET_MINE_RADIUS = 6.5;
export const GADGET_MINE_DAMAGE = 220;
export const GADGET_TURRET_HP = 600;
export const GADGET_TURRET_RANGE = 32;
export const GADGET_TURRET_DPS = 60;
export const GADGET_TURRET_DURATION = 90;
export const GADGET_INCENDIARY_DURATION = 10;
export const GADGET_INCENDIARY_RADIUS = 5;
export const GADGET_INCENDIARY_DPS = 45;
export const GADGET_JUMPPAD_IMPULSE = 13;
export const GADGET_JUMPPAD_FORWARD = 9;
/** Hold time (s) to defuse a mine / recover a turret, jump pad or barricade. */
export const GADGET_DEFUSE_TIME = 3;

/* ── stealth / cloak ── */
/** Enemy detection range is multiplied by this while the target is cloaked and behaving. */
export const CLOAK_DETECT_MUL = 0.18;
/** Cloak breaks for this long after firing / sprinting near an alerted enemy. */
export const CLOAK_BREAK_TIME = 3;
/** Distance (m) at which an alerted enemy sees a cloaked target regardless. */
export const CLOAK_REVEAL_DISTANCE = 4;

/* ── armor / durability ── */
/** Damage reduction of numbered armor I..V. */
export const ARMOR_DR_BY_TIER: readonly number[] = [0, 0.06, 0.12, 0.18, 0.24, 0.30];
/** Armor durability lost per point of damage absorbed. */
export const ARMOR_DURABILITY_PER_DAMAGE = 0.35;
/** Fire-rate multiplier once a weapon is broken (durability 0) — unused while broken weapons refuse to fire. */
export const BROKEN_WEAPON_FIRERATE_MUL = 0.5;

/* ── gathering / crafting ── */
export const GATHER_NODES_PER_MISSION = 34;
export const GATHER_INTERACT_TIME = 2;
export const CRAFT_DEFAULT_TIME = 3;

/* ── progression ── */
export const STAT_BASE = 5;
export const STAT_MAX = 20;
export const STAT_POINTS_PER_LEVEL = 1;   // Phase 5 (2026-09-06): was 2
export const SKILL_LEVEL_MAX = 100;
export const PROFILE_STORAGE_KEY = 'scav.profile';
export const PROFILE_VERSION = 1;
/** XP needed to reach level n+1: XP_BASE * n^XP_EXPONENT. */
export const XP_BASE = 120;   // Phase 5 (2026-09-06): was 240 (plan: 120 × n^1.35)
export const XP_EXPONENT = 1.35;

/* ── appended: key rebinding + ship stash (2026-09-06) ── */
/** localStorage key of the player's key bindings (`shared/Keybinds.ts`). */
export const KEYBINDS_STORAGE_KEY = 'scav.keybinds';
/** localStorage key of the ship stash (`inventory/Stash.ts`) and its fixed grid. */
export const STASH_STORAGE_KEY = 'scav.stash';
export const STASH_COLS = 10;
export const STASH_ROWS = 24;

/* ══ appended: dev console · unique weapons · stat XP · ship housing (2026-09-06) ═══════════════════════ */

/* ── dev console (owner: console/) ── */
export const CONSOLE_HISTORY_KEY = 'scav.console.history';
export const CONSOLE_HISTORY_MAX = 50;
/** Output lines kept in the console log. */
export const CONSOLE_MAX_LINES = 200;
/** Suggestions shown above the input while typing. */
export const CONSOLE_SUGGESTIONS_MAX = 8;
/** `/movecheat 1` + Home: metres per second along the camera forward. */
export const MOVE_CHEAT_SPEED = 45;

/* ── unique weapons (owner: items data, weapons behaviour) ── */
/** Legendary-only uniques (`WeaponDef.unique`). Item ids are `wpn_<id>` like every weapon. */
export const UNIQUE_WEAPON_IDS = ['u_flame', 'u_shock', 'u_shuriken', 'u_bow', 'u_bazooka', 'u_minigun'] as const;
export const UNIQUE_WEAPON_LABEL_KO = {
  flamethrower: '화염방사기', shockgun: '전격총', shuriken: '표창', bow: '컴포짓 보우', bazooka: '바주카', minigun: '미니건',
} as const;

/* 화염방사기: LMB wide cone, hold to damage; RMB long narrow jet. Heat stacks → 전소 (writhing, no actions). */
export const FLAME_RANGE = 12;
export const FLAME_CONE_DEG = 32;
export const FLAME_DPS = 95;
export const FLAME_ALT_RANGE = 26;
export const FLAME_ALT_CONE_DEG = 7;
export const FLAME_ALT_DPS = 75;
/** Fuel units (ammo `qty`) burnt per second while spraying. */
export const FLAME_FUEL_PER_SEC = 12;
/** Heat an enemy accumulates from flame damage before it is set 전소 (`applyStatus 'incinerated'`). */
export const BURNOUT_THRESHOLD = 240;
/** Heat lost per second when not being burnt. */
export const BURNOUT_DECAY_PER_SEC = 60;
export const BURNOUT_DURATION = 4;
/** Residual burning applied on every flame tick (dps, seconds). */
export const FLAME_AFTERBURN_DPS = 12;
export const FLAME_AFTERBURN_DURATION = 3;

/* 전격총: LMB chains to several nearby enemies; RMB hold to charge, release = DMR-class bolt. */
export const SHOCK_RANGE = 14;
export const SHOCK_CONE_DEG = 50;
export const SHOCK_MAX_TARGETS = 4;
export const SHOCK_DPS = 72;
/** Cell units per second while the arc is on. */
export const SHOCK_CELL_PER_SEC = 8;
export const SHOCK_CHARGE_TIME = 1.1;
/** Damage of a fully charged bolt; a partial charge scales linearly from SHOCK_CHARGE_MIN_RATIO. */
export const SHOCK_CHARGE_DAMAGE = 150;
export const SHOCK_CHARGE_MIN_RATIO = 0.35;
export const SHOCK_CHARGE_RANGE = 200;
/** Cells per charged bolt. */
export const SHOCK_CHARGE_CELLS = 6;
/** 'shocked' status: slow factor and duration applied by the arc. */
export const SHOCK_SLOW_FACTOR = 0.55;
export const SHOCK_SLOW_DURATION = 1.2;

/* 표창: LMB one, RMB fan of three. Melee: F tap = normal swing, F hold >= SLASH_HOLD_TIME then release = 용검 big slash. */
export const SHURIKEN_DAMAGE = 58;
export const SHURIKEN_SPEED = 65;
export const SHURIKEN_FIRE_RATE = 3.2;
export const SHURIKEN_TRIPLE_SPREAD_DEG = 7;
export const SHURIKEN_TRIPLE_COOLDOWN = 0.9;
export const SLASH_HOLD_TIME = 0.45;
/** Fraction of max stamina the big slash costs (refused below it). */
export const SLASH_STAMINA_RATIO = 0.5;
export const SLASH_DAMAGE = 280;
export const SLASH_RANGE = 3.8;
export const SLASH_ARC_DEG = 160;
/** Camera FOV multiplier while `PlayerRef.setViewWiden(true)` (the slash wind-up / swing). */
export const SLASH_FOV_MUL = 1.28;
export const SLASH_DURATION = 0.6;

/* 컴포짓 보우: DMR-rate arrows, shorter reach than a legendary SR. */
export const BOW_DAMAGE = 150;
export const BOW_RANGE = 150;
export const BOW_FIRE_RATE = 2.4;
export const BOW_PROJECTILE_SPEED = 115;

/* 바주카: LMB impact rocket; RMB air-burst rocket (self damage + knockback when fired at the floor → super jump). */
export const BAZOOKA_DAMAGE = 420;
export const BAZOOKA_RADIUS = 5.5;
export const BAZOOKA_SPEED = 48;
/** Seconds after launch when the RMB rocket detonates on its own. */
export const BAZOOKA_ALT_FUSE = 0.4;
export const BAZOOKA_ALT_DAMAGE = 260;
export const BAZOOKA_ALT_RADIUS = 4.5;
/** Self damage taken inside the blast (flat, ignores armor DR) and the knockback speed away from the blast. */
export const BAZOOKA_SELF_DAMAGE = 22;
export const BAZOOKA_KNOCKBACK = 15;
/** Extra vertical impulse when the blast is below the player's feet while airborne (rocket jump). */
export const BAZOOKA_SUPER_JUMP = 17;
export const BAZOOKA_FIRE_RATE = 0.8;

/* 미니건: LMB hold spins up, fires once spun; movement slowed while spinning. */
export const MINIGUN_SPINUP_TIME = 1.2;
export const MINIGUN_SPINDOWN_TIME = 0.8;
export const MINIGUN_DAMAGE = 24;
export const MINIGUN_FIRE_RATE = 24;
export const MINIGUN_SPREAD_DEG = 2.6;
/** Move speed multiplier while spinning (`setSpeedModifier('minigun', …)`). */
export const MINIGUN_MOVE_MUL = 0.55;

/** Rounds per stack of the unique calibres (extends AMMO_STACK_ROUNDS for the new AmmoType values). */
export const UNIQUE_AMMO_STACK_ROUNDS = { fuel: 200, cell: 60, shuriken: 40, arrow: 30, rocket: 6, belt: 300 } as const;

/* ── stat XP (owner: progression) ── */
/** Raw XP for the next stat point at stat value v: STAT_XP_BASE × v^STAT_XP_EXPONENT (5 → 1118, 10 → 3162). */
export const STAT_XP_BASE = 100;
export const STAT_XP_EXPONENT = 1.5;
/** Stats never drop below this (cheat / debuff floor). */
export const STAT_MIN = 1;

/* ── ship housing (owner: housing/ rules, hub/ geometry) ── */
export const SHIP_STORAGE_KEY = 'scav.ship';
export const SHIP_STATE_VERSION = 1;
export const SHIP_ROOM_COUNT = 10;
/** Room floor grid (cells) and cell size (m): 8 × 8 × 0.5 = a 4 × 4 m room. */
export const ROOM_GRID_COLS = 8;
export const ROOM_GRID_ROWS = 8;
export const HOUSING_CELL_SIZE = 0.5;
export const GENERATOR_MAX_LEVEL = 5;
export const STORAGE_MAX_LEVEL = 5;
export const WORKSHOP_MAX_LEVEL = 3;
export const RANGE_MAX_LEVEL = 5;
export const BENCH_MAX_LEVEL = 3;
/** Stash rows by storage level (index = level, level 0 = STASH_ROWS). Columns stay STASH_COLS. */
export const STASH_ROWS_BY_STORAGE_LEVEL: readonly number[] = [24, 30, 36, 42, 48, 60];
/** Loadout presets by range level (index = level; 0 = no range room). */
export const PRESETS_BY_RANGE_LEVEL: readonly number[] = [0, 3, 4, 5, 6, 8];
/** Gun-skill XP multiplier bonus per range level (level 3 → ×1.3). */
export const RANGE_SKILL_GAIN_PER_LEVEL = 0.1;
/** Craft material discount per workshop level above 1 (level 3 → ×0.8). */
export const WORKSHOP_COST_DISCOUNT_PER_LEVEL = 0.1;
/** Facility upgrade costs (`[level-1]` = cost to reach `level`; level 1 of a room comes free with its purpose). */
export const GENERATOR_UPGRADE_COST: readonly { defId: string; qty: number }[][] = [
  [{ defId: 'mat_scrap', qty: 4 }],
  [{ defId: 'mat_scrap', qty: 8 }, { defId: 'mat_cable', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 6 }, { defId: 'mat_cable', qty: 4 }, { defId: 'mat_power_cell', qty: 1 }],
  [{ defId: 'mat_alloy', qty: 10 }, { defId: 'mat_circuit', qty: 3 }, { defId: 'mat_power_cell', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 14 }, { defId: 'mat_circuit', qty: 6 }, { defId: 'mat_power_cell', qty: 4 }],
];
export const STORAGE_UPGRADE_COST: readonly { defId: string; qty: number }[][] = [
  [{ defId: 'mat_scrap', qty: 6 }],
  [{ defId: 'mat_scrap', qty: 10 }, { defId: 'mat_alloy', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 6 }, { defId: 'mat_cable', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 10 }, { defId: 'mat_circuit', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 16 }, { defId: 'mat_circuit', qty: 4 }, { defId: 'mat_power_cell', qty: 2 }],
];
export const WORKSHOP_UPGRADE_COST: readonly { defId: string; qty: number }[][] = [
  [{ defId: 'mat_scrap', qty: 10 }, { defId: 'mat_cable', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 8 }, { defId: 'mat_circuit', qty: 3 }],
];
export const RANGE_UPGRADE_COST: readonly { defId: string; qty: number }[][] = [
  [{ defId: 'mat_scrap', qty: 8 }],
  [{ defId: 'mat_scrap', qty: 12 }, { defId: 'mat_cable', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 6 }, { defId: 'mat_circuit', qty: 2 }],
  [{ defId: 'mat_alloy', qty: 12 }, { defId: 'mat_circuit', qty: 4 }, { defId: 'mat_power_cell', qty: 2 }],
];

/* ══ appended: Phase 5 — meta progression (2026-09-06) ═══════════════════════════════════════════════════ */
/** localStorage key of the meta save (credits / reputation / contracts / quests, `meta/`). */
export const META_STORAGE_KEY = 'scav.meta';
/** localStorage key of the persisted bag + loadout + quick slots (`inventory/Loadout.ts`). */
export const LOADOUT_STORAGE_KEY = 'scav.loadout';
