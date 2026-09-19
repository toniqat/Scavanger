/**
 * Global gameplay constants shared by every module. Do not duplicate these elsewhere.
 *
 * **The numbers are not here.** Every scalar value lives in `data/constants.csv` and this file only reads that table
 * by name (`K.num('MAP_SIZE')`). Tuning a value means editing the csv alone; the name, the comment and the type are
 * still owned here. Adding a constant = a row in the csv plus one `export const X = K.num('X');` line here.
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
     2026-09-10: it was removed — the field stays because it is a contract and nobody reads it (as with `SECONDARY`). */
  CURSOR: string;
  /* appended (2026-09-09): hold H = the comms wheel. A tap does nothing (the slot STIM left free when it retired). */
  COMMS: string;
  /* appended (2026-09-12): shoulder swap — moves the third-person camera onto the left / right shoulder (owner: player/CameraRig). */
  SHOULDER: string;
  /* appended (2026-09-17): fold / unfold the tutorial raid's right-hand control guide (owner: tutorial — read only in the last raid of `증축 안내`). */
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
     2026-09-10: the Alt cursor is gone — the value stays but is absent from `KEY_ACTION_DEFS`, so it binds nowhere. */
  CURSOR: 'AltLeft',
  /* 2026-09-09: the comms wheel. Uses the same H as the retired STIM — that key was bound to nothing. */
  COMMS: 'KeyH',
  /* 2026-09-12: shoulder swap. X is also used by the inventory (DROP_ITEM) and ship management (recover), but those two are cursor screens, so the scopes do not overlap. */
  SHOULDER: 'KeyX',
  /* 2026-09-17: `]` = hide / show the tutorial control guide. The `]` of ship-management mode (paging furniture, a fixed key — `hub/HousingMode`) is a cursor screen, so the scopes do not overlap. */
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
/** 2026-09-15: `'grenade'` was retired — both grenades are `category: 'gadget'` too, so this list still covers them. */
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
 * G-12 high-explosive grenade: radius (m) · damage at the centre · the player's share (2026-09-15, user's decision —
 * radius 6 → 7.2 = ×1.2). Until 2026-09-15 these three numbers sat in `weapons/Grenade.ts`; the same names still go
 * out through the `@/weapons` barrel. Falloff is the two-step curve of `shared/explosion.ts` — widening the radius
 * grows the 「100 % up close」 band with it.
 */
export const GRENADE_RADIUS = K.num('GRENADE_RADIUS');
export const GRENADE_DAMAGE = K.num('GRENADE_DAMAGE');
/** The share of a grenade blast a player takes (the same for my own and for a squadmate's replica). Not applied to enemies or drones. */
export const GRENADE_PLAYER_DAMAGE_MUL = K.num('GRENADE_PLAYER_DAMAGE_MUL');
/**
 * **The two-step explosion falloff** (2026-09-15, user's decision) — the formula lives in `shared/explosion.ts` alone.
 * `0 … FULL_FRACTION × radius` = 100 %, from there to `radius` = `OUTER_MUL` (flat, distance-independent), beyond = 0.
 */
export const EXPLOSION_FULL_FRACTION = K.num('EXPLOSION_FULL_FRACTION');
export const EXPLOSION_OUTER_MUL = K.num('EXPLOSION_OUTER_MUL');
/** 2026-09-18 (user's decision): blast / melee occlusion — the 3 body-point heights, the blast-centre lift, the end-point slack. The judgement is in `shared/explosion.ts`. */
export const BLAST_LOS_FEET_M = K.num('BLAST_LOS_FEET_M');
export const BLAST_LOS_CHEST_FRAC = K.num('BLAST_LOS_CHEST_FRAC');
export const BLAST_LOS_HEAD_FRAC = K.num('BLAST_LOS_HEAD_FRAC');
export const BLAST_LOS_LIFT_M = K.num('BLAST_LOS_LIFT_M');
export const BLAST_LOS_SLACK_M = K.num('BLAST_LOS_SLACK_M');
export const MELEE_LOS_SLACK_M = K.num('MELEE_LOS_SLACK_M');
/** Throw range multiplier (2026-09-09): linear from THROW_RANGE_MUL_MIN at STAT_MIN `근력` to THROW_RANGE_MUL_MAX at STAT_MAX. */
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
 * What the G wheel shows and in what order — the **four compass points are fixed** (N/E/S/W), so there are exactly 4.
 * 2026-09-09: `airstrike` came off the wheel and `rescue_drop` went on. The airstrike's definition (its csv row) and
 * its implementation (`stratagems/parts/Calls`) remain but are armed nowhere — the contract is not deleted, only the list changes.
 */
export const STRATAGEM_ORDER: readonly StratagemId[] = ['orbital_laser', 'supply_drop', 'structure_drop', 'rescue_drop'];
/** Calls only **the host** may arm in multiplayer. Anyone may use the rest. */
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
/** Airstrike: explosion radius (m) and damage at the centre (falloff = the two-step curve of `shared/explosion`). */
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
/* appended (2026-09-16): removing an empty corpse (owner: game/Corpses · enemies/parts/CorpseEmpty · world/tutorial/parts/Corpses) */
/** Seconds between a corpse running out of items and the moment it starts to sink. Enemy corpses only when they were **opened and emptied**. */
export const CORPSE_EMPTY_REMOVE_DELAY_S = K.num('CORPSE_EMPTY_REMOVE_DELAY_S');
/** Seconds an empty corpse takes to sink into the ground. At the end the interactable, the light pillar and the mesh all go. */
export const CORPSE_EMPTY_SINK_S = K.num('CORPSE_EMPTY_SINK_S');
/** How deep (m) a player / android / tutorial corpse sinks. The enemy rig uses its own corpse sink depth (`anim.fade`). */
export const CORPSE_EMPTY_SINK_DEPTH_M = K.num('CORPSE_EMPTY_SINK_DEPTH_M');
/** Host guard: max horizontal distance (m) between the enemy corpse and the snapshot of whoever sent `ecorpseq emptied`. */
export const CORPSE_EMPTY_REQUEST_REACH_M = K.num('CORPSE_EMPTY_REQUEST_REACH_M');
/** Host guard: empty-enemy-corpse requests one person may send per second, and the bucket size. */
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
/** 2026-09-10: the effective gravity used for shell arcs only — not the real `GRAVITY` (`shared/ballistics`). */
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
export const WEIGHT_LIGHT_RATIO = K.num('WEIGHT_LIGHT_RATIO');         // `조금 무거움`
export const WEIGHT_HEAVY_RATIO = K.num('WEIGHT_HEAVY_RATIO');         // `무거움`
export const WEIGHT_OVER_RATIO = K.num('WEIGHT_OVER_RATIO');          // `과적`
export const WEIGHT_LIGHT_STAMINA_MUL = K.num('WEIGHT_LIGHT_STAMINA_MUL');   // -30 % stamina regen
export const WEIGHT_HEAVY_STAMINA_MUL = K.num('WEIGHT_HEAVY_STAMINA_MUL');   // -50 % stamina regen
export const WEIGHT_HEAVY_MOVE_MUL = K.num('WEIGHT_HEAVY_MOVE_MUL');
export const WEIGHT_STATE_LABEL_KO: Record<string, string> = {
  normal: '보통', light: '조금 무거움', heavy: '무거움', over: '과적',
};

/* ── detection (the detection system) ── */
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
 * 2026-09-14 (owner: implants/parts/Devices.castDash) a dash does not cut the way ahead with a single ray; it pushes
 * the body forward like walking — one step of `SWEEP_STEP` m, blocked when the progress after the push is under
 * `SLIDE_MIN` of a step, blocked when the terrain rises steeper than `MAX_SLOPE_DEG`.
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
/* ── appended: 2026-09-15 (gadget rework · defibrillator aiming · toxic spores, user's decision) ── */
/** Crosshair half-angle (°) inside which a charged defibrillator counts as 「aimed at」 a downed ally — the basis of `gadget:defibAim.target`. */
export const DEFIB_AIM_CONE_DEG = K.num('DEFIB_AIM_CONE_DEG');
/** Seconds of holding the dome shield's centre object to recover it. */
export const GADGET_DOME_RECOVER_TIME = K.num('GADGET_DOME_RECOVER_TIME');
/** 1 = toxic-spore hazard damage skips the shield (`opts.bypassShield` of `PlayerRef.takeDamage`). */
export const HAZARD_SPORES_BYPASS_SHIELD = K.num('HAZARD_SPORES_BYPASS_SHIELD') > 0;
/* 2026-09-15 2nd pass (fire merged into one, user's decision): `GADGET_INCENDIARY_RADIUS`(5) · `GADGET_INCENDIARY_DURATION`(10)
   retired — with one definition left that makes a fire zone, the numbers that survived are `GRENADE_INCENDIARY_*`(3.5 m · 6 s).
   The per-second damage `GADGET_INCENDIARY_DPS` is used unchanged (it is the whole zone's value, so the merge does not touch it). */
