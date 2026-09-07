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
  /* 2026-09-07: one 세트 = one stack (경 80 · 준중 50 · 중 25 · 산탄 25) — the 기본 지급품 counts sets. */
  light: 80, medium: 50, heavy: 25, shell: 25,
  rifle: 50, pistol: 80, shotgun: 25, energy: 50,
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
export const BEHEMOTH_SCALE = 3;   // Phase 7: 4 → 3 (the 6.4 m body stumbled on most obstacles while charging)
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

/* ── roll (구르기, replaced the dive; on V since the 2026-09-07 커서 rework moved Alt to the cursor) ── */
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
/** Bumped to 2 in Phase 8: `ShipState.plots` / `nameLocked` and the one-off `furn_repair_bench` grant. */
export const SHIP_STATE_VERSION = 3;   // Phase 9: 3 = `books` / `bookDex` (absent → empty; no data migration)
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

/* ══ appended: Phase 7 — known follow-ups (2026-09-06) ═══════════════════════════════════════════════════ */
/* squad wipe */
/** Result screen after a raid failure returns everyone to the ship by itself after this many seconds. */
export const RAID_FAILED_AUTO_RETURN_S = 12;

/* container search (감정) — owner: inventory */
/** Seconds to reveal one item by rarity, before bulk (`1 + (w·h − 1) × 0.05`) and `derived.searchSpeedMul` (÷). */
export const SEARCH_TIME_BY_RARITY: Readonly<Record<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', number>> = {
  common: 0.35, uncommon: 0.7, rare: 1.3, epic: 2.0, legendary: 3.0,
};
/** Searching only runs while the container window is open and the player is within this many metres of it. */
export const SEARCH_MAX_DISTANCE = 4;

/* training range (시뮬레이션 훈련장) — owner: world */
/** Arena side (m), flat, walled; the player spawns at the south end facing the lanes. */
export const TRAINING_ARENA_SIZE = 64;
/** Pop-up targets: count, hp, seconds to pop back up after a knock-down. */
export const TRAINING_TARGET_COUNT = 12;
export const TRAINING_TARGET_HP = 60;
export const TRAINING_TARGET_RESPAWN_S = 3;
/** Skill XP in a training: only `gun_*` skills rise, scaled by this on top of the 사격장 bonus. */
export const TRAINING_SKILL_GAIN_MUL = 1;

/* rogue AI v2 — owner: enemies */
/** Rounds per magazine (3 bursts of ROGUE_BURST) and the reload pause (no shots, anim hint 12). */
export const ROGUE_MAG_ROUNDS = 12;
export const ROGUE_RELOAD_TIME = 2.0;
/** Cover must actually block the line of sight; candidates are scored by `distance + ROGUE_COVER_FLANK_WEIGHT × (1 − |sin(angle to the target's facing)|)`. */
export const ROGUE_COVER_FLANK_WEIGHT = 10;
/** Grenade toss when the target has been behind cover (no LOS) for this long; cooldown per rogue; fuse / damage / radius. */
export const ROGUE_GRENADE_HOLD_S = 3;
export const ROGUE_GRENADE_COOLDOWN = 12;
export const ROGUE_GRENADE_FUSE = 2.5;
export const ROGUE_GRENADE_DAMAGE = 45;
export const ROGUE_GRENADE_RADIUS = 4.5;
export const ROGUE_GRENADE_RANGE = 28;
/** Seconds the throw pose plays before release (anim hint 13). */
export const ROGUE_GRENADE_WINDUP = 0.6;

/* ghosts — owner: player (host) */
/** Bleed rate of a downed ghost (same as a live player: PLAYER_DOWN_BLEED_PER_SEC), kept here for the host loop. */
export const GHOST_BLEED_PER_SEC = 1;

/* ══ appended: Phase 8 — UI/UX pass (2026-09-06) ═══════════════════════════════════════════════════════════ */

/* ── 온실 재배 (owner: housing rules, hub geometry, items seed data) ── */
/** Plots in one 재배층. */
export const GROW_PLOTS_PER_RACK = 4;
/** How many 재배층 may share one floor footprint (each on its own `PlacedFurniture.layer`). */
export const GROW_RACK_STACK_LIMIT = 4;
/** Vertical spacing (m) between stacked 재배층 layers. */
export const GROW_RACK_LAYER_HEIGHT = 0.8;
/**
 * 원예 skill speeds a *new* planting up by at most this fraction (skill SKILL_LEVEL_MAX → grow time × (1 − this)).
 * Applied once when the seed goes in; `GrowPlot.readyAt` is then fixed so a later skill change never moves the timer.
 */
