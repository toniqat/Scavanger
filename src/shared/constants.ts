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

/** Keyboard bindings (KeyboardEvent.code). */
export const Keys = {
  FORWARD: 'KeyW', BACK: 'KeyS', LEFT: 'KeyA', RIGHT: 'KeyD',
  SPRINT: 'ShiftLeft', JUMP: 'Space',
  /** C toggles crouch, Z toggles prone, Alt dives (ends prone). */
  CROUCH: 'KeyC', PRONE: 'KeyZ', DIVE: 'AltLeft',
  RELOAD: 'KeyR', INTERACT: 'KeyE',
  /** Direct stim key. Moved off F (2026-09-05) — F is the melee attack. */
  STIM: 'KeyH', GRENADE: 'KeyG',
  PRIMARY: 'Digit1', SECONDARY: 'Digit2',
  /** Weapon quick-swap. Moved off Q (2026-09-05) — Q now activates the tactical implant. */
  SWAP: 'KeyV',
  INVENTORY: 'Tab', ROTATE_ITEM: 'KeyR', MENU: 'Escape', MAP: 'KeyM',
  /* appended: X drops the hovered/selected inventory item; Enter opens text chat. */
  DROP_ITEM: 'KeyX', CHAT: 'Enter',
} as const;

/** Mouse buttons (MouseEvent.button). */
export const MouseButtons = { FIRE: 0, PING: 1, AIM: 2 } as const;

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

/* ── appended: tactical kit (implants, gadgets, melee, gear, progression) ── */
/** Q activates / wields the equipped tactical implant. */
export const KEY_IMPLANT = 'KeyQ';
/** F swings the equipped weapon as a melee attack. */
export const KEY_MELEE = 'KeyF';
/** Alt rolls (replaces the old dive). `Keys.DIVE` keeps the same physical key. */
export const KEY_ROLL = 'AltLeft';
/** Quick-use bar keys; the first `BackpackDef.quickSlots` of these are live. */
export const QUICK_SLOT_KEYS: readonly string[] = [
  'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
];
/** Hold RMB while a throwable is selected to switch over/under-hand (same gesture as grenades). */
export const KEY_THROW_MODE = 'KeyB';

/* ── melee ── */
export const MELEE_DAMAGE = 45;
export const MELEE_RANGE = 2.4;
export const MELEE_STAMINA_COST = 12;
export const MELEE_COOLDOWN = 0.75;
/** Weapons whose stock adds melee damage list a multiplier; this is the default for everything else. */
export const MELEE_STOCK_MUL_DEFAULT = 1;

/* ── roll (구르기, replaces dive) ── */
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
export const IMPLANT_OVERCHARGE_RANGE = 22;
export const IMPLANT_OVERCHARGE_HEAL_PER_SEC = 45;
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
/** Seconds a downed player has before bleeding out (multiplayer only). */
export const DOWNED_BLEEDOUT = 45;

/* ── stealth / cloak ── */
/** Enemy detection range is multiplied by this while the target is cloaked and behaving. */
export const CLOAK_DETECT_MUL = 0.18;
/** Cloak breaks for this long after firing / sprinting / rolling near an alerted enemy. */
export const CLOAK_BREAK_TIME = 3;
/** Distance (m) at which an alerted enemy sees a cloaked target regardless. */
export const CLOAK_REVEAL_DISTANCE = 4;

/* ── armor / durability ── */
/** Damage reduction of numbered armor I..V. */
export const ARMOR_DR_BY_TIER: readonly number[] = [0, 0.06, 0.12, 0.18, 0.24, 0.30];
/** Armor durability lost per point of damage absorbed. */
export const ARMOR_DURABILITY_PER_DAMAGE = 0.35;
/** Backpack durability lost per point of damage taken. */
export const BACKPACK_DURABILITY_PER_DAMAGE = 0.12;
/** Weapon durability lost per shot (before the 장비 관리 multiplier). */
export const WEAPON_DURABILITY_PER_SHOT = 0.6;
/** Fire-rate multiplier once a weapon is broken (durability 0). */
export const BROKEN_WEAPON_FIRERATE_MUL = 0.5;

/* ── gathering / crafting ── */
export const GATHER_NODES_PER_MISSION = 34;
export const GATHER_INTERACT_TIME = 2;
export const CRAFT_DEFAULT_TIME = 3;

/* ── progression ── */
export const STAT_BASE = 5;
export const STAT_MAX = 20;
export const STAT_POINTS_PER_LEVEL = 2;
export const SKILL_LEVEL_MAX = 100;
export const PROFILE_STORAGE_KEY = 'scav.profile';
export const PROFILE_VERSION = 1;
/** XP needed to reach level n+1: XP_BASE * n^XP_EXPONENT. */
export const XP_BASE = 240;
export const XP_EXPONENT = 1.35;
