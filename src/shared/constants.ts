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
  RELOAD: 'KeyR', INTERACT: 'KeyE', STIM: 'KeyF', GRENADE: 'KeyG',
  /** Weapon package: 1 = 주무기 I, 2 = 주무기 II, 3 = 보조무기, Q = previous weapon. */
  PRIMARY: 'Digit1', PRIMARY2: 'Digit2', SECONDARY: 'Digit3', SWAP: 'KeyQ',
  INVENTORY: 'Tab', ROTATE_ITEM: 'KeyR', MENU: 'Escape', MAP: 'KeyM',
  /* appended: X drops the hovered/selected inventory item; Enter opens text chat. */
  DROP_ITEM: 'KeyX', CHAT: 'Enter',
  /* appended (Phase 2): F = quick use (tap: last item in hand, hold: wheel). STIM is kept as an alias of the same key.
     G is reserved for the Phase 3 ship-call wheel (grenades are thrown from the hand now). Space respawns when allowed / gives up while downed (hold). */
  QUICK: 'KeyF', RESPAWN: 'Space', GIVE_UP: 'Space',
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
export const QUICK_USABLE_CATEGORIES: readonly string[] = ['grenade', 'stim'];
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
