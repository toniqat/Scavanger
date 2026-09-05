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
  PRIMARY: 'Digit1', SECONDARY: 'Digit2', SWAP: 'KeyQ',
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