export const GROW_SKILL_SPEEDUP = 0.35;
/** Real hours a seed needs by its rarity, before `GROW_SKILL_SPEEDUP` (items' `ItemDef.seed.growHours` overrides it). */
export const SEED_GROW_HOURS_BY_RARITY: Readonly<Record<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', number>> = {
  common: 1, uncommon: 2.5, rare: 6, epic: 6, legendary: 6,
};

/* ── audio settings (owner: audio) ── */
/** localStorage key of the volume settings (`AudioSettings`). */
export const AUDIO_STORAGE_KEY = 'scav.audio';
export const AUDIO_DEFAULT_MASTER = 0.8;
export const AUDIO_DEFAULT_SFX = 1;

/* ── ship doors + room lighting (owner: hub) ── */
/** A room / cockpit door slides open when the player is within this many metres of its threshold. */
export const DOOR_OPEN_DISTANCE = 3.2;
/** Door slide speed (fraction of full travel per second). */
export const DOOR_SLIDE_SPEED = 3.0;
/**
 * Real point lights reserved for the rooms. Kept **constant** (toggling `light.visible` recompiles every shader):
 * the pool is created once and re-anchored to the nearest non-empty rooms, with `intensity` ramped instead.
 */
export const ROOM_LIGHT_POOL = 3;
/** Point-light intensity / distance of a lit (non-empty) room. */
export const ROOM_LIGHT_INTENSITY = 11;
export const ROOM_LIGHT_DISTANCE = 7;
/** `emissiveIntensity` of a room's wall strips when the room is empty vs. assigned a purpose. */
export const ROOM_STRIP_DIM = 0.15;
export const ROOM_STRIP_LIT = 2.2;

/* ══ appended: Phase 9 — known follow-ups II (2026-09-06) ═══════════════════════════════════════════════════ */

/* ── jump pad (owner: gadgets) ── */
/** A player who was just launched by a pad cannot be launched by the same pad again for this long (was a 0.7 s per-pad literal). */
export const JUMP_PAD_RETRIGGER_S = 2.5;

/* ── 서재 책장 (owner: housing rules, hub geometry, items book data) ── */
/** Book slots per 책장. */
export const BOOKS_PER_SHELF = 6;
/** Skill-XP multiplier bonus per shelved book, weighted by `BOOK_RARITY_MUL[rarity]`: mul = 1 + BOOK_XP_PER_BOOK × Σ weight. */
export const BOOK_XP_PER_BOOK = 0.05;
export const BOOK_RARITY_MUL: Readonly<Record<'common' | 'uncommon' | 'rare' | 'epic' | 'legendary', number>> = {
  common: 1, uncommon: 1.5, rare: 2.5, epic: 4, legendary: 6,
};
/** Cap of the 서재 multiplier for one skill. */
export const BOOK_GAIN_MAX = 2.0;

/* ── 시뮬레이션 훈련장 target modes (owner: world) ── */
/** 이동 표적: sweep half-width (m, keeps the target inside its lane), speed (m/s) and the pause at each end. */
export const TRAINING_MOVING_SPAN = 3.2;
export const TRAINING_MOVING_SPEED = 2.2;
export const TRAINING_MOVING_PAUSE_S = 0.5;
/** 타임 코스: knock-downs needed, seconds allowed, cooldown before the next course can start. */
export const TRAINING_COURSE_TARGETS = 10;
export const TRAINING_COURSE_TIME_S = 60;
export const TRAINING_COURSE_COOLDOWN_S = 3;
/** localStorage key of the best timed-course time. */
export const TRAINING_BEST_STORAGE_KEY = 'scav.training';

/* ══ appended: Phase 10 — UI 개선 pass (2026-09-07) ═════════════════════════════════════════════════════════ */

/* ── 배리어 = 들고 다니는 방패 (owner: implants; the 7 × 3.2 m deployed panel constants above stay for nothing —
 *    they are superseded by the CARRY_* pair, kept only so an older save / smoke that reads them still compiles) ── */
/** Hand-shield panel size (m). Much smaller than the old deployed wall: it covers the carrier, not a lane. */
export const IMPLANT_BARRIER_CARRY_WIDTH = 1.5;
export const IMPLANT_BARRIER_CARRY_HEIGHT = 1.35;
/**
 * Metres in front of the player axis the panel plane sits. **Must stay > `PLAYER_RADIUS`** or enemy hitscan clamps to
 * the player capsule before the barrier query runs (`enemies/EnemySystem.fireGun`) and the shield never blocks.
 */