export const GADGET_INCENDIARY_DPS = K.num('GADGET_INCENDIARY_DPS');
export const GADGET_JUMPPAD_IMPULSE = K.num('GADGET_JUMPPAD_IMPULSE');
export const GADGET_JUMPPAD_FORWARD = K.num('GADGET_JUMPPAD_FORWARD');
/** Hold time (s) to defuse a mine / recover a turret, jump pad or barricade. */
export const GADGET_DEFUSE_TIME = K.num('GADGET_DEFUSE_TIME');
/* 2026-09-09: the six below were literals sitting inside `gadgets/GadgetDefs.ts` — moved into the csv. */
/** Radius (m) a barricade occupies. */
export const GADGET_BARRICADE_RADIUS = K.num('GADGET_BARRICADE_RADIUS');
/** Durability of the lure-grenade beacon / mine / jump pad (shooting them breaks them). */
export const GADGET_LURE_HP = K.num('GADGET_LURE_HP');
export const GADGET_MINE_HP = K.num('GADGET_MINE_HP');
export const GADGET_JUMPPAD_HP = K.num('GADGET_JUMPPAD_HP');
/** Defibrillator reach (m) and jump-pad trigger radius (m). */
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
 * appended (2026-09-16, owner: game): kill-XP multiplier of a raid that was not extracted from. Raid XP = Σ the killed
 * type's `enemies.csv` raidXp (`MissionStats.killXp`) × (extracted ? 1 : XP_DEATH_MUL) × the library multiplier —
 * `game/parts/Death.awardMissionXp`.
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
/** Retired 2026-09-14 — the bazooka does no self damage. Nothing reads it and only the contract export stays (old meaning: flat self damage inside the blast radius). */
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
 * Greenhouse rework (2026-09-11): **4** = `grows` (growing-station slots). A v3 save loses its `재배층` — every
 * `furn_grow_rack`, placed or stored, is refunded as materials into the ship stash and its `plots` are dropped
 * (user's decision: throw the old one away).
 * Lab (2026-09-11): **5** = `analyses` / `sampleDex` (the analyzer). Absent → migrated as empty; no data is lost.
 * Culture tank (2026-09-11, A-14): **6** = `cultures`. v5 → v6 only adds fields that did not exist, so there is no refund path.
 * Room facility levels removed (2026-09-12): **7** — the shape is the same. `RoomState.level` is always 1, and the
 * workshop / range levels of a v6-or-older save move onto the locker / simulation-hub levels or are refunded as materials
 * (`housing/ShipState.sanitize`, exactly once).
 */
export const SHIP_STATE_VERSION = 12;  // 2026-09-12: 9 = library media (`media` · `mediaDex` · `toggled`, A-3e) · 2026-09-13: 10 = cockpit-only facilities + cockpit decoration furniture (the shape is the same — bumped only so the move happens once) · 11 = cooking material tiers (soil · medium durability and sockets · culture scaffold · analysis results · family XP · the analysis catalogue) · 2026-09-16: 12 = sample rework · processors mounted directly (`sampleLevels` · `ComputeClusterSlot.processors` — no migration, by the user's decision: sample levels start from 0, and an old `cores` reads as a processor at the new durability)
export const SHIP_ROOM_COUNT = K.num('SHIP_ROOM_COUNT');
/** Room floor grid (cells) and cell size (m): 8 × 8 × 0.5 = a 4 × 4 m room. */
export const ROOM_GRID_COLS = K.num('ROOM_GRID_COLS');
export const ROOM_GRID_ROWS = K.num('ROOM_GRID_ROWS');
export const HOUSING_CELL_SIZE = K.num('HOUSING_CELL_SIZE');
export const GENERATOR_MAX_LEVEL = K.num('GENERATOR_MAX_LEVEL');
/** appended (2026-09-13 — power allocation abolished): a new ship's generator level (it runs from the start; an old Lv.0 save is raised to this). */
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

/* ── greenhouse growing (owner: housing rules, hub geometry, items seed data) ── */
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

/* ── greenhouse rework — soil affinity (2026-09-11, owner: housing rules, items soil data) ── */
/**
 * When the seed's `soilTag` and the tag of the poured soil are **the same**, the grow time drops by this fraction.
 * When they differ it grows by `SOIL_MISMATCH_PENALTY` instead — nothing is ever planted without soil (the slot has to
 * be filled first), so these two are the baseline. Fixed into `GrowSlot.readyAt` at planting and never moved after.
 */
export const SOIL_MATCH_SPEEDUP = K.num('SOIL_MATCH_SPEEDUP');
/** The fraction the grow time grows by when planted in soil that does not match. */
export const SOIL_MISMATCH_PENALTY = K.num('SOIL_MISMATCH_PENALTY');
/** Harvests one pour of soil survives — a rarity curve (`ItemDef.soil.uses` is the real value). */
export const SOIL_USES_BY_RARITY: Readonly<Record<Rarity, number>> =
  numberMap<Rarity>('tables.csv', 'SOIL_USES_BY_RARITY');

/* ── audio settings (owner: audio) ── */
/** localStorage key of the volume settings (`AudioSettings`). */
export const AUDIO_STORAGE_KEY = 'scav.audio';
export const AUDIO_DEFAULT_MASTER = K.num('AUDIO_DEFAULT_MASTER');
export const AUDIO_DEFAULT_SFX = K.num('AUDIO_DEFAULT_SFX');
/** appended (2026-09-14): default volume of the BGM channel. It makes no sound today; the music player window's volume readout reads this channel. */
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

/* ── library bookshelf (owner: housing rules, hub geometry, items book data) ── */
/** Book slots per 책장. */
export const BOOKS_PER_SHELF = K.num('BOOKS_PER_SHELF');
/** Skill-XP multiplier bonus per shelved book, weighted by `BOOK_RARITY_MUL[rarity]`: mul = 1 + BOOK_XP_PER_BOOK × Σ weight. */
export const BOOK_XP_PER_BOOK = K.num('BOOK_XP_PER_BOOK');
export const BOOK_RARITY_MUL: Readonly<Record<Rarity, number>> =
  numberMap<Rarity>('tables.csv', 'BOOK_RARITY_MUL');
/** Cap of the 서재 multiplier for one skill. */
export const BOOK_GAIN_MAX = K.num('BOOK_GAIN_MAX');

/* ── appended (2026-09-12): library media — discs · records · auxiliary furniture (A-3e; owner: housing rules, hub geometry, items data) ── */
/** Slots of one disc stand / record rack (a bookshelf uses `BOOKS_PER_SHELF`). */
export const DISC_SLOTS_PER_STAND = K.num('DISC_SLOTS_PER_STAND');
export const RECORD_SLOTS_PER_RACK = K.num('RECORD_SLOTS_PER_RACK');
/** What one item adds to that skill's share (× `BOOK_RARITY_MUL[rarity]`) — the same place as a book's `BOOK_XP_PER_BOOK`. */
export const DISC_XP_PER_ITEM = K.num('DISC_XP_PER_ITEM');
export const RECORD_XP_PER_ITEM = K.num('RECORD_XP_PER_ITEM');
/** Cap of each medium's share (`1 + share ≤ this`) — the same place as a book's `BOOK_GAIN_MAX`. The three shares are capped separately, then added. */
export const DISC_GAIN_MAX = K.num('DISC_GAIN_MAX');
export const RECORD_GAIN_MAX = K.num('RECORD_GAIN_MAX');
/** With the auxiliary furniture placed, that medium's share × (1 + this) — rocking chair (books) · TV (discs) · gramophone · jukebox · turntable (records, only one of the three). */
export const SHELF_AUX_BONUS_BOOK = K.num('SHELF_AUX_BONUS_BOOK');
export const SHELF_AUX_BONUS_DISC = K.num('SHELF_AUX_BONUS_DISC');
export const SHELF_AUX_BONUS_RECORD = K.num('SHELF_AUX_BONUS_RECORD');

/* ── appended (2026-09-12): the gym (A-3a; owner: progression rules, housing minigames, hub geometry) ── */
/** XP a perfect workout / game session (score 1) puts into the stat XP bar — the real value = round(GYM_SESSION_XP × score). 2026-09-17: in stat-XP units. */
export const GYM_SESSION_XP = K.num('GYM_SESSION_XP');
/** Retired (2026-09-17, no code reads it — `src/shared` is add-only): the XP the old training-only bar needed. */
export const GYM_TRAIN_XP_BASE = K.num('GYM_TRAIN_XP_BASE');
export const GYM_TRAIN_XP_EXPONENT = K.num('GYM_TRAIN_XP_EXPONENT');
/** Cap of the training bonus one stat can gain from working out. */
export const GYM_TRAINED_MAX = K.num('GYM_TRAINED_MAX');
/** Real-world hours of the debuff (`근육통` · `심폐 피로`) that lands on that stat after a workout. */
export const GYM_FATIGUE_HOURS = K.num('GYM_FATIGUE_HOURS');
/** Gain multiplier of working the same stat while the debuff is up — 0 = −100 %. */
export const GYM_FATIGUE_GAIN_MUL = K.num('GYM_FATIGUE_GAIN_MUL');
/** Lead-in beats of the rhythm games (breathing run · cycling) — input is ignored while the first marker walks to the judgement line. */
export const GYM_LEAD_BEATS = K.num('GYM_LEAD_BEATS');
/** What one judgement puts into the session score (the average of the judgements) — perfect · good (a miss is 0). */
export const GYM_SCORE_PERFECT = K.num('GYM_SCORE_PERFECT');
export const GYM_SCORE_GOOD = K.num('GYM_SCORE_GOOD');
/** Bench press (bench rack · Smith machine): number of judgements, cursor speed (bar widths/s) and the speed added each rep, half-width of the good / perfect zones (as a fraction of the bar width). */
export const GYM_PRESS_REPS = K.num('GYM_PRESS_REPS');
export const GYM_PRESS_SPEED = K.num('GYM_PRESS_SPEED');
export const GYM_PRESS_SPEED_STEP = K.num('GYM_PRESS_SPEED_STEP');
export const GYM_PRESS_ZONE = K.num('GYM_PRESS_ZONE');
export const GYM_PRESS_PERFECT = K.num('GYM_PRESS_PERFECT');
/** Breathing (treadmill): number of 후-후-하 groups, beat interval (s), length of the 「하」 (s), tap judgement window (±s), judgement window for releasing the 「하」 (±s). */
export const GYM_BREATH_CYCLES = K.num('GYM_BREATH_CYCLES');
export const GYM_BREATH_BEAT_S = K.num('GYM_BREATH_BEAT_S');
export const GYM_BREATH_HOLD_S = K.num('GYM_BREATH_HOLD_S');
export const GYM_BREATH_WINDOW_S = K.num('GYM_BREATH_WINDOW_S');
export const GYM_BREATH_HOLD_TOL_S = K.num('GYM_BREATH_HOLD_TOL_S');
/** Cycling: how many times A · D are pressed alternately, beat interval (s), judgement window (±s). */
export const GYM_CYCLE_STROKES = K.num('GYM_CYCLE_STROKES');
export const GYM_CYCLE_BEAT_S = K.num('GYM_CYCLE_BEAT_S');
/** appended (2026-09-14): half-width of the 「good」 band = the perfect band (= the judgement window) × this. The pair of the rule that perfect = the marker size drawn on screen. */
export const GYM_GOOD_OF_PERFECT = K.num('GYM_GOOD_OF_PERFECT');
export const GYM_CYCLE_WINDOW_S = K.num('GYM_CYCLE_WINDOW_S');

/* ── appended (2026-09-12): character buffs (owner: the player's list, the net wire, the ui thumbnails) ── */
/** Max entries one character's buff list may carry on the wire — the receiving `sanitizeCharBuffs` drops the overflow. */
export const CHAR_BUFF_WIRE_MAX = K.num('CHAR_BUFF_WIRE_MAX');
/** Seconds to wait before asking the same person again after a `cbufq sync` sent because the snapshot's `bfr` revision differed. The answering side blocks per requester for just as long. */
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

/* ── the barrier = a carried shield (owner: implants; the 7 × 3.2 m deployed panel constants above stay for nothing —
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

/* ── varied enemy deaths + probabilistic looting (owner: enemies; the chance table is `CORPSE_LOOT_CHANCE` in types.ts) ── */
/** Seconds of `Enemy.deathTimer` over which the fall pose blends in (bugs and rogues). */
export const DEATH_FALL_TIME = K.num('DEATH_FALL_TIME');
/** Terminal speed (m/s) of a body that died in the air and is still falling to the terrain. */
export const CORPSE_FALL_MAX_SPEED = K.num('CORPSE_FALL_MAX_SPEED');
/** A mid-air kill registers its `corpse:<id>` interactable only once the body lands, or after this long. */
export const CORPSE_LAND_TIMEOUT = K.num('CORPSE_LAND_TIMEOUT');

/* ── live container sync presentation (owner: inventory grid view) ── */
/** Length of the "float up + fade out" a container tile plays when someone else takes it (seconds). */
export const CONTAINER_TAKE_ANIM_S = K.num('CONTAINER_TAKE_ANIM_S');
/** How far the vanishing tile floats up, in grid px, and the scale it ends at. */
export const CONTAINER_TAKE_RISE_PX = K.num('CONTAINER_TAKE_RISE_PX');
export const CONTAINER_TAKE_END_SCALE = K.num('CONTAINER_TAKE_END_SCALE');

/* ── the loot marker = a light pillar (replaces the light-blue fresnel sphere of Detection / ScanReveal) ── */
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

/* ── shouldering a wounded squadmate (owner: player) ── */
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

/* ── `회복약` (was `스팀`; the `stim` def id / `ItemCategory 'stim'` / `applyStim` are unchanged) ── */
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

/* ── the launch READY panel (owner: hub, portraits from player/) ── */
/** Cells in the READY panel. Kept separate from the lobby size so the panel never resizes. */
export const HUB_READY_CELLS = K.num('HUB_READY_CELLS');
/**
 * Body yaw of a portrait (rad). The soldier model's front is −Z, so yaw θ points the body at
 * `(−sin θ, 0, −cos θ)`; the portrait camera sits on +Z. 2026-09-14: the value moved to `data/constants.csv`
 * (「numbers are not written in code」) and became −3π/4 — a 3/4 view facing the camera, turned toward the right of the screen.
 */
export const HUB_READY_PORTRAIT_YAW = K.num('HUB_READY_PORTRAIT_YAW');
/** `ctx.uiBlockers` token the READY panel holds while it is open. */
export const HUB_READY_BLOCKER = 'ready';
/** Debounce for re-broadcasting my own `crew card` (seconds). */
export const CREW_CARD_MIN_INTERVAL_S = K.num('CREW_CARD_MIN_INTERVAL_S');
/** Don't answer `crewq loadout` from the same peer more often than this (seconds). */
export const CREW_LOADOUT_COOLDOWN_S = K.num('CREW_LOADOUT_COOLDOWN_S');

/* ── the mouse cursor (owner: shared/cursor.ts + Input; the art is ui/hud/GameCursor) ── */
/*
 * 2026-09-07 rework: the virtual cursor is gone. A cursor screen releases the pointer lock and the **real** OS cursor
 * comes back, restyled as the game's own arrow through a procedurally drawn CSS `cursor:` image — so there is no
 * sensitivity, no sprite position and no synthetic double-click window to tune any more.
 */
/** Side of the drawn cursor image in CSS px (a 2× copy is generated for HiDPI through `image-set`). */
export const GAME_CURSOR_SIZE = K.num('GAME_CURSOR_SIZE');
/**
 * `ctx.uiBlockers` token the Alt cursor (a free cursor with no screen behind it) held while it was up.
 * 2026-09-10: that feature was removed and nobody uses this token — it is a contract, so only the export stays.
 */
export const FREE_CURSOR_BLOCKER = 'cursor';

/** How long a denied pointer-lock request keeps waiting for the next real user gesture to retry (ms). */
export const LOCK_GESTURE_RETRY_MS = K.num('LOCK_GESTURE_RETRY_MS');
export const LOCK_BOUNCE_GRACE_MS = K.num('LOCK_BOUNCE_GRACE_MS');
/** Milliseconds to wait after Escape is released before requesting the pointer lock again — `Input`'s deferred relock. */
export const LOCK_ESCAPE_DEFER_MS = K.num('LOCK_ESCAPE_DEFER_MS');
/** Cooldown (ms) during which Chromium refuses a re-request after the user released the lock with Escape. */
export const LOCK_USER_EXIT_COOLDOWN_MS = K.num('LOCK_USER_EXIT_COOLDOWN_MS');
/** Max times a pointer-lock request refused for timing reasons is re-sent by itself. */
export const LOCK_RELOCK_RETRIES = K.num('LOCK_RELOCK_RETRIES');

/* ══ appended: Phase 11 — planet selection · social (2026-09-07) ═════════════════════════════════════════════════════ */

/* ── planet travel (owner: hub; 2026-09-09: an in-ship window warp — `interiors/WarpStreaks.ViewportWarp` — not a cutscene) ── */
/** Seconds of the planet-travel warp (ramp up → cruise → ramp down). Shorter than `HUB_DOCKING_DURATION` — a hop, not an arrival. */
export const HUB_TRAVEL_DURATION = K.num('HUB_TRAVEL_DURATION');
/** How far the warp stretches a star (multiplier on its own length at full `hub:warpProgress.speed`). */
export const HUB_TRAVEL_WARP_STRETCH = K.num('HUB_TRAVEL_WARP_STRETCH');
/* 2026-09-09 window warp: the trip is watched from inside the ship (no cutscene, controls stay on). */
/** Seconds the warp takes to ramp up at the start and down at the end (`hub:warpProgress.speed` 0→1 / 1→0). */
export const HUB_WARP_RAMP_S = K.num('HUB_WARP_RAMP_S');
/** `camera:shake` intensity at full warp speed (fed every `HUB_WARP_SHAKE_INTERVAL_S`, scaled by `speed`). */
export const HUB_WARP_SHAKE_PEAK = K.num('HUB_WARP_SHAKE_PEAK');
/** Seconds between hull-shake pulses while the warp runs. */
export const HUB_WARP_SHAKE_INTERVAL_S = K.num('HUB_WARP_SHAKE_INTERVAL_S');

/* ── the terminal (owner: hub/ui/HubMenu — full-screen since Phase 11) ── */
/** Side of the square WebGL canvas the planet hologram renders into (device px are scaled by the DPR cap). */
export const PLANET_HOLOGRAM_PX = K.num('PLANET_HOLOGRAM_PX');
/** Idle spin of the hologram sphere (rad/s) and the tilt it is seen at (rad). */
export const PLANET_HOLOGRAM_SPIN = K.num('PLANET_HOLOGRAM_SPIN');
export const PLANET_HOLOGRAM_TILT = K.num('PLANET_HOLOGRAM_TILT');
/** Seconds the hologram takes to swap planets when the player steps left / right. */
export const PLANET_SWAP_TIME = K.num('PLANET_SWAP_TIME');

/* ── social UI (owner: ui) ── */
/** `ctx.uiBlockers` token the ship's 커뮤니티 panel holds while open (the ESC screen is inside the `'menu'` token). */
export const COMMUNITY_BLOCKER = 'community';
/** Profile cards per row in the 친구 / 최근 플레이어 lists (the spec's 가로 2개씩). */
export const SOCIAL_CARDS_PER_ROW = K.num('SOCIAL_CARDS_PER_ROW');
/** Rows the 친구 list and the 최근 플레이어 list show before they scroll (2 × 3.5 and 2 × 5.5 in the spec). */
export const SOCIAL_FRIEND_ROWS = K.num('SOCIAL_FRIEND_ROWS');
export const SOCIAL_RECENT_ROWS = K.num('SOCIAL_RECENT_ROWS');
/** Squad voice sliders are UI-only in Phase 11 (no voice chat yet); this is their stored default. */
export const SQUAD_VOICE_DEFAULT = K.num('SQUAD_VOICE_DEFAULT');


/* ══ appended: 2026-09-08 batch — implant items · barrier rework · recon rework · bullet tracking · shield bash ══════ */

/* ── implant (stat-equipment item) slots (owner: progression) ── */
export const IMPLANT_SLOTS_BASE = K.num('IMPLANT_SLOTS_BASE');
/** +1 slot per this many character levels. */
export const IMPLANT_SLOTS_PER_LEVELS = K.num('IMPLANT_SLOTS_PER_LEVELS');
export const IMPLANT_SLOTS_MAX = K.num('IMPLANT_SLOTS_MAX');

/* ── the shield bash (owner: implants) ── */
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

/* ── recon rework (owner: implants) — one wide instant pulse ── */
/** Radius of the single pulse, metres. */
export const IMPLANT_SCAN_RADIUS = K.num('IMPLANT_SCAN_RADIUS');
/** Seconds the reveal lasts (self + squad). Replaces `IMPLANT_SCAN_REVEAL_TIME` (10) for the new implant. */
export const IMPLANT_SCAN_REVEAL_TIME_V2 = K.num('IMPLANT_SCAN_REVEAL_TIME_V2');
export const IMPLANT_SCAN_COOLDOWN_V2 = K.num('IMPLANT_SCAN_COOLDOWN_V2');

/* ── bullet tracking (owner: enemies) ── */
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

/* ── compass enemy marks (owner: ui) ── */
/** Compass tick colour for enemies inside `derived.enemyDetectRadius` / a 정찰 reveal. */
export const COMPASS_ENEMY_COLOR = '#ff4d4d';

/* ── the browser resume gate (owner: game) ── */
/** `ctx.uiBlockers` token the '좌측 클릭으로 게임 재개' gate holds (browser only, never in the Electron shell). */
export const RESUME_GATE_BLOCKER = 'resumegate';
/* ── the pause menu token (2026-09-08; the ESC close rule is 2026-09-09) ── */
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

/* ── the shared ship's hangar (2026-09-08, owner: hub) ─────────────────────── */
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

/* ── character slots · creation (2026-09-09, owner: shared/saveSlot · shared/character) ── */
/** Slots in the title screen's character selection. Every slot's save is fully separate (`scav.s<n>.*`). */
/** Tutorial (2026-09-09): delay before the spotlight / guide of a new step appears, and the dim fade-in. */
export const TUTORIAL_STEP_DELAY_S = K.num('TUTORIAL_STEP_DELAY_S');
export const TUTORIAL_DIM_FADE_S = K.num('TUTORIAL_DIM_FADE_S');
export const CHARACTER_SLOTS = K.num('CHARACTER_SLOTS');
/** Minimum one stat may have in the character creation window. */
export const CHAR_STAT_MIN = K.num('CHAR_STAT_MIN');
/** Maximum one stat may have in the character creation window (separate from the in-game growth cap `STAT_MAX`). */
export const CHAR_STAT_MAX = K.num('CHAR_STAT_MAX');
/** Sum of the five stats in the character creation window. The points left to spend are this − 5 × `CHAR_STAT_MIN`. */
export const CHAR_STAT_TOTAL = K.num('CHAR_STAT_TOTAL');
/** Cap of the number the name dice appends (`스캐빈저1234`). */
export const CHAR_NAME_RANDOM_MAX = K.num('CHAR_NAME_RANDOM_MAX');

/* ── the hold confirm on dangerous buttons (2026-09-09, owner: ui) ── */
/** Seconds the `파티 떠나기` · `타이틀로` · `게임 종료` confirm buttons must be held down. */
export const UI_HOLD_CONFIRM_S = K.num('UI_HOLD_CONFIRM_S');
/** appended (2026-09-12): seconds a piece of furniture is held in ship management before it is picked up for a move (hub/HousingMode · the ui cursor gauge). */
export const HOUSING_MOVE_HOLD_S = K.num('HOUSING_MOVE_HOLD_S');
/** appended (2026-09-17): the messenger — seconds between the NPC's last speech bubble landing and the dialogue choices appearing (`ui/menus/messenger/ChatTab`). */
export const MESSENGER_CHOICE_DELAY_S = K.num('MESSENGER_CHOICE_DELAY_S');

/* ══ 2026-09-09: death · corpses · the rescue drop · fog · terrain features ═════════════════════════════════════════════════════ */

/* ── death · corpses (owner: game/parts/Death · player · inventory) ── */
/**
 * **There is no auto-revive** (2026-09-09). `PLAYER_RESPAWN_DELAY` stays in the contract but nobody reads it —
 * a full death turns the player into a corpse, and the only way back is a squadmate's `rescue_drop`.
 */
/** Distance (m) at which a dead player's corpse can be opened. */
export const PLAYER_CORPSE_LOOT_RANGE = K.num('PLAYER_CORPSE_LOOT_RANGE');
/** Cells of the corpse loot grid — bigger than a crate (6×4) because every piece of equipment and the whole bag at the moment of death must fit. */
export const PLAYER_CORPSE_COLS = K.num('PLAYER_CORPSE_COLS');
export const PLAYER_CORPSE_ROWS = K.num('PLAYER_CORPSE_ROWS');

/* ── the rescue drop (owner: stratagems/parts/Rescue) ── */
/** Rescue drops a squad shares in one raid. One is deducted **when the call is confirmed** (a cancel is not refunded). */
export const RESCUE_DROPS_PER_RAID = K.num('RESCUE_DROPS_PER_RAID');
/** The rescue pod lands at a random point within this radius (m) of the chosen spot. */
export const RESCUE_SCATTER_RADIUS = K.num('RESCUE_SCATTER_RADIUS');
/** Pods falling at the same time are kept at least this far apart (m) (no overlap). */
export const RESCUE_POD_MIN_GAP = K.num('RESCUE_POD_MIN_GAP');
/** Hp a squadmate revived by a rescue drop starts with (empty-handed — the gear stays on the corpse). */
export const RESCUE_REVIVE_HP = K.num('RESCUE_REVIVE_HP');

/* ── the squad-leader device (owner: game/parts/Leader) ── */
/** Seconds the squad-leader device's interaction must be held. */
export const LEADER_DEVICE_HOLD_S = K.num('LEADER_DEVICE_HOLD_S');
/** Interaction distance (m) of the squad-leader device. */
export const LEADER_DEVICE_RANGE = K.num('LEADER_DEVICE_RANGE');

/* ── the fog of war (owner: world/Fog) ── */
/** Side (m) of one fog grid cell. `MAP_SIZE / FOG_CELL_M` is the grid resolution. */
export const FOG_CELL_M = K.num('FOG_CELL_M');
/** Radius (m) one squadmate clears around themselves. */
export const FOG_REVEAL_RADIUS = K.num('FOG_REVEAL_RADIUS');
/** How often the fog grid is repainted (times per second). */
export const FOG_UPDATE_HZ = K.num('FOG_UPDATE_HZ');

/* ── clearance for spawning big enemies (owner: enemies/Spawner) ── */
/** An enemy of at least this radius (m) does not spawn where structures are dense. */
export const ENEMY_BIG_RADIUS = K.num('ENEMY_BIG_RADIUS');
/** Radius of the circle a big enemy tests = its own radius × this. */
export const ENEMY_SPAWN_CLEARANCE_MUL = K.num('ENEMY_SPAWN_CLEARANCE_MUL');
/** The spot is dropped when the obstacle area inside the test circle exceeds this fraction. */
export const ENEMY_SPAWN_BLOCK_RATIO = K.num('ENEMY_SPAWN_BLOCK_RATIO');
/** Max times a dropped spot is drawn again. */
export const ENEMY_SPAWN_RETRIES = K.num('ENEMY_SPAWN_RETRIES');

/* ── stepping onto terrain features (owner: world/WorldSystem) ── */
/** Height difference (m) of an obstacle top that can simply be walked onto. Anything higher blocks like a wall. */
export const PROP_STEP_UP_MAX = K.num('PROP_STEP_UP_MAX');
/** Slack (m) used when judging an obstacle top — keeps the body from sliding off the edge. */
export const PROP_TOP_MARGIN = K.num('PROP_TOP_MARGIN');

/* ── the rail corridor (2026-09-10, owner: world/layout) ── */
/**
 * Half-width (m) of the corridor either side of the rail centre line where **nothing is placed**. Structures, ruined
 * outposts, nests, craters, props, crates and gather nodes all keep this distance clear — the test is
 * `clearance + that object's radius`. Platforms are the exception, and their spot is held by the `platform` pad.
 */
export const RAIL_CLEARANCE_M = K.num('RAIL_CLEARANCE_M');
/** Hold time (s) of a platform's **call console**. Longer than starting the tram from the cab (`TRAM_START_HOLD_S`) —
 * a call brings the whole car over, possibly with someone aboard, and a wrong call makes the squad walk to the far end. */
export const TRAM_CALL_HOLD_S = K.num('TRAM_CALL_HOLD_S');
/** Interaction distance (m) of a platform's call console. */
export const TRAM_CALL_RANGE = K.num('TRAM_CALL_RANGE');
/** 2026-09-10 — distance (m, outside the car's cross-section) at which the 「전차가 곧 출발합니다」 notice is received. Whoever called from far away does not see it. */
export const TRAM_DEPART_NOTICE_RANGE = K.num('TRAM_DEPART_NOTICE_RANGE');

/* ── pings v3 (2026-09-09, owner: ui/hud/Pings) ── */
/** Pings one player keeps at once (mine and a squadmate's alike). Over that, that person's oldest ping goes. */
export const PING_MAX_PER_PLAYER = K.num('PING_MAX_PER_PLAYER');
/** Ping aim assist — an enemy, item, crate or squad ping within this screen distance (px) of the aim point is marked without being hit exactly. */
export const PING_AIM_ASSIST_PX = K.num('PING_AIM_ASSIST_PX');

/* ══ appended: 2026-09-09 — raid play improvements ═════════════════════════════════════════════════════════════
 * Every value is in `data/constants.csv` · `data/tables.csv`. This file owns only the name, the comment and the type.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── the comms wheel (owner: ui/hud/CommsWheel; the layout and the lines live in `shared/comms.ts`) ── */
/** `Keys.COMMS` must be held this long (s) for the wheel to open. A short tap does nothing. */
export const COMMS_WHEEL_HOLD_S = K.num('COMMS_WHEEL_HOLD_S');
/** A slot is selected only past this screen distance (px) from the wheel centre (accumulated pointer-lock deltas). */
export const COMMS_WHEEL_DEAD_PX = K.num('COMMS_WHEEL_DEAD_PX');
/** Seconds before the same person may send another line. */
export const COMMS_COOLDOWN_S = K.num('COMMS_COOLDOWN_S');

/* ── abandoned structures (owner: world/Structures) ── */
/** Radius (m) the structure computer's **planet scan** clears of fog. Once per structure. */
export const STRUCTURE_SCAN_RADIUS = K.num('STRUCTURE_SCAN_RADIUS');
/** Hold time (s) of the planet-scan console. */
export const STRUCTURE_SCAN_HOLD_S = K.num('STRUCTURE_SCAN_HOLD_S');
/** Hold time (s) to open a door locked by a key / keycard (the outpost basement · the lab's locked room). */
export const STRUCTURE_UNLOCK_HOLD_S = K.num('STRUCTURE_UNLOCK_HOLD_S');
/** Interaction distance (m) of a structure's doors and computer. */
export const STRUCTURE_INTERACT_RANGE = K.num('STRUCTURE_INTERACT_RANGE');

/* ── rails · tram (owner: world/Rails) ── */
/** Chance rails are laid in a zone (0 = never). */
export const RAIL_CHANCE = K.num('RAIL_CHANCE');
/**
 * Chance a **rover dirt road** is laid in a zone (0 = never). 2026-09-14 (user's decision) — placed on a roll, like the rails.
 * It used to be planned with no roll at all, so the measured placement rate was 100 %, and then the intel broker's
 * 「탐사 차량 확정」 row buys nothing. `world/layout.ts` consumes the roll as the **first draw of the rover-only fork** —
 * fixing it through the intel broker leaves that draw exactly where it is.
 */
export const ROVER_CHANCE = K.num('ROVER_CHANCE');
/** The tram's **top** running speed (m/s). 2026-09-10: it climbs to this over `TRAM_ACCEL_S`, not right after starting. */
export const TRAM_SPEED = K.num('TRAM_SPEED');
/** Hold time (s) to start the tram from a platform console. */
export const TRAM_START_HOLD_S = K.num('TRAM_START_HOLD_S');
/** 2026-09-10 — seconds between the start notice appearing and the tram actually beginning to move. */
export const TRAM_START_DELAY_S = K.num('TRAM_START_DELAY_S');
/** 2026-09-10 — seconds from starting to move until `TRAM_SPEED` is reached. The acceleration curve is a cubic ease-in. */
export const TRAM_ACCEL_S = K.num('TRAM_ACCEL_S');
/** Seconds the tram stands at a platform. */
export const TRAM_DOCK_S = K.num('TRAM_DOCK_S');

/* ── rogue drops (owner: enemies/RogueDrop) ── */
/** Chance a drop is triggered when a structure / platform is investigated. Rolled **once per zone only**. */
export const ROGUE_DROP_CHANCE = K.num('ROGUE_DROP_CHANCE');
/** Seconds from the warning to touchdown. */
export const ROGUE_DROP_ETA_S = K.num('ROGUE_DROP_ETA_S');
/** Radius (m) the landing points scatter over. */
export const ROGUE_DROP_RADIUS = K.num('ROGUE_DROP_RADIUS');
/** Lower bound of the drop's headcount — **index 0 = a squad of 1**, 3 = a squad of 4 (`data/tables.csv`). */
export const ROGUE_DROP_COUNT_MIN = numberList('tables.csv', 'ROGUE_DROP_COUNT_MIN');
/** Upper bound of the drop's headcount (the same index rule). */
export const ROGUE_DROP_COUNT_MAX = numberList('tables.csv', 'ROGUE_DROP_COUNT_MAX');
/** Chance a **rogue squad leader** is mixed into that drop (the same index rule: 1 → 0 · 2 → 0.5 · 3 or more → 1). */
export const ROGUE_DROP_BOSS_CHANCE = numberList('tables.csv', 'ROGUE_DROP_BOSS_CHANCE');
/**
 * 2026-09-10 — size multiplier of the extraction waves (index 0 = a squad of 1 … 3 = a squad of 4).
 * The wave table is written for a squad of 4, so a solo player took two jump hunters at once on the third wave.
 * The same "table by squad size" convention the rogue drops (`ROGUE_DROP_*`) already used.
 */
export const WAVE_SQUAD_SCALE = numberList('tables.csv', 'WAVE_SQUAD_SCALE');

/* ── environmental hazards (owner: world/Hazard) ── */
/** Lower bound of the hazard's start time (s, measured from the raid start). */
export const HAZARD_START_MIN_S = K.num('HAZARD_START_MIN_S');
/** Upper bound of the hazard's start time (s). */
export const HAZARD_START_MAX_S = K.num('HAZARD_START_MAX_S');
/** The start time is drawn in steps of this many seconds — only values like 6:30 or 7:00 come out. */
export const HAZARD_START_STEP_S = K.num('HAZARD_START_STEP_S');
/** The warning (`hazard:announced`) goes out this many seconds before the start. */
export const HAZARD_WARN_S = K.num('HAZARD_WARN_S');
/** Damage per second taken inside the damage zone. */
export const HAZARD_DPS = K.num('HAZARD_DPS');
/** Interval (s) at which the damage is applied. */
export const HAZARD_TICK_S = K.num('HAZARD_TICK_S');
/** Seconds from the hazard starting until it **covers the whole map**. After that there is no safe ground = extraction is effectively forced. */
export const HAZARD_FULL_S = K.num('HAZARD_FULL_S');
/** Multiplier applied to the fog density inside the damage zone (`atmo:override.fogMul`). */
export const HAZARD_FOG_MUL = K.num('HAZARD_FOG_MUL');
/** Feather width (m) of the zone edge — the screen effect ramps up over it. */
export const HAZARD_EDGE_M = K.num('HAZARD_EDGE_M');
/** Eye of the storm: radius (m) of the first safe circle. */
export const STORM_EYE_RADIUS_START = K.num('STORM_EYE_RADIUS_START');
/** Eye of the storm: the radius (m) once it has closed all the way. */
export const STORM_EYE_RADIUS_END = K.num('STORM_EYE_RADIUS_END');
/** Toxic spores alone have a fixed start time (s) — 6 minutes. */
export const SPORE_START_S = K.num('SPORE_START_S');
/** Minimum number of giant mushroom groves (= spore sources). */
export const SPORE_SOURCES_MIN = K.num('SPORE_SOURCES_MIN');
/** Maximum number of giant mushroom groves. */
export const SPORE_SOURCES_MAX = K.num('SPORE_SOURCES_MAX');
/** Interval (s) at which one more source blooms. */
export const SPORE_SOURCE_INTERVAL_S = K.num('SPORE_SOURCE_INTERVAL_S');
/** Radius (m) of one source once it has grown all the way. */
export const SPORE_RADIUS_MAX = K.num('SPORE_RADIUS_MAX');
/** Speed (m/s) at which a source's radius grows. */
export const SPORE_GROWTH_MPS = K.num('SPORE_GROWTH_MPS');

/* ══ footsteps (2026-09-10) ══════════════════════════════════════════════════════════════════════════════
 * The local player's own footsteps are **not subject to falloff** — they are always heard at the same volume. Only a
 * remote squadmate's fall off by `(1 - d / FOOTSTEP_AUDIBLE_RANGE) ^ FOOTSTEP_FALLOFF_EXP`, and out of range nothing is played at all.
 */
/** Max distance (m) at which a remote squadmate's footsteps are heard. */
export const FOOTSTEP_AUDIBLE_RANGE = K.num('FOOTSTEP_AUDIBLE_RANGE');
/** Exponent of the distance falloff curve — the larger it is, the closer you must be to hear it. */
export const FOOTSTEP_FALLOFF_EXP = K.num('FOOTSTEP_FALLOFF_EXP');
/** Base multiplier applied to remote footsteps (before the distance falloff). */
export const FOOTSTEP_REMOTE_GAIN = K.num('FOOTSTEP_REMOTE_GAIN');
/** Volume of sprinting footsteps. */
export const FOOTSTEP_VOL_SPRINT = K.num('FOOTSTEP_VOL_SPRINT');
/** Volume of walking footsteps. */
export const FOOTSTEP_VOL_WALK = K.num('FOOTSTEP_VOL_WALK');
/** Volume of crouched footsteps. */
export const FOOTSTEP_VOL_CROUCH = K.num('FOOTSTEP_VOL_CROUCH');
/** Volume of prone (crawling) footsteps. */
export const FOOTSTEP_VOL_PRONE = K.num('FOOTSTEP_VOL_PRONE');
/** Minimum interval (s) between one person's footsteps — a jumpy snapshot cannot machine-gun them. */
export const FOOTSTEP_MIN_INTERVAL_S = K.num('FOOTSTEP_MIN_INTERVAL_S');

/* ── appended: keeping enemies from firing into a wall (2026-09-10) ────────── */
/**
 * Minimum distance (m) a ranged enemy must keep between its muzzle and an obstacle when it fires.
 * The line-of-fire test (`enemies/ai/FireLine`) casts its ray from a point pulled this far **back** from the muzzle —
 * with the muzzle buried in a wall it would shoot from inside the wall outwards, which reads as "it went through".
 */
export const ENEMY_WALL_STANDOFF = K.num('ENEMY_WALL_STANDOFF');
/** Interval (s) of the muzzle → target line-of-fire test. The result is cached per enemy (hot path). */
export const ENEMY_FIRE_LOS_S = K.num('ENEMY_FIRE_LOS_S');
/** Seconds a ranged enemy with a blocked line of fire strafes sideways in one go. */
export const ENEMY_FIRE_STRAFE_S = K.num('ENEMY_FIRE_STRAFE_S');

/* == armor = a shield (2026-09-10) ====================================================================
 * Armor does not reduce damage; it gives a **shield (extra hp)**. The shield amount itself is `shield` in
 * `data/armor.csv` (numbered armor uses `ARMOR_SHIELD_BY_TIER` in `tables.csv`); what lives here is only the HUD gauge's tick.
 */
/** What one segment of the bottom-left hp / shield gauge stands for (hp 100 = 5 segments, armor V shield 100 = 5 segments). */
export const ARMOR_SHIELD_PER_SEGMENT = K.num('ARMOR_SHIELD_PER_SEGMENT');

/* ══ danger indicators (2026-09-10) ══════════════════════════════════════════════════════════════════════
 * `ui/hud/DangerIndicators` draws artillery shells, grenades and ship-call drops in one language. The perception-radius
 * gate (`derived.enemyDetectRadius`) that only shells carried stays as it is, but **an impact point inside this distance
 * is shown regardless of perception** — because an indicator exists to warn about "what you never saw coming".
 */
/** Impact distance (m) that always warns, even outside the perception radius. */
export const DANGER_NEAR_RADIUS = K.num('DANGER_NEAR_RADIUS');

/* ══ the rogue drop alert (2026-09-10) ══════════════════════════════════════════════════════════════════════
 * A drop is a roar tearing through the air, so it **does not use the usual perception gate** — both the alarm sound and
 * the HUD danger mark look at `ROGUE_DROP_ALERT_RADIUS` alone (10 × the perception `DETECT_ENEMY_BASE_RADIUS` of 26 m).
 * In exchange **the distance falloff stays**: the same philosophy as remote footsteps (`FOOTSTEP_*`) — outside the
 * radius nothing is played at all, and inside it is multiplied by `(1 - d / radius) ^ ROGUE_DROP_ALERT_FALLOFF_EXP`.
 * The owners are `audio/AudioSystem` (the sound) and `ui/hud/DangerIndicators` (the mark); the drop's own rules stay in `enemies/RogueDrop`.
 */
/** The drop alert's own radius (m). Inside it the drop is heard and seen regardless of perception. */
export const ROGUE_DROP_ALERT_RADIUS = K.num('ROGUE_DROP_ALERT_RADIUS');
/** Distance falloff exponent of the drop sound — `(1 - d / ROGUE_DROP_ALERT_RADIUS) ^ exp`. */
export const ROGUE_DROP_ALERT_FALLOFF_EXP = K.num('ROGUE_DROP_ALERT_FALLOFF_EXP');
/** Base volume of the drop alarm (`rogue_drop_alarm`) — before the distance falloff. */
export const ROGUE_DROP_ALARM_VOLUME = K.num('ROGUE_DROP_ALARM_VOLUME');
/** Base volume of the drop's fall sound (`rogue_pod_fall`) — before the distance falloff. */
export const ROGUE_DROP_FALL_VOLUME = K.num('ROGUE_DROP_FALL_VOLUME');
/** A drop sound that falls below this volume creates no voice. */
export const ROGUE_DROP_MIN_VOLUME = K.num('ROGUE_DROP_MIN_VOLUME');
/** How many seconds before touchdown the falling roar starts (matched to the length of `rogue_pod_fall`). */
export const ROGUE_DROP_FALL_LEAD_S = K.num('ROGUE_DROP_FALL_LEAD_S');

/* ══ tram riding · tram collisions · platform stairs (2026-09-10) ═════════════════════════════════════════════════
 * Every value is in `data/constants.csv`. The owners are `player/PlayerController` (RIDE_*) and `world/Rails`
 * (TRAM_HIT_* · TRAM_CONSOLE_RANGE · RAIL_STAIR_*).
 *
 * **Why `Obstacle.velocity` alone was not enough**: it used to look up "the platform I am standing on" fresh every
 * frame and add its velocity to the position. Drop out of that standing query for even one frame (a jump, a slope, a
 * doorway) and the vehicle slides out from under the feet by that much; a few frames and the body is off the car. So
 * **riding is held as a state** (enter · stay · leave), and the stay condition is not the standing query but the
 * **vehicle OBB + headroom**.
 */
/** Within this height (m) above the platform top the body is still riding — a jump flies along with the vehicle. */
export const RIDE_HEADROOM = K.num('RIDE_HEADROOM');
/** Down to this far (m) below the platform top the body is still riding (slack for slopes and frame jitter). */
export const RIDE_FOOT_DROP = K.num('RIDE_FOOT_DROP');
/** Still riding even this far (m) outside the vehicle collider's cross-section. */
export const RIDE_EDGE_MARGIN = K.num('RIDE_EDGE_MARGIN');
/** Max seconds the vehicle's inertia lingers after stepping off. */
export const RIDE_INERTIA_S = K.num('RIDE_INERTIA_S');
/** Exponential damping coefficient of that inertia (1/s). */
export const RIDE_INERTIA_DAMP = K.num('RIDE_INERTIA_DAMP');

/** A tram running below this speed (m/s) is safe to bump into. */
export const TRAM_HIT_SPEED_MIN = K.num('TRAM_HIT_SPEED_MIN');
/** Damage of being hit by a tram running at `TRAM_SPEED` (the real damage is proportional to the speed at the time). */
export const TRAM_HIT_DAMAGE = K.num('TRAM_HIT_DAMAGE');
/** Speed (m/s) the body is knocked away at when hit (at top speed). */
export const TRAM_HIT_KNOCKBACK = K.num('TRAM_HIT_KNOCKBACK');
/** Seconds before the same person can be hit again. */
export const TRAM_HIT_COOLDOWN_S = K.num('TRAM_HIT_COOLDOWN_S');
/** The feet must be this far (m) below the tram floor to count as hit — the value that takes riders and people on the platform out of the judgement. */
export const TRAM_HIT_FLOOR_CLEAR = K.num('TRAM_HIT_FLOOR_CLEAR');
/** The height range that can be hit reaches this far (m) below the tram floor. */
export const TRAM_HIT_REACH = K.num('TRAM_HIT_REACH');
/** Interaction distance (m) of the tram's cab console. */
export const TRAM_CONSOLE_RANGE = K.num('TRAM_CONSOLE_RANGE');

/** Max rise (m) of one platform stair step — it must stay under `PROP_STEP_UP_MAX` to be walked up. */
export const RAIL_STAIR_MAX_RISE = K.num('RAIL_STAIR_MAX_RISE');
/** Depth (m) of one platform stair step. */
export const RAIL_STAIR_DEPTH = K.num('RAIL_STAIR_DEPTH');

/* ── 2026-09-10: shader pre-compile · light budget (owner: core/LightBudget · core/ShaderWarmup · hub/interiors/LightPool) ── */
/** Point lights always present in the scene — the shortfall is filled with intensity-0 spares (`core/LightBudget`). Kept equal to the raid's real count. */
export const SCENE_POINT_LIGHT_BUDGET = K.num('SCENE_POINT_LIGHT_BUDGET');
/** Point lights a ship interior lights at once — the fixture spots nearest the player first (`hub/interiors/LightPool`). */
export const HUB_POINT_LIGHTS = K.num('HUB_POINT_LIGHTS');
/** Max seconds the screen is held still waiting for the shader pre-compile (`ctx.shaders`). */
export const SHADER_WARMUP_TIMEOUT_S = K.num('SHADER_WARMUP_TIMEOUT_S');

/* ── 2026-09-11: structure lighting · ladders · step smoothing · throw arcs · the roof scanner ── */
/** Point lights an abandoned structure lights at once — the fixture spots nearest the player first (`world/Structures`). */
export const STRUCTURE_POINT_LIGHTS = K.num('STRUCTURE_POINT_LIGHTS');
/** Seconds the roof map scanner's wave takes to reach the edge of the map. */
export const STRUCTURE_SCAN_WAVE_S = K.num('STRUCTURE_SCAN_WAVE_S');
/** Distance (m) at which a ladder can be grabbed at its foot or its top. */
export const LADDER_GRAB_RANGE = K.num('LADDER_GRAB_RANGE');
/** Ladder climb speed (m/s). */
export const LADDER_CLIMB_SPEED = K.num('LADDER_CLIMB_SPEED');
/** Climb speed with the sprint key held (m/s, costs stamina). */
export const LADDER_SPRINT_SPEED = K.num('LADDER_SPRINT_SPEED');
/** Stamina spent per second while climbing fast. */
export const LADDER_SPRINT_DRAIN = K.num('LADDER_SPRINT_DRAIN');
/** Ladder jump — the upward speed of letting go and jumping (m/s). */
export const LADDER_JUMP_SPEED = K.num('LADDER_JUMP_SPEED');
/** Horizontal speed of a ladder jump (m/s, over the ladder = the `-LadderDef.normal` direction). */
export const LADDER_JUMP_PUSH = K.num('LADDER_JUMP_PUSH');
/** Horizontal speed of pushing away when the ladder is released with E (m/s, the `+LadderDef.normal` direction). */
export const LADDER_DROP_PUSH = K.num('LADDER_DROP_PUSH');
/** Length (s) of the mount animation from the top onto the roof. */
export const LADDER_MOUNT_S = K.num('LADDER_MOUNT_S');
/** Damping coefficient (1/s) with which the model catches up to the physics position over a step. */
export const STEP_SMOOTH_RATE = K.num('STEP_SMOOTH_RATE');
/** A one-frame height change larger than this (m) is not smoothed (a teleport). */
export const STEP_SMOOTH_MAX = K.num('STEP_SMOOTH_MAX');
/** The fraction of the throw arc the preview draws (this much of the real horizontal range, no landing marker). */
export const THROW_ARC_PREVIEW_FRACTION = K.num('THROW_ARC_PREVIEW_FRACTION');
/**
 * A raised box collider whose bottom is this far (m) above the feet does not push the body (`world/obb` ·
 * `world/WorldSystem.resolveCollision`). `player/PlayerController`'s jump ceiling clamp uses the same value
 * (2026-09-11 — before that the two folders each wrote 2.1 of their own).
 */
export const BOX_HEADROOM = K.num('BOX_HEADROOM');

/* ── 2026-09-11: placement preview · remote mines (owner: gadgets) ── */
/** Max distance (m, horizontal from the feet) at which a placeable gadget in hand can be put at the aim point. */
export const GADGET_PLACE_RANGE = K.num('GADGET_PLACE_RANGE');
/** Minimum ground normal y a large deployable (barricade · jump pad · turret) stands on (1 = perfectly flat). */
export const GADGET_PLACE_LARGE_MIN_NORMAL_Y = K.num('GADGET_PLACE_LARGE_MIN_NORMAL_Y');
/** Minimum ground normal y a small deployable (mine · remote mine) stands on. */
export const GADGET_PLACE_SMALL_MIN_NORMAL_Y = K.num('GADGET_PLACE_SMALL_MIN_NORMAL_Y');
/** Placement is refused when the ground height difference inside a large deployable's footprint exceeds this (m). */
export const GADGET_PLACE_LARGE_MAX_STEP = K.num('GADGET_PLACE_LARGE_MAX_STEP');
export const GADGET_REMOTE_MINE_DAMAGE = K.num('GADGET_REMOTE_MINE_DAMAGE');
export const GADGET_REMOTE_MINE_RADIUS = K.num('GADGET_REMOTE_MINE_RADIUS');
export const GADGET_REMOTE_MINE_ARM_TIME = K.num('GADGET_REMOTE_MINE_ARM_TIME');
export const GADGET_REMOTE_MINE_HP = K.num('GADGET_REMOTE_MINE_HP');
/** Damage multiplier of the second and later remote mines one target takes in the same detonation (only the first — the strongest — lands in full). */
export const GADGET_REMOTE_MINE_STACK_MUL = K.num('GADGET_REMOTE_MINE_STACK_MUL');
/** Remote mines one player may have in the world at once (over that, the oldest goes first). */
export const GADGET_REMOTE_MINE_MAX_LIVE = K.num('GADGET_REMOTE_MINE_MAX_LIVE');
/** Radius (m) in which a mine mounted on a drone senses enemies — wider than a ground mine (1.5 m) because the drone moves. It senses enemies only. */
export const GADGET_MOUNTED_MINE_TRIGGER_RADIUS = K.num('GADGET_MOUNTED_MINE_TRIGGER_RADIUS');
/** A placement spot more than this far (m) above or below the feet reads as `너무 멀다` (gadgets/parts/Preview). */
export const GADGET_PLACE_VERTICAL_REACH = K.num('GADGET_PLACE_VERTICAL_REACH');

/* ── 2026-09-11: drones (owner: gadgets/drones — shared/drones.ts) ── */
/** Seconds R is held, with the drone item in hand, to take control. The same hold while controlling returns to the PC. */
export const DRONE_CONTROL_HOLD_S = K.num('DRONE_CONTROL_HOLD_S');
/** Past this fraction of the range the screen edges start to crackle. */
export const DRONE_LINK_WARN_RATIO = K.num('DRONE_LINK_WARN_RATIO');
export const DRONE_GROUND_HP = K.num('DRONE_GROUND_HP');
export const DRONE_AIR_HP = K.num('DRONE_AIR_HP');
/** Distance (m, 3-D) from the owner's PC over which control holds. */
export const DRONE_GROUND_RANGE = K.num('DRONE_GROUND_RANGE');
export const DRONE_AIR_RANGE = K.num('DRONE_AIR_RANGE');
/** Ground drone walk speed = `PLAYER_WALK_SPEED` × this (quiet, draws no aggro). */
export const DRONE_GROUND_WALK_MUL = K.num('DRONE_GROUND_WALK_MUL');
/** Ground drone sprint speed = `PLAYER_SPRINT_SPEED` × this (no stamina, but noise and aggro). */
export const DRONE_GROUND_SPRINT_MUL = K.num('DRONE_GROUND_SPRINT_MUL');
/** Peak height (m) of a ground drone's jump — the PC's eye level. */
export const DRONE_GROUND_JUMP_HEIGHT = K.num('DRONE_GROUND_JUMP_HEIGHT');
/** Radius (m) in which enemies hear a sprinting ground drone. */
export const DRONE_NOISE_RADIUS = K.num('DRONE_NOISE_RADIUS');
/** Seconds enemies may still target the drone after the sprint stopped = `DroneRef.aggroable`. */
export const DRONE_NOISE_MEMORY_S = K.num('DRONE_NOISE_MEMORY_S');
/** How many times per second one drone may emit `world:noise` at most. */
export const DRONE_NOISE_EMIT_HZ = K.num('DRONE_NOISE_EMIT_HZ');
export const DRONE_AIR_SPEED = K.num('DRONE_AIR_SPEED');
export const DRONE_AIR_CLIMB_SPEED = K.num('DRONE_AIR_CLIMB_SPEED');
/** Max altitude (m) an air drone may climb above the terrain (or the surface under it). */
export const DRONE_AIR_MAX_ALTITUDE = K.num('DRONE_AIR_MAX_ALTITUDE');
/** Seconds E must be held next to a drone to recover it. */
export const DRONE_RECOVER_HOLD_S = K.num('DRONE_RECOVER_HOLD_S');
/** Broadcast rate (Hz) of `drone state`. */
export const DRONE_NET_HZ = K.num('DRONE_NET_HZ');
/** How many metres in front of the PC a ground drone is set down · how far in front of and above the PC's eyes an air drone is floated. */
export const DRONE_DEPLOY_DIST_GROUND = K.num('DRONE_DEPLOY_DIST_GROUND');
export const DRONE_DEPLOY_DIST_AIR = K.num('DRONE_DEPLOY_DIST_AIR');
export const DRONE_DEPLOY_LIFT_AIR = K.num('DRONE_DEPLOY_LIFT_AIR');
/** Ground drone acceleration · braking · steering acceleration while airborne (m/s²). */
export const DRONE_GROUND_ACCEL = K.num('DRONE_GROUND_ACCEL');
export const DRONE_GROUND_BRAKE = K.num('DRONE_GROUND_BRAKE');
export const DRONE_GROUND_AIR_ACCEL = K.num('DRONE_GROUND_AIR_ACCEL');
/** Extra recovery radius (m) for an air drone. */
export const DRONE_RECOVER_AIR_BONUS = K.num('DRONE_RECOVER_AIR_BONUS');
/** Air drone horizontal acceleration response (1/s) · minimum clearance under the body (m). */
export const DRONE_AIR_ACCEL = K.num('DRONE_AIR_ACCEL');
export const DRONE_AIR_MIN_CLEARANCE = K.num('DRONE_AIR_MIN_CLEARANCE');

/* ── 2026-09-11: named rogues (owner: enemies — shared/named.ts) ── */
/** Minimum distance (m) from the raid's start spawn point at which no named rogue stands. */
export const NAMED_ROGUE_MIN_SPAWN_DIST = K.num('NAMED_ROGUE_MIN_SPAWN_DIST');
/** Durability range of a named rogue's guaranteed gear drop (as a fraction of max durability). */
export const NAMED_LOOT_DURABILITY_MIN = K.num('NAMED_LOOT_DURABILITY_MIN');
export const NAMED_LOOT_DURABILITY_MAX = K.num('NAMED_LOOT_DURABILITY_MAX');
/** Chance a named rogue (one of the three) appears in a raid — index 0 = planet difficulty 1 … 4 = 5 (`planetTier − 1`). */
export const NAMED_ROGUE_CHANCE_BY_RANK: readonly number[] = numberList('tables.csv', 'NAMED_ROGUE_CHANCE_BY_RANK');
/** SMG escorts of the Heavy — index 0 = a squad of 1 … 3 = 4. */
export const NAMED_HEAVY_ESCORTS_BY_SQUAD: readonly number[] = numberList('tables.csv', 'NAMED_HEAVY_ESCORTS_BY_SQUAD');

/* ── 2026-09-11: the C-item batch (commit `36e15e3` — the contract) ── */
/** Quiet per-second damage an enemy inside a hazard zone takes (C-14, owner: enemies — world/Hazard decides the zone). */
export const HAZARD_ENEMY_DPS = K.num('HAZARD_ENEMY_DPS');
/** Gather node quantity rolls (C-20, owner: world/Gather) — the chance of 2 `고철` / 2 `약초`, and the chance / count of a bonus core from `고철`. */
export const GATHER_SALVAGE_QTY2_CHANCE = K.num('GATHER_SALVAGE_QTY2_CHANCE');
export const GATHER_HERB_QTY2_CHANCE = K.num('GATHER_HERB_QTY2_CHANCE');
export const GATHER_SALVAGE_CORE_CHANCE = K.num('GATHER_SALVAGE_CORE_CHANCE');
export const GATHER_SALVAGE_CORE_QTY = K.num('GATHER_SALVAGE_CORE_QTY');
/** 2026-09-13 (owner: world/Gather): chance / count of a bonus unidentified mineral (`spec_mineral`) from a `고철 더미` — the same convention as the core, on its own fork `gather_mineral`. */
export const GATHER_SALVAGE_MINERAL_CHANCE = K.num('GATHER_SALVAGE_MINERAL_CHANCE');
export const GATHER_SALVAGE_MINERAL_QTY = K.num('GATHER_SALVAGE_MINERAL_QTY');
/** Durability the equipped bag loses per raid (C-36, owner: inventory). */
export const BAG_DURABILITY_PER_RAID = K.num('BAG_DURABILITY_PER_RAID');

/* ── 2026-09-11: social · trust · connection (commits `9bd72ce` — the contract · `b3fc2f0` — the implementation) ── */
/** E-4 (owner: shared/buffRules — used by implants · gadgets): buff range slack (m). */
export const BUFF_RANGE_SLACK = K.num('BUFF_RANGE_SLACK');
/** E-4: the receiving side's heal token bucket multiplier. */
export const BUFF_HEAL_RATE_MARGIN = K.num('BUFF_HEAL_RATE_MARGIN');
/** E-4 (owner: meta): allowance of squadmate contractHit per second (per sender and per goal). */
export const META_HIT_RATE = K.num('META_HIT_RATE');
/** E-4 (owner: stratagems): max distance (m) of a ship call the host accepts. */
export const STRAT_MAX_CALL_RANGE = K.num('STRAT_MAX_CALL_RANGE');
/* appended (2026-09-11, E-4 ⑤ — add-only) */
/** E-4 (owner: stratagems): the host's per-caller slack (s) on the shared cooldown. */
export const STRAT_COOLDOWN_SLACK_S = K.num('STRAT_COOLDOWN_SLACK_S');
/** E-4 (owner: shared/buffRules): the receiving side's heal bucket size (s). */
export const BUFF_HEAL_BURST_S = K.num('BUFF_HEAL_BURST_S');
/** E-4 (owner: enemies): per-sender cap on damage per second of the hit requests the host accepts, and the bucket size (s). */
export const HIT_REQUEST_DPS_MAX = K.num('HIT_REQUEST_DPS_MAX');
export const HIT_REQUEST_BURST_S = K.num('HIT_REQUEST_BURST_S');
/** X-6 (owner: enemies): distance slack (m) of the geometry test on a knockback request. */
export const HIT_KNOCKBACK_RANGE_SLACK = K.num('HIT_KNOCKBACK_RANGE_SLACK');
/** C-57 (owner: world): slack (m) of the distance test on `crate opened`. */
export const CRATE_OPEN_RANGE_SLACK = K.num('CRATE_OPEN_RANGE_SLACK');
/* appended (2026-09-11, E-8 — docs/DECISIONS.md 「2026-09-11 — 신뢰 경로의 남은 틈」 — add-only) */
/** E-8 (owner: enemies): distance-test slack (m) on an explode request. The baseline is `STRAT_MAX_CALL_RANGE`. */
export const EXPLODE_REQUEST_RANGE_SLACK = K.num('EXPLODE_REQUEST_RANGE_SLACK');
/** E-8 (owner: enemies): distance-test slack (m) on a status-effect request. The baseline is `max(FLAME_RANGE, SHOCK_RANGE)`. */
export const STATUS_REQUEST_RANGE_SLACK = K.num('STATUS_REQUEST_RANGE_SLACK');
/** E-8 (owner: enemies): per-sender cap on status-effect requests per second, and the bucket size (s). */
export const STATUS_REQUEST_RATE_MAX = K.num('STATUS_REQUEST_RATE_MAX');
export const STATUS_REQUEST_BURST_S = K.num('STATUS_REQUEST_BURST_S');
/** E-5 (owner: game/SoloRaid): how far the clock may run backwards (ms). */
export const SOLO_CLOCK_BACK_TOLERANCE_MS = K.num('SOLO_CLOCK_BACK_TOLERANCE_MS');
/** E-5: the key that records the latest `Date.now()` seen so far (it goes through `slotKey`). */
export const SOLO_CLOCK_HIGH_KEY = 'scav.clockHigh';
/** B-4 (owner: net/SocialSync): private chat (formerly whispers) history — lines per peer · number of peers · the key (`slotKey`). */
export const WHISPER_HISTORY_PER_PEER = K.num('WHISPER_HISTORY_PER_PEER');
export const WHISPER_HISTORY_PEERS = K.num('WHISPER_HISTORY_PEERS');
export const WHISPER_STORAGE_KEY = 'scav.whispers';

/* ── 2026-09-11: the lab — analyzer · planet environment (A-12 · A-13) ──
 * 2026-09-16 (user's decision): the old `ANALYZE_DEX_SPEEDUP` (catalogue progress × 0.5) and `ANALYZE_KNOWN_SPEEDUP`
 * (×0.6 for a known sample) were **deleted** — the five `ANALYSIS_*` entries below replace them. The csv rows went with
 * them: a key no code reads is caught by `npm run data:check` as 「아무도 읽지 않는 키」, so code and csv must be cleared together. */

/* ── 2026-09-16 (user's decision): the new rule for shortening analysis time (owner: housing) ──
 * Replaces the old `ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP` pair. Two things changed:
 *   ① The catalogue bonus is not 「analysis of that kind gets faster」 but **every sample of the same rarity** gets
 *      faster with each catalogue entry filled.
 *   ② Analysing the same sample again raises that sample's **level** for a further bonus, with the curve pushed to the
 *      front — the first analysis, which makes it level 1, hands over the whole `FIRST` (+3 %), and every level after
 *      that adds only `STEP` (+0.5 %). The user's request for 「a big bonus the first time it is registered」 is exactly
 *      the gap between those two values.
 * The **sum** of the catalogue and level shortenings is clipped at `ANALYSIS_SPEEDUP_CAP`. The family's analysis-level
 * time multiplier (`ANALYSIS_TIME_MUL_BY_LEVEL`) is multiplied in separately.
 */
/** The fraction each analysis catalogue entry takes off the analysis time of **the same rarity** of sample. */
export const ANALYSIS_DEX_BONUS_PER_ENTRY = K.num('ANALYSIS_DEX_BONUS_PER_ENTRY');
/** The shortening when a sample is analysed for the first time and reaches level 1 — far larger than the per-level step (the front-loaded curve). */
export const ANALYSIS_SAMPLE_LEVEL_FIRST = K.num('ANALYSIS_SAMPLE_LEVEL_FIRST');
/** The extra shortening added per level gained past level 1. */
export const ANALYSIS_SAMPLE_LEVEL_STEP = K.num('ANALYSIS_SAMPLE_LEVEL_STEP');
/** Level cap of one sample. */
export const ANALYSIS_SAMPLE_LEVEL_MAX = K.num('ANALYSIS_SAMPLE_LEVEL_MAX');
/** Cap of the catalogue + sample-level shortening added together (0.5 = down to half). */
export const ANALYSIS_SPEEDUP_CAP = K.num('ANALYSIS_SPEEDUP_CAP');

/* ── 2026-09-16 (user's decision): planet ore veins · mining (owner: world) ──
 * An ore vein is a kind of gather node, like herbs and samples. Mining one yields **unidentified minerals** only, and
 * their rarity is rolled on the same probability table as guns (the `tier = the planet's threat` row of
 * `data/loot_tiers.csv`, `mythic` column included) — no second table is made. At difficulty 1 that row only weights up
 * to rare, so it stops at rare by itself. The mining skill pushes only the upper end of that roll through
 * `DerivedStats.miningRarityBonus` (it cannot go past the cap).
 */
/** Seconds of E held to mine one ore vein. `interactSpeedMul` divides it. */
export const MINING_NODE_HOLD_S = K.num('MINING_NODE_HOLD_S');
/** Lower / upper bound of the unidentified minerals one ore vein yields (uniform over integers). */
export const MINING_YIELD_MIN = K.num('MINING_YIELD_MIN');
export const MINING_YIELD_MAX = K.num('MINING_YIELD_MAX');
/** Ore veins stand only on slopes at least this steep (tan θ) — user's decision, 「주로 언덕쪽 위주」. */
export const MINING_HILL_MIN_SLOPE = K.num('MINING_HILL_MIN_SLOPE');
/** `mining` skill XP gained from working one ore vein. */
export const MINING_SKILL_XP = K.num('MINING_SKILL_XP');
/**
 * A-13 (owner: player): **hp** lost per second on a planet with a permanent environment (`PlanetDef.env`) without the
 * matching preparation. Armor shield does not stop the atmosphere, so it is bypassed (user's decision: the right
 * preparation cancels it 100 %).
 */
export const PLANET_ENV_DPS = K.num('PLANET_ENV_DPS');
/** A-13 (owner: player): interval (s) at which environment damage is applied. One tick = `PLANET_ENV_DPS × this`. */
export const PLANET_ENV_TICK_S = K.num('PLANET_ENV_TICK_S');
/**
 * A-11 · A-12 (owner: world/Gather): hold time (s) and interaction radius (m) of wild seed clusters and unidentified
 * sample spots. Unlike herbs, scrap and soil, which sat as numbers inside `Gather.ts`, these live in the csv from the
 * start (「수치는 코드에 적지 않는다」, exactly) — the older three will follow here the next time they are touched.
 */
export const SEED_INTERACT_TIME = K.num('SEED_INTERACT_TIME');
export const SEED_NODE_RADIUS = K.num('SEED_NODE_RADIUS');
export const SAMPLE_INTERACT_TIME = K.num('SAMPLE_INTERACT_TIME');
export const SAMPLE_NODE_RADIUS = K.num('SAMPLE_NODE_RADIUS');

/* ── 2026-09-11: the kitchen · the culture tank · the printer (A-3c · A-14 · A-15) ── */
/**
 * A-15 (owner: inventory): the **number of pouch slots** in the equipment column. Fixed at 1 by the user's decision —
 * only one of the four is fitted. The bag does not decide it (`BagDef` was left untouched).
 */
export const POUCH_SLOTS = K.num('POUCH_SLOTS');
/**
 * A-3c (owner: housing — the shared ship's dining table): the radius (m) `분대에 차리기` feeds. Only squadmates inside
 * it are served — the host tests it against the snapshot distance (the same grain as the range guard of `shared/buffRules`).
 */
export const MEAL_SERVE_RANGE = K.num('MEAL_SERVE_RANGE');

/* ── 2026-09-12: the hybrid shot resolution (owner: weapons/parts/AimLine) ── */
/**
 * How many metres in front of the muzzle an obstacle still counts as "the muzzle is blocked". Caught on the muzzle
 * line inside that range, the bullet hits there (a red circle on the wall · the crosshair's warning colour); anything
 * farther is resolved by the crosshair line — which is what stopped unaimed bullets burying themselves in the left
 * edge of a distant rock.
 */
export const WEAPON_MUZZLE_BLOCK_RANGE = K.num('WEAPON_MUZZLE_BLOCK_RANGE');

/* ══ 2026-09-12 — consumables · implants · keys · drone scan · favourites · the gym (docs/DECISIONS.md 「2026-09-12 — 전투 소모품」) ══
 * Every parallel agent appends **inside its own block only**. The values go in the identically marked block of data/constants.csv. */
/* ── [A1] the three consumables ── */
/**
 * owner: player (`parts/Boosts`). Duration (s) of the adrenaline shot — full stamina refill plus **continuous drain
 * only** at 0 for that long. One-off costs (jump · roll · melee · shield bash) are unchanged.
 */
export const BOOST_ADRENALINE_DURATION_S = K.num('BOOST_ADRENALINE_DURATION_S');
/** owner: player. Duration (s) of the stimulant. It and the adrenaline cancel each other (the later one wins). */
export const BOOST_STIMULANT_DURATION_S = K.num('BOOST_STIMULANT_DURATION_S');
/** Reload speed multiplier while the stimulant is up (>1 = faster). weapons reads it as `PlayerRef.boostReloadSpeedMul`. */
export const BOOST_STIMULANT_RELOAD_SPEED_MUL = K.num('BOOST_STIMULANT_RELOAD_SPEED_MUL');
/** ADS transition speed multiplier while the stimulant is up (>1 = faster). player multiplies it into the ADS blend damping rate. */
export const BOOST_STIMULANT_ADS_SPEED_MUL = K.num('BOOST_STIMULANT_ADS_SPEED_MUL');
/** Aim sway multiplier while the stimulant is up (<1 = less). Published as `PlayerRef.aimSwayMul`. */
export const BOOST_STIMULANT_AIM_SWAY_MUL = K.num('BOOST_STIMULANT_AIM_SWAY_MUL');
/** The stimulant's price: stamina cost multiplier — for both the continuous drain and the one-off costs. */
export const BOOST_STIMULANT_STAMINA_COST_MUL = K.num('BOOST_STIMULANT_STAMINA_COST_MUL');
/* ── end [A1] ── */
/* ── [A2] aim sway ── */
/**
 * Aim sway (owner: player/CameraRig · the per-class amplitude is `data/aim_sway.csv` → weapons/AimSway). While aiming
 * the camera drifts in a figure of eight — the vertical amplitude is the horizontal one × `AIM_SWAY_PITCH_RATIO` (and
 * it turns twice as fast). The stance / movement multipliers are the values at crouch, prone and walking speed.
 */
export const AIM_SWAY_PITCH_RATIO = K.num('AIM_SWAY_PITCH_RATIO');
export const AIM_SWAY_CROUCH_MUL = K.num('AIM_SWAY_CROUCH_MUL');
export const AIM_SWAY_PRONE_MUL = K.num('AIM_SWAY_PRONE_MUL');
export const AIM_SWAY_MOVE_MUL = K.num('AIM_SWAY_MOVE_MUL');
/** The `damp` rate at which the sway amplitude (stance · movement · weapon swap · the ADS gate) follows its target. */
export const AIM_SWAY_BLEND_RATE = K.num('AIM_SWAY_BLEND_RATE');
/* ── end [A2] ── */
/* ── [B] tactical implants · the ship-call ready cue ── */
/**
 * (owner: implants/parts/Devices.refundGrapple) grapple cooldown refund — every ratio is measured against the
 * effective cooldown (`ImplantsRef.cooldownTotal`). Attached and then released: from the real distance travelled
 * between attaching and releasing, d (inertia excluded), `REFUND_MAX × max(0, 1 − d / REFUND_DIST)`.
 * Ended before it attached (Q recalled in flight · the drone anchor lost): `CANCEL_REFUND`, but the remaining
 * cooldown stays at `CANCEL_MIN_S` or more.
 */
export const IMPLANT_GRAPPLE_REFUND_MAX = K.num('IMPLANT_GRAPPLE_REFUND_MAX');
export const IMPLANT_GRAPPLE_REFUND_DIST = K.num('IMPLANT_GRAPPLE_REFUND_DIST');
export const IMPLANT_GRAPPLE_CANCEL_REFUND = K.num('IMPLANT_GRAPPLE_CANCEL_REFUND');
export const IMPLANT_GRAPPLE_CANCEL_MIN_S = K.num('IMPLANT_GRAPPLE_CANCEL_MIN_S');
/* ── end [B] ── */
/* ── [C] keys · keycards · locked rooms · crawl holes ── */
/* ── end [C] ── */
/* ── [D] the ground drone's scan ── */
/**
 * owner: gadgets/drones (`parts/Scan`). Seconds LMB must be held while controlling a ground drone and keeping the aim
 * on the target — filled, the **highest rarity** inside it floats over it for the rest of the raid (shared with the
 * squad). Lose the aim or move out of range and it restarts from 0.
 */
export const DRONE_SCAN_HOLD_S = K.num('DRONE_SCAN_HOLD_S');
/** Max 3-D distance (m) from the drone's lens to the target's centre. */
export const DRONE_SCAN_RANGE = K.num('DRONE_SCAN_RANGE');
/** Radius (m) of the aim test sphere — the lens's centre ray counts as aimed when it passes this close to the target's centre. */
export const DRONE_SCAN_AIM_RADIUS = K.num('DRONE_SCAN_AIM_RADIUS');
/** Distance (m) within which a target that is aimed at but out of range shows the 「더 가까이」 hint. */
export const DRONE_SCAN_HINT_RANGE = K.num('DRONE_SCAN_HINT_RANGE');
/** owner: ui (`hud/DroneScanLabels`). World label height (m, above the target's base) · max visible distance (m, from the camera). */
export const DRONE_SCAN_LABEL_HEIGHT = K.num('DRONE_SCAN_LABEL_HEIGHT');
export const DRONE_SCAN_LABEL_MAX_DIST = K.num('DRONE_SCAN_LABEL_MAX_DIST');
/** Receiving side: a squadmate's scan is trusted only while the sender's ground drone replica is within `DRONE_SCAN_RANGE` + this (m) of the target. */
export const DRONE_SCAN_SHARE_SLACK = K.num('DRONE_SCAN_SHARE_SLACK');
/* ── end [D] ── */
/* ── [E1] the favourites core ── */
/* ── end [E1] ── */
/* ── [E2] favourite chips · the item recovery contract ── */
/* ── end [E2] ── */
/* ── [F] the gym minigames ── */
/* ── end [F] ── */
/* ── [H] hazard strength · toxic spore layout · extraction pad count (2026-09-13, owner: world/Hazard · world/layout) ── */
/** Damage per second once the hazard covers the whole map (progress 1) — it rises from `HAZARD_DPS` (at the start) in proportion to the progress (`HazardRef.damageMul`). */
export const HAZARD_DPS_MAX = K.num('HAZARD_DPS_MAX');
/** Strength multiplier of the sight restriction — multiplied into (fogMul − 1) of `hazards.csv` fogMul. Start value → end value at progress 1. */
export const HAZARD_FOG_RAMP_START = K.num('HAZARD_FOG_RAMP_START');
export const HAZARD_FOG_RAMP_END = K.num('HAZARD_FOG_RAMP_END');
/** Fraction of particles drawn (multiplied into `hazards.csv` particleCount). Start value → end value at progress 1. */
export const HAZARD_PARTICLE_RAMP_START = K.num('HAZARD_PARTICLE_RAMP_START');
export const HAZARD_PARTICLE_RAMP_END = K.num('HAZARD_PARTICLE_RAMP_END');
/** The sandstorm / blizzard front comes in from the edge the drop point sits on — ± this angle (rad) off that direction. */
export const HAZARD_FRONT_SPAWN_JITTER_RAD = K.num('HAZARD_FRONT_SPAWN_JITTER_RAD');
/** The eye's first radius = the distance from the eye's centre to the farthest map corner + this (m). `STORM_EYE_RADIUS_START` survives only as its floor. */
export const STORM_EYE_START_MARGIN_M = K.num('STORM_EYE_START_MARGIN_M');
/** A toxic-spore raid: the drop point's radius (from the map centre, m) · the central radius the groves stand in · the grove ↔ drop point gap · the gap between central groves. */
export const SPORE_SPAWN_CENTER_M = K.num('SPORE_SPAWN_CENTER_M');
export const SPORE_CENTER_RADIUS_M = K.num('SPORE_CENTER_RADIUS_M');
export const SPORE_GROVE_SPAWN_GAP_M = K.num('SPORE_GROVE_SPAWN_GAP_M');
export const SPORE_CENTER_GROVE_GAP_M = K.num('SPORE_CENTER_GROVE_GAP_M');
/** Extraction pads of a toxic-spore raid stand only out where the larger of |x| · |z| from the map centre is at least this (m). */
export const EXTRACTION_OUTER_MIN_M = K.num('EXTRACTION_OUTER_MIN_M');
/** Range of extraction pad counts in a toxic-spore raid (independent of the planet's threat). */
export const EXTRACTION_PADS_SPORES_MIN = K.num('EXTRACTION_PADS_SPORES_MIN');
export const EXTRACTION_PADS_SPORES_MAX = K.num('EXTRACTION_PADS_SPORES_MAX');
/** Range of extraction pad counts per planet threat 1..3 (index 0..2) — drawn from that range with the mission seed (`world/layout.extractionPadCount`). */
export const EXTRACTION_PADS_MIN_BY_THREAT: readonly number[] = numberList('tables.csv', 'EXTRACTION_PADS_MIN_BY_THREAT');
export const EXTRACTION_PADS_MAX_BY_THREAT: readonly number[] = numberList('tables.csv', 'EXTRACTION_PADS_MAX_BY_THREAT');
/* ── end [H] ── */
/* ── [2026-09-13] the extraction rework (owner: extraction · game · ui) ── */
/** Grace (s) between the departure switch (or the automatic departure) and the actual liftoff. Uncancellable, and people may still board during it. */
export const EXTRACTION_DEPART_GRACE_S = K.num('EXTRACTION_DEPART_GRACE_S');
/** With nobody pressing the departure switch after touchdown, the departure grace starts by itself after this many seconds. */
export const EXTRACTION_AUTO_DEPART_IDLE_S = K.num('EXTRACTION_AUTO_DEPART_IDLE_S');
/** Seconds from liftoff to a rider's result screen — the external camera shot ends inside it. */
export const EXTRACTION_LIFTOFF_TO_COMPLETE_S = K.num('EXTRACTION_LIFTOFF_TO_COMPLETE_S');
/** Liftoff cinematic: seconds of the blend from the character camera to the ship's external camera. */
export const EXTRACTION_CINEMATIC_BLEND_S = K.num('EXTRACTION_CINEMATIC_BLEND_S');
/** Liftoff cinematic: seconds over which the combat HUD disappears. */
export const EXTRACTION_HUD_FADE_S = K.num('EXTRACTION_HUD_FADE_S');
/* ── end [2026-09-13] the extraction rework ── */

/* ══ appended (2026-09-13): burrowing bug spawns · the sandworm event (owner: enemies) ═════════════════════════════════════
 * Every value is `BURROW_*` · `SANDWORM_*` in `data/constants.csv` and the `SANDWORM_*` tables in `data/tables.csv`. The rules are in `src/enemies/README.md`.
 */
/** Seconds a bug spawned mid-play takes to dig its way up. */
export const BURROW_EMERGE_S = K.num('BURROW_EMERGE_S');
/** How much deeper (m) than its own height the body is buried when the burrow starts. */
export const BURROW_SINK_EXTRA_M = K.num('BURROW_SINK_EXTRA_M');
/** Distance (m) from the local player within which the burrow shake is felt. */
export const BURROW_SHAKE_RADIUS = K.num('BURROW_SHAKE_RADIUS');
/** Intensity of the burrow shake. */
export const BURROW_SHAKE_INTENSITY = K.num('BURROW_SHAKE_INTENSITY');
/** Minimum interval (s) between burrow shakes — they never overlap. */
export const BURROW_SHAKE_GAP_S = K.num('BURROW_SHAKE_GAP_S');
/* ── appended (2026-09-16): bug sounds — the burrow sound · footsteps · the shell's falling sound (owner: audio · enemies). The values are in `data/constants.csv`. ── */
/** Cap on simultaneous `burrow_emerge` voices (`audio/AudioSystem.VOICE_CAP`). */
export const BURROW_EMERGE_VOICE_CAP = K.num('BURROW_EMERGE_VOICE_CAP');
/** The window (s) over which burrow sounds count as one group — the k-th sound × 1/√k (`enemies/parts/Burrow`). */
export const BURROW_EMERGE_BATCH_S = K.num('BURROW_EMERGE_BATCH_S');
/** Range (m) of bug footsteps — `bug_step_skitter` · `bug_step_heavy`; the behemoth's `bug_step_giant` uses GIANT. */
export const BUG_STEP_RANGE_M = K.num('BUG_STEP_RANGE_M');
export const BUG_STEP_GIANT_RANGE_M = K.num('BUG_STEP_GIANT_RANGE_M');
/** Cap on simultaneous voices across all three bug footstep ids. */
export const BUG_STEP_VOICE_CAP = K.num('BUG_STEP_VOICE_CAP');
/** The window (s) over which 「nearby bugs that are walking」 are counted — footsteps × 1/√n (`enemies/model.emitEnemyStep`). */
export const BUG_STEP_CROWD_WINDOW_S = K.num('BUG_STEP_CROWD_WINDOW_S');
/** The shell's falling sound: how many seconds before impact · the impact point's range (m) · floor · base volume · the simultaneous voice cap. Plus the range (m) of the launch thud. */
export const SHELL_INCOMING_LEAD_S = K.num('SHELL_INCOMING_LEAD_S');
export const SHELL_INCOMING_RANGE_M = K.num('SHELL_INCOMING_RANGE_M');
export const SHELL_INCOMING_FLOOR = K.num('SHELL_INCOMING_FLOOR');
export const SHELL_INCOMING_VOLUME = K.num('SHELL_INCOMING_VOLUME');
export const SHELL_INCOMING_VOICE_CAP = K.num('SHELL_INCOMING_VOICE_CAP');
export const SHELL_LAUNCH_RANGE_M = K.num('SHELL_LAUNCH_RANGE_M');
/** The raid-time window (s, `ctx.missionTime`) in which a sandworm may rise. */
export const SANDWORM_WINDOW_START_S = K.num('SANDWORM_WINDOW_START_S');
export const SANDWORM_WINDOW_END_S = K.num('SANDWORM_WINDOW_END_S');
/** Interval (s) at which the conditions are re-checked after the trigger time. */
export const SANDWORM_CHECK_S = K.num('SANDWORM_CHECK_S');
/** The radius (m) that counts as 「moving together」 in multiplayer. */
export const SANDWORM_GROUP_RADIUS = K.num('SANDWORM_GROUP_RADIUS');
/** Warning → eruption (s). */
export const SANDWORM_WARN_S = K.num('SANDWORM_WARN_S');
/** Radius (m) in which the warning / eruption shake is felt. */
export const SANDWORM_ALERT_RADIUS = K.num('SANDWORM_ALERT_RADIUS');
/** Max intensity of one warning shake. */
export const SANDWORM_SHAKE_MAX = K.num('SANDWORM_SHAKE_MAX');
/** Eruption judgement radius (m) · damage · knockback (m/s). */
export const SANDWORM_ERUPT_RADIUS = K.num('SANDWORM_ERUPT_RADIUS');
export const SANDWORM_ERUPT_DAMAGE = K.num('SANDWORM_ERUPT_DAMAGE');
export const SANDWORM_ERUPT_KNOCKBACK = K.num('SANDWORM_ERUPT_KNOCKBACK');
/** Range of the sandworm's max hp (rolled by the host). */
export const SANDWORM_HP_MIN = K.num('SANDWORM_HP_MIN');
export const SANDWORM_HP_MAX = K.num('SANDWORM_HP_MAX');
/** Seconds the body takes to rise fully. */
export const SANDWORM_RISE_S = K.num('SANDWORM_RISE_S');
/** Ring radius (m) of the bug swarm thrown out by the eruption. */
export const SANDWORM_BURST_RING_MIN = K.num('SANDWORM_BURST_RING_MIN');
export const SANDWORM_BURST_RING_MAX = K.num('SANDWORM_BURST_RING_MAX');
/** The bug-spitting phase: its length · interval (s) · count per volley · flight time (s) · landing distance (m). */
export const SANDWORM_SPIT_PHASE_S = K.num('SANDWORM_SPIT_PHASE_S');
export const SANDWORM_SPIT_INTERVAL_S = K.num('SANDWORM_SPIT_INTERVAL_S');
export const SANDWORM_SPIT_COUNT = K.num('SANDWORM_SPIT_COUNT');
export const SANDWORM_SPIT_FLIGHT_S = K.num('SANDWORM_SPIT_FLIGHT_S');
export const SANDWORM_SPIT_MIN_M = K.num('SANDWORM_SPIT_MIN_M');
export const SANDWORM_SPIT_MAX_M = K.num('SANDWORM_SPIT_MAX_M');
/** Cap on the total living enemies while bugs are being spat out. */
export const SANDWORM_ALIVE_CAP = K.num('SANDWORM_ALIVE_CAP');
/** The acid phase: range (m) · interval (s) · blobs per volley. */
export const SANDWORM_ACID_RANGE = K.num('SANDWORM_ACID_RANGE');
export const SANDWORM_ACID_INTERVAL_S = K.num('SANDWORM_ACID_INTERVAL_S');
export const SANDWORM_ACID_VOLLEY = K.num('SANDWORM_ACID_VOLLEY');
/** Chance of the event per raid — index 0 = planet threat 1 (`data/tables.csv`). */
export const SANDWORM_CHANCE_BY_THREAT = numberList('tables.csv', 'SANDWORM_CHANCE_BY_THREAT');
/** Number of bugs in the eruption swarm — index 0 = a squad of 1. */
export const SANDWORM_BURST_BY_SQUAD = numberList('tables.csv', 'SANDWORM_BURST_BY_SQUAD');
/* ── end 2026-09-13 burrowing spawns · the sandworm ── */

/* ── 2026-09-13 the rover — shared (the values are in data/constants.csv, the rules in the rover section of shared/types.ts) ── */
/** Seconds of E held to board / step off. */
export const ROVER_BOARD_HOLD_S = K.num('ROVER_BOARD_HOLD_S');
export const ROVER_EXIT_HOLD_S = K.num('ROVER_EXIT_HOLD_S');
/** Seconds the rover dwells at a station — the clock does not run down while someone is aboard and has not paid. */
export const ROVER_DWELL_S = K.num('ROVER_DWELL_S');
/** Departure grace (s) after payment. */
export const ROVER_DEPART_GRACE_S = K.num('ROVER_DEPART_GRACE_S');
/** The vehicle's hp. */
export const ROVER_HP = K.num('ROVER_HP');
/** Multiplier on the hazard damage taken inside a hazard zone. */
export const ROVER_HAZARD_DAMAGE_MUL = K.num('ROVER_HAZARD_DAMAGE_MUL');
/** Fare = round(MIN + distance × PER_M) to the nearest 10, clamped to [MIN, MAX]. The formula's source is `RoverRef.fareTo`. */
export const ROVER_FARE_MIN = K.num('ROVER_FARE_MIN');
export const ROVER_FARE_MAX = K.num('ROVER_FARE_MAX');
export const ROVER_FARE_PER_M = K.num('ROVER_FARE_PER_M');
/* ── [R1] the route · stations · the dirt road (owner: world/rover RoverRoad · world/layout) ── */
/** Half-width (m) of the dirt road corridor — nothing is placed inside it (`layout.roverClearance` · `isSpotFree`). */
export const ROVER_ROUTE_CLEARANCE_M = K.num('ROVER_ROUTE_CLEARANCE_M');
/** Range of the station count (seeded). */
export const ROVER_STATION_COUNT_MIN = K.num('ROVER_STATION_COUNT_MIN');
export const ROVER_STATION_COUNT_MAX = K.num('ROVER_STATION_COUNT_MAX');
/** Minimum distance (m) between stations. */
export const ROVER_STATION_MIN_GAP_M = K.num('ROVER_STATION_MIN_GAP_M');
/** Angular jitter of a station (± as a fraction of the angular slot width). */
export const ROVER_STATION_ANGLE_JITTER = K.num('ROVER_STATION_ANGLE_JITTER');
/** The station's site (its flattening pad): radius · edge width (m). */
export const ROVER_STATION_PAD_R = K.num('ROVER_STATION_PAD_R');
export const ROVER_STATION_PAD_BLEND = K.num('ROVER_STATION_PAD_BLEND');
/** Minimum distance (m) of the dirt road and its stations from the map centre (widened automatically when there is a loop rail). */
export const ROVER_RING_MIN_M = K.num('ROVER_RING_MIN_M');
/** Max |x| · |z| (m) of the dirt road's centre line. */
export const ROVER_ROUTE_BOUND_M = K.num('ROVER_ROUTE_BOUND_M');
/** Clearance (m) between the loop rail corridor and the dirt road corridor. */
export const ROVER_RAIL_GAP_M = K.num('ROVER_RAIL_GAP_M');
/** Clearance (m) from the drop point's site. */
export const ROVER_SPAWN_GAP_M = K.num('ROVER_SPAWN_GAP_M');
/** Max bend (m) of the leg between two stations. */
export const ROVER_ROUTE_WIGGLE_M = K.num('ROVER_ROUTE_WIGGLE_M');
/** Spacing (m) of the layout route points · planning retries · minimum turning radius (m). */
export const ROVER_PLAN_STEP_M = K.num('ROVER_PLAN_STEP_M');
export const ROVER_PLAN_ATTEMPTS = K.num('ROVER_PLAN_ATTEMPTS');
export const ROVER_MIN_TURN_RADIUS_M = K.num('ROVER_MIN_TURN_RADIUS_M');
/** Spacing (m) of the built route points · road-surface smoothing passes. */
export const ROVER_ROUTE_STEP_M = K.num('ROVER_ROUTE_STEP_M');
export const ROVER_ROUTE_SMOOTH_PASSES = K.num('ROVER_ROUTE_SMOOTH_PASSES');
/** Half-width of the drawn dirt road · its lift (m). */
export const ROVER_ROAD_HALF_WIDTH_M = K.num('ROVER_ROAD_HALF_WIDTH_M');
export const ROVER_ROAD_LIFT_M = K.num('ROVER_ROAD_LIFT_M');
/** The marker pole's offset from the dirt road's centre line · its height (m). */
export const ROVER_POLE_OFFSET_M = K.num('ROVER_POLE_OFFSET_M');
export const ROVER_POLE_HEIGHT_M = K.num('ROVER_POLE_HEIGHT_M');
/* ── end [R1] ── */
/* ── [R2] the vehicle · the turret · sync (owner: world/rover Rover) ── */
/** Top speed (m/s) of the patrol loop and of a paid trip · acceleration · braking (m/s²). */
export const ROVER_PATROL_SPEED = K.num('ROVER_PATROL_SPEED');
export const ROVER_TRIP_SPEED = K.num('ROVER_TRIP_SPEED');
export const ROVER_ACCEL = K.num('ROVER_ACCEL');
export const ROVER_BRAKE = K.num('ROVER_BRAKE');
/** Turn-in-place rate (rad/s) · the alignment angle (rad) that allows departure. */
export const ROVER_TURN_RATE = K.num('ROVER_TURN_RATE');
export const ROVER_ALIGN_EPS = K.num('ROVER_ALIGN_EPS');
/** Seats · boarding interaction distance (m) · the host's distance test on a boarding request (m). */
export const ROVER_SEATS = K.num('ROVER_SEATS');
export const ROVER_BOARD_RANGE = K.num('ROVER_BOARD_RANGE');
export const ROVER_BOARD_CHECK_RANGE = K.num('ROVER_BOARD_CHECK_RANGE');
/** Default distance (m) of the riding orbit camera. */
export const ROVER_CAMERA_DISTANCE = K.num('ROVER_CAMERA_DISTANCE');
/** The body's half-length · half-width · full height · collider height (m). */
export const ROVER_HALF_LENGTH = K.num('ROVER_HALF_LENGTH');
export const ROVER_HALF_WIDTH = K.num('ROVER_HALF_WIDTH');
export const ROVER_HEIGHT = K.num('ROVER_HEIGHT');
export const ROVER_HULL_H = K.num('ROVER_HULL_H');
/** The turret: range (m) · damage per shot · interval (s) · retarget (s) · turn rate (rad/s) · firing cone (rad). */
export const ROVER_TURRET_RANGE = K.num('ROVER_TURRET_RANGE');
export const ROVER_TURRET_DAMAGE = K.num('ROVER_TURRET_DAMAGE');
export const ROVER_TURRET_INTERVAL_S = K.num('ROVER_TURRET_INTERVAL_S');
export const ROVER_TURRET_RETARGET_S = K.num('ROVER_TURRET_RETARGET_S');
export const ROVER_TURRET_TURN_RATE = K.num('ROVER_TURRET_TURN_RATE');
export const ROVER_TURRET_AIM_CONE = K.num('ROVER_TURRET_AIM_CONE');
/** Ramming: minimum speed (m/s) · damage to enemies · knockback (m/s) · per-target cooldown (s). */
export const ROVER_HIT_SPEED_MIN = K.num('ROVER_HIT_SPEED_MIN');
export const ROVER_HIT_DAMAGE = K.num('ROVER_HIT_DAMAGE');
export const ROVER_HIT_KNOCKBACK = K.num('ROVER_HIT_KNOCKBACK');
export const ROVER_HIT_COOLDOWN_S = K.num('ROVER_HIT_COOLDOWN_S');
/** Broadcast interval (s) · the client's snap distance (m). */
export const ROVER_NET_INTERVAL = K.num('ROVER_NET_INTERVAL');
export const ROVER_SNAP_M = K.num('ROVER_SNAP_M');
/** How far (m) the step-off spot sits from the body's edge. */
export const ROVER_EXIT_GAP_M = K.num('ROVER_EXIT_GAP_M');
/** Minimum interval (s) between the vehicle's hit sounds (audio). */
export const ROVER_CLANG_GAP_S = K.num('ROVER_CLANG_GAP_S');
/* ── end [R2] ── */
/* ── [R3] riding mode · the orbit camera (owner: player) ── */
/** Elevation range · starting value of the orbit camera (degrees, from the focus point). */
export const ROVER_CAM_ELEV_MIN_DEG = K.num('ROVER_CAM_ELEV_MIN_DEG');
export const ROVER_CAM_ELEV_MAX_DEG = K.num('ROVER_CAM_ELEV_MAX_DEG');
export const ROVER_CAM_ELEV_START_DEG = K.num('ROVER_CAM_ELEV_START_DEG');
/** Wheel zoom in / out range (as a multiple of the default distance) · the ratio of one notch · the damping rate it eases back at after a collision. */
export const ROVER_CAM_ZOOM_MIN_MUL = K.num('ROVER_CAM_ZOOM_MIN_MUL');
export const ROVER_CAM_ZOOM_MAX_MUL = K.num('ROVER_CAM_ZOOM_MAX_MUL');
export const ROVER_CAM_ZOOM_STEP = K.num('ROVER_CAM_ZOOM_STEP');
export const ROVER_CAM_ZOOM_RATE = K.num('ROVER_CAM_ZOOM_RATE');
/** Position follow damping rate · collision padding (m) · minimum distance (m) · minimum height above the terrain (m). */
export const ROVER_CAM_SMOOTH_RATE = K.num('ROVER_CAM_SMOOTH_RATE');
export const ROVER_CAM_COLLISION_PAD = K.num('ROVER_CAM_COLLISION_PAD');
export const ROVER_CAM_MIN_DIST = K.num('ROVER_CAM_MIN_DIST');
export const ROVER_CAM_FLOOR = K.num('ROVER_CAM_FLOOR');
/** Where a save while riding, or a forced release, puts the body (m, to the right of the vehicle). */
export const ROVER_SAFE_SIDE_M = K.num('ROVER_SAFE_SIDE_M');
/** Extra seconds a remote squadmate's avatar stays hidden after they step off. */
export const ROVER_REMOTE_EXIT_HIDE_S = K.num('ROVER_REMOTE_EXIT_HIDE_S');
/* ── end [R3] ── */
/* ── [R4] enemies target the vehicle (owner: enemies) ── */
/** Seconds an enemy hit by the vehicle (and its group) keeps targeting it. */
export const ROVER_AGGRO_S = K.num('ROVER_AGGRO_S');
/** Radius (m) of the same-faction group that starts targeting the vehicle along with the enemy it hit. */
export const ROVER_AGGRO_GROUP_RADIUS = K.num('ROVER_AGGRO_GROUP_RADIUS');
/** Distance (m) at which a standing vehicle is noticed (to the body's edge · line of sight required). */
export const ROVER_NOTICE_STOPPED_M = K.num('ROVER_NOTICE_STOPPED_M');
/* ── end [R4] ── */
/* ── end 2026-09-13 the rover ── */

/* ── 2026-09-13 library series · video games · the cooking / research skills (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」) ── */
/** The library series' share — short of the full set, each distinct volume shelved gives this much of the full-set bonus (`librarySeriesFraction`). */
export const SHELF_SERIES_VOLUME_SHARE = K.num('SHELF_SERIES_VOLUME_SHARE');
/** Slots of one game disc stand (`SHELF_SLOTS.game`). */
export const GAME_DISC_SLOTS_PER_STAND = K.num('GAME_DISC_SLOTS_PER_STAND');
/** Score added to a cooking step at max cooking skill (`derived.cookScoreBonus`). */
export const COOK_SKILL_SCORE_AT_MAX = K.num('COOK_SKILL_SCORE_AT_MAX');
/** Cooking skill XP per cook (× max(0.25, score)). */
export const COOK_SKILL_XP = K.num('COOK_SKILL_XP');
/** The fraction analysis time is cut by at max research skill (`derived.researchTimeMul` = 1 − this × the skill fraction). */
export const RESEARCH_TIME_AT_MAX = K.num('RESEARCH_TIME_AT_MAX');
/** Material refund chance at max research skill (`derived.researchRefundChance`). */
export const RESEARCH_REFUND_CHANCE_AT_MAX = K.num('RESEARCH_REFUND_CHANCE_AT_MAX');
/** The refund fraction — at skill 0 / at max (`derived.researchRefundFrac`). */
export const RESEARCH_REFUND_FRAC_MIN = K.num('RESEARCH_REFUND_FRAC_MIN');
export const RESEARCH_REFUND_FRAC_MAX = K.num('RESEARCH_REFUND_FRAC_MAX');
/** Research skill XP — per analyzer slot collected / per item crafted at a lab bench. */
export const RESEARCH_XP_ANALYSIS = K.num('RESEARCH_XP_ANALYSIS');
export const RESEARCH_XP_CRAFT = K.num('RESEARCH_XP_CRAFT');
/* ── end 2026-09-13 library series ── */

/* ── 2026-09-14 the tutorial rework · fall damage (docs/DECISIONS.md 「2026-09-14 — 튜토리얼 개편」) ── */
/** The height (m) at which fall damage starts — up to this it is free. */
export const FALL_DAMAGE_SAFE_M = K.num('FALL_DAMAGE_SAFE_M');
/** Damage per metre past the safe height (shield first, then hp). */
export const FALL_DAMAGE_PER_M = K.num('FALL_DAMAGE_PER_M');
/** Cap on the damage one fall may deal. */
export const FALL_DAMAGE_MAX = K.num('FALL_DAMAGE_MAX');
/** Sense radius · leash distance (m) of the tutorial-only enemies. */
export const TUTORIAL_ENEMY_SENSE_M = K.num('TUTORIAL_ENEMY_SENSE_M');
export const TUTORIAL_ENEMY_LEASH_M = K.num('TUTORIAL_ENEMY_LEASH_M');
/** Seconds from a tutorial death to the checkpoint respawn. */
export const TUTORIAL_RESPAWN_DELAY_S = K.num('TUTORIAL_RESPAWN_DELAY_S');
/** Length (s) of the opening wake-up cinematic — the value passed to `PlayerRef.playIntroWake`. */
export const TUTORIAL_INTRO_WAKE_S = K.num('TUTORIAL_INTRO_WAKE_S');
/** appended (2026-09-14): seconds the compass takes to appear once the wake-up cinematic ends — `ui/hud/Compass` raises the opacity in code. */
export const TUTORIAL_COMPASS_FADE_S = K.num('TUTORIAL_COMPASS_FADE_S');
/** appended (2026-09-16): seconds the crosshair takes to appear once the wake-up cinematic ends — `ui/hud/Reticle` raises the opacity in code. */
export const TUTORIAL_RETICLE_FADE_S = K.num('TUTORIAL_RETICLE_FADE_S');
/** XP awarded for finishing the tutorial raid (enough to reach level 2). */
export const TUTORIAL_RAID_XP = K.num('TUTORIAL_RAID_XP');
/**
 * Body height per stance (clearance above the feet, m) — the value passed to
 * `WorldRef.resolveCollision(pos, r, height?)`. Nothing is passed while standing (= `BOX_HEADROOM`), so not one
 * route in the main game changes.
 */
export const PLAYER_CROUCH_CLEARANCE_M = K.num('PLAYER_CROUCH_CLEARANCE_M');
export const PLAYER_PRONE_CLEARANCE_M = K.num('PLAYER_PRONE_CLEARANCE_M');
/**
 * **Retired** (2026-09-14 2nd pass, user's decision — 「the player starts at full hp, not a sliver, and respawns at
 * full hp too」). Nothing reads it. The name stays because it is a contract (the same treatment as `airstrike` ·
 * `secondary` — `src/shared` is add-only). The tutorial's tension now comes from **fall damage**, and the bandage of
 * the `heal` step puts the lost hp back.
 */
export const TUTORIAL_START_HP = K.num('TUTORIAL_START_HP');
/* ── end 2026-09-14 the tutorial ── */

/* ── 2026-09-15 fall feedback · fire zones · the soldier rim light (docs/TODO.md B-14 · B-16 · D-7) ── */
/** Fall damage → `camera:shake` (owner: player `parts/Fall`). intensity = min(MAX, damage × PER_DAMAGE). */
export const FALL_SHAKE_PER_DAMAGE = K.num('FALL_SHAKE_PER_DAMAGE');
export const FALL_SHAKE_MAX = K.num('FALL_SHAKE_MAX');
export const FALL_SHAKE_S = K.num('FALL_SHAKE_S');
/** The red fall vignette (owner: ui). Strength = min(1, damage / FULL_DAMAGE); it fades out over `FALL_VIGNETTE_S`. */
export const FALL_VIGNETTE_S = K.num('FALL_VIGNETTE_S');
export const FALL_VIGNETTE_FULL_DAMAGE = K.num('FALL_VIGNETTE_FULL_DAMAGE');
/** Range (m) of a squadmate's landing sound — player filters `FallMessage` by it and audio uses it for the falloff. */
export const FALL_REMOTE_SOUND_RANGE = K.num('FALL_REMOTE_SOUND_RANGE');
/** Fire zone of the G-10 incendiary grenade — the gadget that makes it is `GadgetId 'incendiary'` (2026-09-15 fire merge; `'grenadeFire'` survives in `GadgetId` only as a retired marker with no definition, like `'airstrike'` · `'secondary'`). */
export const GRENADE_INCENDIARY_RADIUS = K.num('GRENADE_INCENDIARY_RADIUS');
export const GRENADE_INCENDIARY_DURATION = K.num('GRENADE_INCENDIARY_DURATION');
/** Blast of the G-10 incendiary grenade (weapons `Grenade`) — the small blast used instead of the high-explosive `GRENADE_DAMAGE` / `GRENADE_RADIUS`. */
export const GRENADE_INCENDIARY_BLAST_DAMAGE = K.num('GRENADE_INCENDIARY_BLAST_DAMAGE');
export const GRENADE_INCENDIARY_BLAST_RADIUS = K.num('GRENADE_INCENDIARY_BLAST_RADIUS');
/** Shared by every fire zone — crackle interval · the height at which a drone burns · the HUD display range (enemies · gadgets · ui). */
export const FIRE_ZONE_CRACKLE_S = K.num('FIRE_ZONE_CRACKLE_S');
export const FIRE_ZONE_DRONE_HEIGHT = K.num('FIRE_ZONE_DRONE_HEIGHT');
export const FIRE_ZONE_DANGER_RANGE = K.num('FIRE_ZONE_DANGER_RANGE');
/** The soldier rim light (owner: player `SoldierModel`). */
export const SOLDIER_RIM_STRENGTH = K.num('SOLDIER_RIM_STRENGTH');
export const SOLDIER_RIM_POWER = K.num('SOLDIER_RIM_POWER');
/* ── end 2026-09-15 ── */
/* ── appended (2026-09-15): the tutorial respawn cinematic · chained bug spawns · dropping aggro · firing at the liftoff ── */
/** Tutorial respawn — seconds of getting up from the fallen pose (owner: player `parts/IntroWake`; caller: game `parts/Death.tutorialRespawn`). */
export const TUTORIAL_RESPAWN_WAKE_S = K.num('TUTORIAL_RESPAWN_WAKE_S');
/** The tutorial's bug ambush — seconds from the first bug to the next (owner: enemies `Tutorial.ts`). */
export const TUTORIAL_BUG_CHAIN_SPAWN_S = K.num('TUTORIAL_BUG_CHAIN_SPAWN_S');
/** The tutorial's liftoff firing window · its range (owner: enemies `Tutorial.ts`). */
export const TUTORIAL_LIFTOFF_FIRE_S = K.num('TUTORIAL_LIFTOFF_FIRE_S');
export const TUTORIAL_LIFTOFF_FIRE_RANGE_M = K.num('TUTORIAL_LIFTOFF_FIRE_RANGE_M');
/** The drop height at which a cliff fall clears aggro (owner: enemies `Tutorial.ts`). */
export const TUTORIAL_AGGRO_DROP_M = K.num('TUTORIAL_AGGRO_DROP_M');
/** 2026-09-16: how far back from a cliff edge a tutorial enemy stands (owner: enemies `Tutorial.ts` `tutorialEdgeGuard`). */
export const TUTORIAL_ENEMY_EDGE_MARGIN_M = K.num('TUTORIAL_ENEMY_EDGE_MARGIN_M');
/* ── end 2026-09-15 the tutorial respawn · aggro ── */

/* ── 2026-09-15 android squadmates · raid entry loading (docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」; the contract is `shared/allies.ts`) ── */
import type { AllyStateId } from './allies';
/** Hp multiplier · the downed bleed pool · hp after being revived (owner: allies). */
export const ALLY_HP_MUL = K.num('ALLY_HP_MUL');
export const ALLY_DOWN_HP = K.num('ALLY_DOWN_HP');
export const ALLY_REVIVE_HP = K.num('ALLY_REVIVE_HP');
/** Movement (m/s, rad/s). */
export const ALLY_WALK_SPEED = K.num('ALLY_WALK_SPEED');
export const ALLY_RUN_SPEED = K.num('ALLY_RUN_SPEED');
export const ALLY_CARRY_SPEED = K.num('ALLY_CARRY_SPEED');
export const ALLY_TURN_RATE = K.num('ALLY_TURN_RATE');
/** The harness — radius · the floor it shrinks to while the leader moves one way · the commitment time constant · the speed that counts as moving · the distance below which they stop closing in. */
export const ALLY_HARNESS_RADIUS_M = K.num('ALLY_HARNESS_RADIUS_M');
export const ALLY_HARNESS_MIN_FRAC = K.num('ALLY_HARNESS_MIN_FRAC');
export const ALLY_HARNESS_COMMIT_TAU_S = K.num('ALLY_HARNESS_COMMIT_TAU_S');
export const ALLY_HARNESS_COMMIT_SPEED = K.num('ALLY_HARNESS_COMMIT_SPEED');
export const ALLY_FOLLOW_NEAR_M = K.num('ALLY_FOLLOW_NEAR_M');
/** Reaction delay — seconds at weight 0 / 1 · the random share. The per-state weight is `ALLY_STATE_WEIGHT`. */
export const ALLY_REACT_MIN_S = K.num('ALLY_REACT_MIN_S');
export const ALLY_REACT_MAX_S = K.num('ALLY_REACT_MAX_S');
export const ALLY_REACT_JITTER = K.num('ALLY_REACT_JITTER');
/** Behaviour weight per state, 0..1 (`data/tables.csv` `ALLY_STATE_WEIGHT`) — a missing state is 0. */
export const ALLY_STATE_WEIGHT: Readonly<Partial<Record<AllyStateId, number>>> = numberMap<AllyStateId>('tables.csv', 'ALLY_STATE_WEIGHT');
/** First-come cooldown on requests · the extraction confirmation window (s). */
export const ALLY_REQUEST_COOLDOWN_S = K.num('ALLY_REQUEST_COOLDOWN_S');
export const ALLY_EXTRACT_CONFIRM_S = K.num('ALLY_EXTRACT_CONFIRM_S');
/** Combat — sense radius · range (m) · aim error (°) · damage multiplier · rounds per burst · the pause between bursts · the enemy ping interval. */
export const ALLY_SENSE_RADIUS_M = K.num('ALLY_SENSE_RADIUS_M');
export const ALLY_FIRE_RANGE_M = K.num('ALLY_FIRE_RANGE_M');
export const ALLY_AIM_ERROR_DEG = K.num('ALLY_AIM_ERROR_DEG');
export const ALLY_DAMAGE_MUL = K.num('ALLY_DAMAGE_MUL');
export const ALLY_BURST_MIN = K.num('ALLY_BURST_MIN');
export const ALLY_BURST_MAX = K.num('ALLY_BURST_MAX');
export const ALLY_BURST_PAUSE_S = K.num('ALLY_BURST_PAUSE_S');
export const ALLY_ENEMY_PING_COOLDOWN_S = K.num('ALLY_ENEMY_PING_COOLDOWN_S');
/** Looting · handing over — seconds per cell · reach · the distance to stand beside the requester · the look dot product · the speed that counts as still · the max wait · the interval before repeating a line. */
export const ALLY_LOOT_ITEM_S = K.num('ALLY_LOOT_ITEM_S');
export const ALLY_LOOT_REACH_M = K.num('ALLY_LOOT_REACH_M');
export const ALLY_DELIVER_RANGE_M = K.num('ALLY_DELIVER_RANGE_M');
export const ALLY_DELIVER_LOOK_DOT = K.num('ALLY_DELIVER_LOOK_DOT');
export const ALLY_DELIVER_STILL_SPEED = K.num('ALLY_DELIVER_STILL_SPEED');
export const ALLY_DELIVER_WAIT_MAX_S = K.num('ALLY_DELIVER_WAIT_MAX_S');
export const ALLY_CHAT_REPEAT_S = K.num('ALLY_CHAT_REPEAT_S');
/** Orders — the arrival distance · how long a `가자` ping is held · the `주의` duration · the `앞장` lead distance. */
export const ALLY_MOVE_ARRIVE_M = K.num('ALLY_MOVE_ARRIVE_M');
export const ALLY_MOVE_HOLD_S = K.num('ALLY_MOVE_HOLD_S');
export const ALLY_WATCH_S = K.num('ALLY_WATCH_S');
export const ALLY_LEAD_AHEAD_M = K.num('ALLY_LEAD_AHEAD_M');
/** Rescue — the radius judged safe · the margin for escaping a hazard (m). */
export const ALLY_RESCUE_SAFE_RADIUS_M = K.num('ALLY_RESCUE_SAFE_RADIUS_M');
export const ALLY_HAZARD_SAFE_MARGIN_M = K.num('ALLY_HAZARD_SAFE_MARGIN_M');
/** Sync interval (s) · the cockpit bay slot hold (s, owner: hub) · the follow distance of the ship cheat (m). */
export const ALLY_NET_INTERVAL_S = K.num('ALLY_NET_INTERVAL_S');
export const ALLY_BAY_HOLD_S = K.num('ALLY_BAY_HOLD_S');
export const ALLY_HUB_FOLLOW_M = K.num('ALLY_HUB_FOLLOW_M');
/** Roaming (2026-09-16, user's decision) — the point-of-interest radius · the distance that counts as taken · the minimum step · how long they look around. */
export const ALLY_ROAM_POI_RADIUS_M = K.num('ALLY_ROAM_POI_RADIUS_M');
export const ALLY_ROAM_POI_TAKEN_M = K.num('ALLY_ROAM_POI_TAKEN_M');
export const ALLY_ROAM_MIN_STEP_M = K.num('ALLY_ROAM_MIN_STEP_M');
export const ALLY_ROAM_PAUSE_MIN_S = K.num('ALLY_ROAM_PAUSE_MIN_S');
export const ALLY_ROAM_PAUSE_MAX_S = K.num('ALLY_ROAM_PAUSE_MAX_S');
/** Keeping apart · spreading out (2026-09-16, user's decision). */
export const ALLY_SEPARATION_M = K.num('ALLY_SEPARATION_M');
export const ALLY_SPREAD_M = K.num('ALLY_SPREAD_M');
/** 「앞장서라」 — the harness multiplier · the auto-release time (s). */
export const ALLY_LEAD_HARNESS_MUL = K.num('ALLY_LEAD_HARNESS_MUL');
export const ALLY_LEAD_DURATION_S = K.num('ALLY_LEAD_DURATION_S');
/** Engage range per weapon — the distance at which damage has fallen to this fraction, and its floor (m). */
export const ALLY_ENGAGE_DAMAGE_FRAC = K.num('ALLY_ENGAGE_DAMAGE_FRAC');
export const ALLY_ENGAGE_MIN_M = K.num('ALLY_ENGAGE_MIN_M');
/** Radius (m) of the crates picked up only while idle — a crate marked with a ping has no limit. */
export const ALLY_IDLE_LOOT_M = K.num('ALLY_IDLE_LOOT_M');
/** Raid entry loading (owner: hub starts the fade to black · game `parts/LoadGate` · the ui ring gauge). */
export const RAID_LOAD_FADE_OUT_S = K.num('RAID_LOAD_FADE_OUT_S');
export const RAID_LOAD_FADE_IN_S = K.num('RAID_LOAD_FADE_IN_S');
export const RAID_LOAD_TIMEOUT_S = K.num('RAID_LOAD_TIMEOUT_S');
export const RAID_LOAD_REPORT_S = K.num('RAID_LOAD_REPORT_S');
export const RAID_LOAD_WORLD_SHARE = K.num('RAID_LOAD_WORLD_SHARE');
export const RAID_LOAD_MIN_BLACK_S = K.num('RAID_LOAD_MIN_BLACK_S');
/** Slack (s) on top of the wait cap — the engine's hold cap, and when a client whose host `go` never arrived releases itself. */
export const RAID_LOAD_HOLD_MARGIN_S = K.num('RAID_LOAD_HOLD_MARGIN_S');
/** Slack (s) spent waiting for the authority's launch after the fade to black finished (owner: hub) — past it the black screen is lifted and the ship comes back. */
export const RAID_LOAD_START_GRACE_S = K.num('RAID_LOAD_START_GRACE_S');
/* ── end 2026-09-15 android squadmates · raid entry loading ── */

/* ══ appended (2026-09-15): the sandworm appearance rule reworked — accumulated probability · summoning by thumper · a young one at threat 1 (owner: enemies/sandworm · world/BurrowGround)
 * docs/DECISIONS.md 「2026-09-15 — 땅굴벌레」. `SANDWORM_WINDOW_*` · `SANDWORM_CHANCE_BY_THREAT` are retired (only the exports stay).
 * The probability table of one check is in the head comment of `src/enemies/sandworm/Director.ts`.
 */
/** Threat multiplier of one check — index 0 = planet threat 1 (`data/tables.csv`). threat 1 > 0 (a young one comes out). */
export const SANDWORM_BASE_CHANCE_BY_THREAT = numberList('tables.csv', 'SANDWORM_BASE_CHANCE_BY_THREAT');
/** Minimum qualifying people needed for a natural appearance (`조금 무거움` or heavier + running, all within `SANDWORM_GROUP_RADIUS` of each other). */
export const SANDWORM_MIN_MEMBERS = K.num('SANDWORM_MIN_MEMBERS');
/** Weight of one qualifying person — light · heavy/over. */
export const SANDWORM_P_PER_LIGHT = K.num('SANDWORM_P_PER_LIGHT');
export const SANDWORM_P_PER_HEAVY = K.num('SANDWORM_P_PER_HEAVY');
/** Distance factor: 1 at an average distance ≤ NEAR, FAR_MUL at GROUP_RADIUS (linear). */
export const SANDWORM_P_NEAR_M = K.num('SANDWORM_P_NEAR_M');
export const SANDWORM_P_FAR_MUL = K.num('SANDWORM_P_FAR_MUL');
/** The lure grenade: the probability it adds · the distance it counts within (m) · the chance it is picked as the eruption spot. */
export const SANDWORM_P_LURE = K.num('SANDWORM_P_LURE');
export const SANDWORM_LURE_RANGE_M = K.num('SANDWORM_LURE_RANGE_M');
export const SANDWORM_LURE_SPOT_CHANCE = K.num('SANDWORM_LURE_SPOT_CHANCE');
/** The young sandworm (`sandworm_weak`): its fixed max hp · body scale · eruption radius multiplier. */
export const SANDWORM_WEAK_HP = K.num('SANDWORM_WEAK_HP');
export const SANDWORM_WEAK_SCALE = K.num('SANDWORM_WEAK_SCALE');
/** `WorldRef.burrowGroundOk`: the bare-ground radius the director demands (m) · ring samples · the height-difference cap (m) · the slope cap · the clearance from a nest (m). */
export const BURROW_GROUND_CHECK_R = K.num('BURROW_GROUND_CHECK_R');
export const BURROW_GROUND_RING_SAMPLES = K.num('BURROW_GROUND_RING_SAMPLES');
export const BURROW_GROUND_MAX_RISE_M = K.num('BURROW_GROUND_MAX_RISE_M');
export const BURROW_GROUND_MAX_SLOPE = K.num('BURROW_GROUND_MAX_SLOPE');
export const BURROW_GROUND_NEST_CLEAR_M = K.num('BURROW_GROUND_NEST_CLEAR_M');
/* ── end 2026-09-15 the sandworm appearance rule rework ── */

/* ── [2026-09-15] the thumper (owner: gadgets — docs/DECISIONS.md 「2026-09-15 — 땅굴벌레 · 진동 장치」) ── */
/** Interval between strikes on the ground (s) · which strike calls the sandworm · the radius the placement test uses (m, `WorldRef.burrowGroundOk`) · durability · shake radius (m) · shake intensity. */
export const THUMPER_INTERVAL_S = K.num('THUMPER_INTERVAL_S');
export const THUMPER_STRIKES = K.num('THUMPER_STRIKES');
export const THUMPER_GROUND_R = K.num('THUMPER_GROUND_R');
export const THUMPER_HP = K.num('THUMPER_HP');
export const THUMPER_SHAKE_RADIUS = K.num('THUMPER_SHAKE_RADIUS');
export const THUMPER_SHAKE = K.num('THUMPER_SHAKE');
/* ── end 2026-09-15 the thumper ── */

/* ── 2026-09-16 the control guide of the tutorial's crawl section (owner: tutorial `TutorialSystem.pollCrawlHint`) ── */
/** Past this fraction of the collapsed passage the fire · aim rows are added to the control guide (0 = the entrance · 1 = the exit). */
export const TUTORIAL_CRAWL_AIM_HINT_FRAC = K.num('TUTORIAL_CRAWL_AIM_HINT_FRAC');
/* ── 2026-09-17 the last raid of `증축 안내` (owner: tutorial `TutorialSystem.onBuildRaidEnd`) ── */
/** Extracting while the sale value of the items found in that raid is at least this much completes the last objective of `증축 안내` (credits). */
export const TUTORIAL_RAID_EXTRACT_VALUE_C = K.num('TUTORIAL_RAID_EXTRACT_VALUE_C');

/* ── 2026-09-16 the messenger button's red dot pop (owner: ui — `hud/Community`) ── */
/** Seconds the messenger button's red dot takes to pop up and settle back on a new NPC message. It stands in for a toast. */
export const MESSENGER_DOT_POP_S = K.num('MESSENGER_DOT_POP_S');
/** Height (px) of that first peak. */
export const MESSENGER_DOT_POP_PX = K.num('MESSENGER_DOT_POP_PX');