export const IMPLANT_BARRIER_CARRY_OFFSET = 0.7;
/** Height of the panel's bottom edge above the feet (`BarrierField.intersect` measures dy from `position.y`). */
export const IMPLANT_BARRIER_CARRY_BASE_Y = 0.55;
/** Movement multiplier while the shield is up (`player.setSpeedModifier('shield', …)`). */
export const IMPLANT_BARRIER_CARRY_SPEED_MUL = 0.78;
/** Half-angle (rad) around the carrier's forward inside which the raised shield blocks; wider shots pass by. */
export const IMPLANT_BARRIER_CARRY_ARC = Math.PI / 2;
/** Shield hp removed per blocked hostile projectile (was the module-local `BARRIER_BLOCK_DAMAGE`). */
export const IMPLANT_BARRIER_BLOCK_DAMAGE = 30;
/** Regen per second while the shield is raised, after `IMPLANT_BARRIER_CARRY_REGEN_DELAY` without a hit. */
export const IMPLANT_BARRIER_CARRY_REGEN = 40;
export const IMPLANT_BARRIER_CARRY_REGEN_DELAY = 3;

/* ── 다각화된 적 사망 + 확률 루팅 (owner: enemies; the chance table is `CORPSE_LOOT_CHANCE` in types.ts) ── */
/** Seconds of `Enemy.deathTimer` over which the fall pose blends in (bugs and rogues). */
export const DEATH_FALL_TIME = 0.9;
/** Terminal speed (m/s) of a body that died in the air and is still falling to the terrain. */
export const CORPSE_FALL_MAX_SPEED = 22;
/** A mid-air kill registers its `corpse:<id>` interactable only once the body lands, or after this long. */
export const CORPSE_LAND_TIMEOUT = 2.5;

/* ── 컨테이너 실시간 동기화 연출 (owner: inventory grid view) ── */
/** Length of the "float up + fade out" a container tile plays when someone else takes it (seconds). */
export const CONTAINER_TAKE_ANIM_S = 0.22;
/** How far the vanishing tile floats up, in grid px, and the scale it ends at. */
export const CONTAINER_TAKE_RISE_PX = 14;
export const CONTAINER_TAKE_END_SCALE = 0.9;

/* ── 루팅 표시 = 빛기둥 (replaces the light-blue fresnel sphere of Detection / ScanReveal) ── */
/** In-range interactable pillar: height (m), bottom / top radius (m), peak opacity at the base. */
export const INTERACT_PILLAR_HEIGHT = 2.6;
export const INTERACT_PILLAR_RADIUS_BOTTOM = 0.3;
export const INTERACT_PILLAR_RADIUS_TOP = 0.1;
export const INTERACT_PILLAR_OPACITY = 0.28;
/** Vertical fraction at which the pillar has faded to nothing (1 = fades exactly at the top). */
export const INTERACT_PILLAR_FADE = 0.85;
/** The scan-reveal (through-wall) pillar is taller so it still reads behind geometry. */
export const SCAN_PILLAR_HEIGHT = 3.6;
/** Per-pickup pillar (replaces the 5.5 m `PickupVisuals.BEAM_HEIGHT` beam). */
export const PICKUP_PILLAR_HEIGHT = 3.2;
export const PICKUP_PILLAR_OPACITY = 0.22;

/* ── 부상자 들쳐메기 (owner: player) ── */
/** Max distance (m) at which an F tap can shoulder a downed squadmate. */
export const PLAYER_CARRY_RANGE = 2.2;
/** Pick-up / put-down animation length (s); the carrier's controls are locked for it. */
export const PLAYER_CARRY_PICKUP_S = 0.7;
export const PLAYER_CARRY_DROP_S = 0.5;
/** Speed multiplier while carrying. Walking and sprinting are allowed; every other action drops the body first. */
export const PLAYER_CARRY_SPEED_MUL = 0.75;
/** Carried body's local offset in the carrier's right-shoulder socket. */
export const PLAYER_CARRY_OFFSET: readonly [number, number, number] = [0.24, 0.02, 0.06];

/* ── 회복약 (was 스팀; the `stim` def id / `ItemCategory 'stim'` / `applyStim` are unchanged) ── */
/**
 * Fallback hold for a 회복 소모품 whose def carries no `heal` block. Since 2026-09-07 every real one states its
 * own `ItemDef.heal.useTime` (붕대 5 s · 약초 붕대 5 s · 회복주사 2 s) and the HUD reads the duration off the event.
 */
export const HEAL_HOLD_S = 2;
/** Taking damage does not cancel the hold (moving never did). Kept as a constant so the HUD mirrors the rule. */
export const HEAL_HOLD_CANCEL_ON_DAMAGE = false;

/* ── appended: 소모품 사용 (2026-09-07) ── */
/** Movement speed multiplier while a consumable is being used / channelled (`PlayerRef.setSpeedModifier`). */
export const CONSUMABLE_SLOW_MUL = 0.5;
/** `setSpeedModifier` key weapons uses for that slow, so nothing else can clash with it. */
export const CONSUMABLE_SLOW_KEY = 'consumable';
/** Seconds LMB must be held with a 제세동기 in hand before the revive fires. */
export const DEFIB_USE_TIME_S = 1;
/** 회복 스프레이: gauge of a fresh can (the instance's `durability`) and the radius its ticks heal in. */
export const HEAL_SPRAY_GAUGE = 100;
export const HEAL_SPRAY_RADIUS = 8;

/* ── 발사 준비 패널 (owner: hub, portraits from player/) ── */
/** Cells in the READY panel. Kept separate from the lobby size so the panel never resizes. */
export const HUB_READY_CELLS = 4;
/** Body yaw of a portrait: turned diagonally toward the camera's right (the soldier model's front is −Z). */
export const HUB_READY_PORTRAIT_YAW = -Math.PI / 4;
/** `ctx.uiBlockers` token the READY panel holds while it is open. */
export const HUB_READY_BLOCKER = 'ready';
/** Debounce for re-broadcasting my own `crew card` (seconds). */
export const CREW_CARD_MIN_INTERVAL_S = 1;
/** Don't answer `crewq loadout` from the same peer more often than this (seconds). */
export const CREW_LOADOUT_COOLDOWN_S = 2;

/* ── 마우스 커서 (owner: shared/cursor.ts + Input; the art is ui/hud/GameCursor) ── */
/*
 * 2026-09-07 rework: the virtual cursor is gone. A cursor screen releases the pointer lock and the **real** OS cursor
 * comes back, restyled as the game's own arrow through a procedurally drawn CSS `cursor:` image — so there is no
 * sensitivity, no sprite position and no synthetic double-click window to tune any more.
 */
/** Side of the drawn cursor image in CSS px (a 2× copy is generated for HiDPI through `image-set`). */
export const GAME_CURSOR_SIZE = 22;
/** `ctx.uiBlockers` token the Alt 커서 (a free cursor with no screen behind it) holds while it is up. */
export const FREE_CURSOR_BLOCKER = 'cursor';

/** How long a denied pointer-lock request keeps waiting for the next real user gesture to retry (ms). */
export const LOCK_GESTURE_RETRY_MS = 10000;

/* ══ appended: Phase 11 — 행성 선택 · 소셜 (2026-09-07) ═════════════════════════════════════════════════════ */

/* ── 행성 이동 (owner: hub; the cutscene is `DockingCutscene` reused as a warp) ── */
/** Seconds of the 행성 이동 cutscene. Shorter than `HUB_DOCKING_DURATION` — it is a hop, not an arrival. */
export const HUB_TRAVEL_DURATION = 4.5;
/** Fraction of the cutscene spent in the streaked-star warp before the destination sphere resolves. */
export const HUB_TRAVEL_WARP_FRACTION = 0.55;
/** How far the warp stretches a star (multiplier on its own length while `HUB_TRAVEL_WARP_FRACTION` runs). */
export const HUB_TRAVEL_WARP_STRETCH = 22;

/* ── 터미널 (owner: hub/ui/HubMenu — full-screen since Phase 11) ── */
/** Side of the square WebGL canvas the planet hologram renders into (device px are scaled by the DPR cap). */
export const PLANET_HOLOGRAM_PX = 360;
/** Idle spin of the hologram sphere (rad/s) and the tilt it is seen at (rad). */
export const PLANET_HOLOGRAM_SPIN = 0.24;
export const PLANET_HOLOGRAM_TILT = 0.28;
/** Seconds the hologram takes to swap planets when the player steps left / right. */
export const PLANET_SWAP_TIME = 0.35;

/* ── 소셜 UI (owner: ui) ── */
/** `ctx.uiBlockers` token the ship's 커뮤니티 panel holds while open (the ESC screen is inside the `'menu'` token). */
export const COMMUNITY_BLOCKER = 'community';
/** Profile cards per row in the 친구 / 최근 플레이어 lists (the spec's 가로 2개씩). */
export const SOCIAL_CARDS_PER_ROW = 2;
/** Rows the 친구 list and the 최근 플레이어 list show before they scroll (2 × 3.5 and 2 × 5.5 in the spec). */
export const SOCIAL_FRIEND_ROWS = 3.5;
export const SOCIAL_RECENT_ROWS = 5.5;
/** Squad voice sliders are UI-only in Phase 11 (no voice chat yet); this is their stored default. */
export const SQUAD_VOICE_DEFAULT = 1;

/* ── ESC = 항상 일시정지 (2026-09-08) ── */
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
export const COMMUNITY_TAP_MAX_S = 0.3;
