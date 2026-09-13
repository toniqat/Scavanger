import * as THREE from 'three';
import type { GameContext, KeyGuideEntry } from '@/shared';
import {
  FURNITURE_DEF_MAP, HOUSING_CELL_SIZE, HOUSING_MOVE_HOLD_S, Keys, MouseButtons, ROOM_PURPOSE_LABEL_KO, furnitureFootprint, keyLabel, roomGridSize,
} from '@/shared';
import { COCKPIT_ONLY_RECOVER_REASON, isCockpitOnlyFurniture } from '@/shared';
import { GHOST_BAD, GHOST_OK, buildFurniture, type FurnitureLayer, type FurnitureModel } from './interiors/Furniture';
import { ROOM_DEPTH, roomBox, roomCellToWorld, yawToRotation, type RoomBox } from './interiors/RoomLayout';
import type { PersonalShip } from './interiors/PersonalShip';

/**
 * 2026-09-12 (사용자 결정 — 꾹 눌러 옮기기): the hold gauge is not announced for a plain click. `housing:moveHold` starts
 * only once the press has lasted this fraction of `HOUSING_MOVE_HOLD_S`, so ui/'s cursor ring does not blink on every
 * selection click. UI timing, not balance.
 */
const HOLD_GAUGE_MIN_PROGRESS = 0.15;

/**
 * Cursor speed: metres of room floor per pixel of pointer-locked mouse movement (the 방 콘솔 path only — 시설 관리
 * ray-casts the free cursor and needs no rate). 2026-09-12: a fraction of `ROOM_DEPTH` rather than the literal
 * 0.012, so crossing the room still takes the same mouse travel now that it is twice as wide.
 */
const CURSOR_M_PER_PX = ROOM_DEPTH * 0.003;   // was 0.012 at ROOM_DEPTH 4
/**
 * 배치 취소 key (Phase 8). Fixed to `KeyC` by the design brief — the movement keys are off in housing mode, so it
 * never collides with `Keys.CROUCH`; it is deliberately not a rebindable action.
 */
const CANCEL_KEY = 'KeyC';
/**
 * UI blocker token held for the whole 함선 관리 session (Phase 8). The mode is driven with a **cursor** (the
 * `ui/hud/ShipManage` 방 목록 / 가구 카드 바 are clickable DOM), and without a token `ctx.isControlActive()` would
 * stay true and `player/`'s click-to-relock fallback would fight for the pointer. Its own token is ignored by this
 * controller (see `blockedByPanel`).
 *
 * **Phase 10**: the pointer lock is **kept** — `ctx.input.setCursorMode(true, MANAGE_BLOCKER)` drives the software
 * cursor (`shared/cursor.ts`) from the raw locked deltas instead of handing the OS cursor back.
 */
const MANAGE_BLOCKER = 'shipmanage';
/**
 * Camera over the room: how far **toward +X** from the room centre, and how high.
 *
 * Phase 10: the eye used to be `cx − rb.side · CAM_TOWARD_DOOR`, i.e. over each room's *own* door wall. `rb.side` is
 * −1 for rooms 0–4 and +1 for rooms 5–9, so both halves of the ship were seen with their door at the bottom of the
 * screen and therefore read 180° apart. The **port** convention is now used for every room (eye on the +X side of the
 * room looking −X), so a starboard room is seen from the outer hull toward the corridor and its door sits at the
 * **top** of the screen. The starboard eye (`cx + 2.2` = 6.0 for rooms 5–9) is inside the outer hull slab in XZ, but
 * `CAM_HEIGHT` is well above `CEIL` (3.2) and the ceiling plane is back-face culled from above, so nothing occludes
 * the floor.
 *
 * **2026-09-12**: both were literals (2.2 · 6.6) tuned for a 4 × 4 m room. The room is 8 × 8 m now, and the near
 * edge of the floor (screen bottom = world +X) sat at 34.2° off the view axis — a hair inside the 35° half-FOV,
 * i.e. the ghost and the footprint frame were falling off the bottom of the screen. They are **fractions of
 * `ROOM_DEPTH`** instead, so the framing is pixel-for-pixel the old one at any grid size.
 */
const CAM_TOWARD_FRAC = 0.55;   // × span — was 2.2 at ROOM_DEPTH 4
const CAM_HEIGHT_FRAC = 1.65;   // × span — was 6.6 at ROOM_DEPTH 4
/**
 * 2026-09-12 (조종석도 꾸민다): the framing scales with the **longer side** of the edit area — `ROOM_DEPTH` (8 m) for a
 * room, so rooms look exactly as before, and 10 m for the 10 × 6 m cockpit (its long side runs along X, i.e. up the
 * screen in this camera convention).
 */
function camSpan(rb: RoomBox): number { return Math.max(ROOM_DEPTH, rb.maxX - rb.minX, rb.maxZ - rb.minZ); }
/** Exponential rate the camera glides to another room's goal while 시설 관리 is already open. Higher = snappier. */
const CAM_GLIDE = 5.0;

type Yaw = 0 | 1 | 2 | 3;
interface Carry { uid: string; defId: string; yaw: Yaw; level: number }

const _cam = new THREE.Vector3();
const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();
/** 함선 관리 cursor picking (free mouse → deck plane). */
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();

/**
 * 3D side of housing mode (`housing:modeChanged {active:true, room}` → this; the rules live in `ctx.housing`).
 * Controls off, oblique top-down camera **on the room's +X side looking −X** (`setCameraOverride`, blended; one
 * convention for every room since Phase 10 — see `CAM_TOWARD_DOOR`), the pointer **stays locked** and its deltas move
 * a floor cursor over the `ROOM_GRID_COLS × ROWS` grid. A ghost of `ctx.housing.selectedFurniture` (or of a picked-up piece) follows the
 * cursor, green / red by `canPlace`.
 *   LMB (`Keys.FIRE`)         place the selection · pick up the piece under the cursor · put a picked-up piece down (`move`)
 *   R   (`Keys.ROTATE_ITEM`)  rotate the selection / the carried piece
 *   X   (`Keys.DROP_ITEM`)    recover the piece under the cursor (→ furniture storage)
 *   wheel / [ ]               cycle the selection through the furniture storage (null = cursor only)
 *   C   (`CANCEL_KEY`)        cancel the current selection / put a carried piece back — and, with an empty
 *                             cursor, leave the mode just like Esc (Phase 8 UI pass)
 *   Esc (`Keys.MENU`)         same as C, but through the shared 닫기 스택 (2026-09-09): the mode registers its own
 *                             cancel with `ctx.escape`, so a panel opened **on top** of it closes first
 *   M (`Keys.MAP`)            leave 함선 관리 (`closeShipManage`) or plain housing mode (2026-09-08: was Esc)
 *   Tab (`Keys.INVENTORY`)    same as M (2026-09-09: Tab closes every screen / mode). Consumed, so the inventory —
 *                             which polls the key after `HubSystem` — never opens on the press that left the mode.
 * Emits `housing:cursorChanged {room, x, y, valid}` whenever the footprint cell or its validity changes.
 * **키 가이드 (2026-09-09)**: while active the mode owns the bottom-right guide line (`ui:keyGuide`, owner
 * `'housing'`): `LMB 설치 · R 회전 · X 회수 · 휠 선택 · C 취소` with the labels read live (re-emitted on
 * `input:bindingsChanged`); the guide appends `Tab 닫기` itself. This replaced the old `ui/hud/HousingHint` bar.
 *
 * **함선 관리 (Phase 8)**: `housing:shipManageChanged {active, room}` enters the same camera / cursor from
 * anywhere in the ship (no "stand in the room" gate — housing owns that rule) and retargets the camera when
 * `ctx.housing.setManageRoom` moves the edit room. Phase 9 UI pass: that retarget **glides** — the override pose
 * handed to the rig eases toward the new room every frame (`glideCamera`), instead of jumping there in one frame
 * (the rig only blends the override *weight*, which is long since 1 by then).
 *
 * **2026-09-12 (사용자 결정 — 선택과 위치 이동을 가른다, 시설 관리에서만):** 놓인 가구를 **LMB 로 한 번 누르면
 * 선택만** 된다 (`housing:furnitureSelected` → `ui/hud/ShipManage` 인스펙터). 곧바로 집어 드는 경로는 없어졌다.
 * 옮기려면 **위치 이동 상태**에 들어간다 — 인스펙터의 `위치 이동` 버튼(`housing:moveRequested`) 또는 선택한 채 **E**.
 * 가구 창고에서 카드를 골라 새로 놓는 것(`housing.selectedFurniture`)도 같은 상태다. 그 안에서만 LMB 설치 · R 회전 ·
 * X 회수가 듣고(키 가이드도 그 셋만 보인다), 밖에서는 선택이 있을 때 `E 위치 이동` 하나가 보인다. 놓을 수 없는 곳을
 * 누르면 거부음 + `housing:placeRefused {reason}` (인스펙터 위 토스트), 놓을 수 있는 곳을 누르면 놓이고 상태가 끝난다.
 * C / Esc 는 들고 있던 것을 제자리로 되돌린다 (놓인 조각은 옮기는 동안에도 상태에서 빠지지 않는다). 커서를 가구
 * 중앙으로 옮기는 기능은 없다 — 브라우저가 OS 커서를 옮기지 못해 요청에서 뺐다. 방 콘솔 모드(`manage` false)는
 * 예전 그대로 클릭 = 집기 · 놓기, X = 커서 밑 회수, 휠 = 창고 순환이다.
 *
 * **2026-09-12 (같은 날 두 번째 묶음, 사용자 결정):** ① **조종석**(`COCKPIT_ROOM_INDEX`)도 편집 공간이다 — 방 상자 · 격자는
 * `roomBox` · `roomGridSize`, 카메라 틀은 `camSpan`. ② 모드 동안에만 바닥 격자선을 켠다(`PersonalShip.setGridVisible`).
 * ③ **꾹 눌러 옮기기** — 조각 위에서 LMB 를 `HOUSING_MOVE_HOLD_S` 누르고 있으면 위치 이동 상태(`housing:moveHold` 로 커서
 * 게이지). ④ **외곽선** — 커서 밑 조각은 `ctx.outline` 의 `hover`, 선택한 조각은 `selected`. ⑤ 키 가이드의 위치 이동 줄은
 * `E 또는 LMB(꾹)` (`KeyGuideEntry.alt`).
 */
export class HousingMode {
  active = false;
  room = -1;
  /** True while the session was entered through 함선 관리 (M) rather than a room console. */
  manage = false;
  /** Top-left cell of the current footprint (debug / smoke). */
  readonly cell = { x: -1, y: -1, valid: false };
  /**
   * 2026-09-07: false while the 함선 관리 cursor points **outside** the edit room. The deck ray is still clamped into
   * the room (so the ghost has a defined pose), but the cyan cell frame, the furniture ghost and every placement
   * action are suppressed — the highlight used to stick to the nearest edge cell while the player was clearly
   * pointing at the corridor or another room.
   */
  private cursorInRoom = true;

  private ship: PersonalShip | null = null;
  private layer: FurnitureLayer | null = null;
  private unsubs: Array<() => void> = [];
  private readonly cursor = new THREE.Vector3();
  /** Live override pose handed to the rig, and the goal it eases toward when the edit room changes. */
  private readonly camPos = new THREE.Vector3();
  private readonly lookPos = new THREE.Vector3();
  private readonly camGoal = new THREE.Vector3();
  private readonly lookGoal = new THREE.Vector3();
  private carry: Carry | null = null;
  /**
   * B-13 (2026-09-11): the piece the 클릭 인스펙터 is showing, so `housing:furnitureSelected` is emitted only on a
   * real change. **Read-only** — nothing in this controller acts on it; `ui/hud/ShipManage` owns the panel.
   */
  private selectedUid: string | null = null;
  /** 2026-09-12: last key guide / move state emitted (both are re-sent only on a real change). */
  private guideKey = '';
  private moveKey = '0';
  private ghost: FurnitureModel | null = null;
  private ghostKey = '';
  private ghostValid: boolean | null = null;
  private readonly frame: THREE.Mesh;
  private readonly frameMat: THREE.MeshBasicMaterial;

  /**
   * Mouse buttons / wheel notches seen this frame. 함선 관리 runs in 커서 모드, where `Input` deliberately keeps the
   * gameplay button sets empty (the press belongs to whatever the cursor is over), so the placement click and the
   * selection wheel are collected straight off the DOM instead. `update()` ORs this with the native `Input` path, so
   * the mode also works with the pointer still locked (the pre-cursor-mode entry paths and the headless smokes).
   *
   * 2026-09-07: these used to accept **only** the synthesised soft-cursor events; with the real cursor back they take
   * the genuine ones.
   */
  private readonly softPressed = new Set<number>();
  private softWheel = 0;
  /**
   * 2026-09-12 (꾹 눌러 옮기기): LMB is **physically down** right now. Armed only by a real `pointerdown` (a browser click
   * sends pointerdown → mousedown → pointerup → mouseup; the headless smokes that synthesise a bare `mousedown` never arm
   * a hold, so their clicks stay plain selections) and cleared by `pointerup` / `mouseup` / window `blur`.
   */
  private buttonDown = false;
  /** The placed piece the current LMB hold started on, its held time and whether `housing:moveHold` has been shown. */
  private holdUid: string | null = null;
  private holdT = 0;
  private holdShown = false;
  /** 2026-09-12: objects last handed to `ctx.outline` per channel (the channel is re-set only when they change). */
  private outlineHover: THREE.Object3D | null = null;
  private outlineSel: THREE.Object3D | null = null;
  private readonly onSoftPointerDown = (e: Event): void => {
    if (!this.active) return;
    const btn = (e as MouseEvent).button;
    this.softPressed.add(btn);
    if (e.type === 'pointerdown' && btn === MouseButtons.FIRE) this.buttonDown = true;
  };
  private readonly onSoftPointerUp = (e: Event): void => {
    if ((e as MouseEvent).button === MouseButtons.FIRE) this.buttonDown = false;
  };
  private readonly onBlur = (): void => { this.buttonDown = false; };
  private readonly onSoftWheel = (e: Event): void => {
    if (!this.active) return;
    this.softWheel += Math.sign((e as WheelEvent).deltaY);
  };

  constructor(private readonly ctx: GameContext) {
    this.frameMat = new THREE.MeshBasicMaterial({ color: 0x5fd7ff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.frameMat);
    this.frame.rotation.x = -Math.PI / 2;
    this.frame.renderOrder = 3;
    this.frame.visible = false;
    this.unsubs.push(
      ctx.bus.on('housing:modeChanged', ({ active, room }) => {
        if (active && room !== null) this.activate(room);
        // never clear `manage` here: `deactivate()` reads it to release the 함선 관리 blocker and re-lock the
        // pointer. Clearing it first was the Phase 8 bug where Esc gave the camera back but left the blocker up
        // (no player control, no 시설 관리 hint) — housing emits `modeChanged` before `shipManageChanged`.
        else this.deactivate();
      }),
      // 함선 관리 (M): same camera, software cursor, entered from anywhere; `setManageRoom` re-emits the room.
      ctx.bus.on('housing:shipManageChanged', ({ active, room }) => {
        if (active && room !== null) { this.enterManage(); this.activate(room); }
        else this.deactivate();
      }),
      // 키 가이드 labels follow the live bindings
      ctx.bus.on('input:bindingsChanged', () => { if (this.active) this.emitGuide(true); }),
      // 2026-09-12: ui/ 인스펙터의 `위치 이동` 버튼 — E 와 같은 길
      ctx.bus.on('housing:moveRequested', ({ uid }) => this.beginMove(uid)),
    );
    // Both events, because the two callers differ: a real browser fires `pointerdown` then `mousedown` (the Set
    // below dedupes them inside the frame), while the headless smokes dispatch only `mousedown`.
    window.addEventListener('pointerdown', this.onSoftPointerDown);
    window.addEventListener('mousedown', this.onSoftPointerDown);
    window.addEventListener('wheel', this.onSoftWheel, { passive: true });
    // 2026-09-12: the hold-to-move gauge needs the release too (the soft input above only records presses)
    window.addEventListener('pointerup', this.onSoftPointerUp);
    window.addEventListener('mouseup', this.onSoftPointerUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** The hub hands over the current personal ship (null in the shared ship / outside the hub). */
  setShip(ship: PersonalShip | null, layer: FurnitureLayer | null): void {
    if (this.active) this.deactivate();
    this.clearOutline();
    this.endHold();
    if (this.ship && this.frame.parent) this.frame.removeFromParent();
    this.ship = ship;
    this.layer = layer;
    if (ship) ship.root.add(this.frame);
  }

  /* ── enter / leave ───────────────────────────────────────────────────── */
  /**
   * 함선 관리: take the blocker token and switch to 커서 모드 for the whole session so the 방 목록 / 가구 카드 바 can
   * be clicked. `setCursorMode` releases the pointer lock and hands the real mouse back (2026-09-07 rework).
   * Idempotent — `setManageRoom` re-emits the event on every room change.
   */
  private enterManage(): void {
    this.manage = true;
    if (this.ctx.uiBlockers.has(MANAGE_BLOCKER)) return;
    this.ctx.uiBlockers.add(MANAGE_BLOCKER);
    // 2026-09-09: ESC 는 `ctx.escape` 스택이 부른다 (열린 순서의 역순 — 위에 패널이 떠 있으면 그것이 먼저).
    // 한 번에 한 걸음: 들고 있는 가구 · 골라 둔 선택을 먼저 되돌리고, 빈 커서일 때만 모드를 나간다.
    // 되돌리기만 한 경우는 **`false`** 를 돌려줘 항목을 스택에 남긴다 — 그러지 않으면 다음 ESC 가 아직 살아
    // 있는 모드 위로 일시정지 메뉴를 띄운다 (2026-09-08 에 피하려던 바로 그 상태다).
    this.ctx.escape.push(MANAGE_BLOCKER, () => {
      if (this.cancelSelection()) return false;
      this.exit();
      return true;
    });
    this.ctx.input.setCursorMode(true, MANAGE_BLOCKER);
  }

  /** Enter (or, when already active on another room, retarget to) `room`. The camera blend is the rig's. */
  private activate(room: number): void {
    const ctx = this.ctx;
    const rb = roomBox(room);                // 2026-09-12: a room or the cockpit (`COCKPIT_ROOM_INDEX`)
    if (!this.ship || !rb) { ctx.housing?.exitHousingMode(); return; }
    if (this.active && this.room === room) return;
    const retarget = this.active;
    if (this.manage) this.enterManage();      // `housing:modeChanged` may arrive before `housing:shipManageChanged`
    this.active = true;
    this.room = room;
    this.carry = null;                       // a carried piece belongs to the room it was picked up in
    this.endHold();
    this.select(null);                       // B-13: the inspector never survives a room change
    this.ship.setGridVisible(true);          // 2026-09-12: the floor grid only exists while decorating
    this.cell.x = -1; this.cell.y = -1; this.cell.valid = false;
    const p = ctx.player;
    if (p) {
      p.setControlsEnabled(false);
      const cx = (rb.minX + rb.maxX) / 2, cz = (rb.minZ + rb.maxZ) / 2;
      // start the cursor where the player stands (clamped into the room), else at the room centre
      const inside = !retarget && p.position.x >= rb.minX && p.position.x <= rb.maxX && p.position.z >= rb.minZ && p.position.z <= rb.maxZ;
      this.cursor.set(inside ? p.position.x : cx, 0, inside ? p.position.z : cz);
      // Camera goal over the new room. Entering the mode places it at once (the rig blends the override *weight*
      // in); switching rooms while the mode is already up **glides** there instead — `update()` walks
      // `camPos` / `camLook` toward the goal, so picking another room in the 시설 관리 list flies the camera over
      // the ship rather than cutting to it (Phase 9 UI pass).
      // Phase 10: the port convention for **every** room (eye on the +X side looking −X), so rooms 5–9 look from the
      // outer hull toward the corridor and their door is at the top of the screen like rooms 0–4's.
      const span = camSpan(rb);
      this.camGoal.set(cx + span * CAM_TOWARD_FRAC, span * CAM_HEIGHT_FRAC, cz);
      this.lookGoal.set(cx, 0.2, cz);
      if (!retarget) { this.camPos.copy(this.camGoal); this.lookPos.copy(this.lookGoal); }
      p.setCameraOverride(this.camPos, this.lookPos, false);
    }
    this.cursorInRoom = true;
    this.frame.visible = true;
    this.refresh(true);
    this.syncState(!retarget);
  }

  /* ── 키 가이드 (2026-09-09) ───────────────────────────────────────────── */
  /**
   * The mode's real actions, most important first; `C` is the fixed cancel key (see `CANCEL_KEY`), never rebound.
   * 2026-09-12 — 시설 관리는 상태에 따라 다르다: 위치 이동 상태면 `설치 · 회전 · 회수` 셋만, 아니면 선택한 가구가 있을
   * 때 `E 위치 이동` 하나 (없으면 빈 목록 — 가이드가 `닫기` 만 붙인다). 방 콘솔 모드는 예전 목록 그대로다.
   */
  private guideKeys(): KeyGuideEntry[] {
    if (this.manage) {
      if (this.moving) {
        const keys: KeyGuideEntry[] = [
          { key: keyLabel(Keys.FIRE), label: '설치' },
          { key: keyLabel(Keys.ROTATE_ITEM), label: '회전' },
        ];
        // 2026-09-13: 조종석 전용 시설(시술대 · 컴퓨터)은 회수할 수 없다 — 키 가이드에도 `회수` 가 없다
        if (!this.carry || !isCockpitOnlyFurniture(FURNITURE_DEF_MAP.get(this.carry.defId))) keys.push({ key: keyLabel(Keys.DROP_ITEM), label: '회수' });
        return keys;
      }
      // 2026-09-12: 위치 이동 = E **또는** LMB 꾹 (키 가이드가 두 키캡 사이에 `또는` 을 그린다)
      return this.selectedUid ? [{ key: keyLabel(Keys.INTERACT), label: '위치 이동', alt: [{ key: keyLabel(Keys.FIRE), hold: true }] }] : [];
    }
    return [
      { key: keyLabel(Keys.FIRE), label: '설치' },
      { key: keyLabel(Keys.ROTATE_ITEM), label: '회전' },
      { key: keyLabel(Keys.DROP_ITEM), label: '회수' },
      { key: '휠', label: '선택' },
      { key: keyLabel(CANCEL_KEY), label: '취소' },
    ];
  }

  /** Emit the guide when its content changed (`force` = re-send anyway, e.g. after a rebind). */
  private emitGuide(force = false): void {
    const keys = this.guideKeys();
    const key = keys.map((k) => `${k.key}:${k.label}:${(k.alt ?? []).map((a) => `${a.key}${a.hold ? '⌄' : ''}`).join('/')}`).join('|')
      + (this.carry ? `#${this.carry.defId}` : '');
    if (!force && key === this.guideKey) return;
    this.guideKey = key;
    this.ctx.bus.emit('ui:keyGuide', { owner: 'housing', keys });
  }

  /** 2026-09-12: 시설 관리의 **위치 이동 상태** — 배치된 조각을 들고 있거나, 가구 창고의 가구를 새로 놓는 중. */
  get moving(): boolean {
    return !!this.carry || (this.manage && !!this.ctx.housing?.selectedFurniture);
  }

  /** The uid being moved (debug / smoke); null while idle or while placing a new piece from storage. */
  get movingUid(): string | null { return this.carry?.uid ?? null; }

  /**
   * Re-derive the move state and the key guide after anything that may have changed them. `housing:moveStateChanged`
   * goes out only on a real change; picking a **new** piece from storage closes the 인스펙터 (it describes a placed one).
   */
  private syncState(forceGuide = false): void {
    const selDef = this.ctx.housing?.selectedFurniture ?? null;
    const active = this.active && this.manage && (!!this.carry || !!selDef);
    const defId = active ? (this.carry?.defId ?? selDef) : null;
    const key = active ? `1|${this.carry?.uid ?? ''}|${defId}` : '0';
    if (key !== this.moveKey) {
      this.moveKey = key;
      if (active && !this.carry) this.select(null);
      this.ctx.bus.emit('housing:moveStateChanged', { active, uid: active ? this.carry?.uid ?? null : null, defId });
    }
    if (this.active) this.emitGuide(forceGuide);
  }

  /** Ease the override pose toward the current room's goal; no-op once it has arrived. */
  private glideCamera(dt: number): void {
    const p = this.ctx.player;
    if (!p) return;
    if (this.camPos.distanceToSquared(this.camGoal) < 1e-6 && this.lookPos.distanceToSquared(this.lookGoal) < 1e-6) return;
    const k = 1 - Math.exp(-CAM_GLIDE * Math.min(0.05, dt));
    this.camPos.lerp(this.camGoal, k);
    this.lookPos.lerp(this.lookGoal, k);
    p.setCameraOverride(this.camPos, this.lookPos, false);
  }

  /**
   * Leave the mode: camera back, controls back, 함선 관리 blocker released. The blocker release is **not** gated on
   * `this.active` — `enterManage()` can have taken the token before `activate()` bailed out — so the token can never
   * outlive the mode and strand the player without controls.
   */
  private deactivate(): void {
    const wasManage = this.manage;
    this.manage = false;
    // B-13: leaving 시설 관리 closes the 클릭 인스펙터 (emitted directly — `select` is gated on `manage`, off by now)
    if (this.selectedUid !== null) { this.selectedUid = null; this.ctx.bus.emit('housing:furnitureSelected', { uid: null }); }
    this.endHold();                            // 2026-09-12: a hold in progress never outlives the mode
    this.clearOutline();
    if (this.active) {
      this.active = false;
      this.room = -1;
      this.carry = null;
      this.syncState();                        // 2026-09-12: a move in progress ends with the mode
      this.disposeGhost();
      this.frame.visible = false;
      this.ship?.setGridVisible(false);        // 2026-09-12: the floor grid is a 시설 관리 overlay
      this.ship?.setCockpitCeilingHidden(false);   // 2026-09-13: the cockpit ceiling fades back in
      this.guideKey = '';
      this.ctx.bus.emit('ui:keyGuide', { owner: 'housing', keys: null });
      const p = this.ctx.player;
      if (p && this.ctx.phase === 'hub') {
        p.setCameraOverride(null);
        p.setControlsEnabled(true);
      }
    }
    if (wasManage || this.ctx.uiBlockers.has(MANAGE_BLOCKER)) {
      this.ctx.uiBlockers.delete(MANAGE_BLOCKER);
      this.ctx.escape.remove(MANAGE_BLOCKER);
      this.ctx.input.setCursorMode(false, MANAGE_BLOCKER);
      this.relock();
    }
  }

  /**
   * Back to the walking hub. `main.ts` already re-locks when the last cursor owner leaves; this is the safety net for
   * the paths that leave the mode without going through `setCursorMode` (and it is a no-op while the lock is held).
   */
  private relock(): void {
    queueMicrotask(() => {
      const ctx = this.ctx;
      if (this.active || ctx.phase !== 'hub' || ctx.uiBlockers.size > 0) return;
      ctx.input.requestPointerLock();
    });
  }

  /**
   * Esc / lost pointer lock: ask housing to leave (함선 관리 → `closeShipManage`, room console → `exitHousingMode`);
   * if it stays silent (stub) leave locally and tell the HUD.
   */
  exit(): void {
    const housing = this.ctx.housing;
    const manage = this.manage;
    if (manage && housing && typeof housing.closeShipManage === 'function') housing.closeShipManage();
    else if (housing && typeof housing.exitHousingMode === 'function') housing.exitHousingMode();
    if (this.active && !(housing?.housingMode ?? false)) {
      this.manage = false;
      this.deactivate();
      if (manage) this.ctx.bus.emit('housing:shipManageChanged', { active: false, room: null });
      this.ctx.bus.emit('housing:modeChanged', { active: false, room: null });
    }
  }

  /* ── frame ────────────────────────────────────────────────────────────── */
  update(dt = 0): void {
    if (!this.active) { this.clearSoftInput(); return; }
    const ctx = this.ctx, input = ctx.input;
    const housing = ctx.housing;
    if (ctx.phase !== 'hub' || !this.ship) { this.clearSoftInput(); this.exit(); return; }
    // 2026-09-13 (사용자 결정): 시설 관리가 열려 있는 내내(어느 방을 골랐든) 조종석 천장이 흐려진다 — `deactivate` 가 되돌린다
    this.ship.setCockpitCeilingHidden(this.manage);
    this.glideCamera(dt);
    if (this.blockedByPanel()) { this.clearSoftInput(); return; }   // a DOM panel (console / housing menu) has the input

    const rb = roomBox(this.room);
    if (!rb) { this.clearSoftInput(); this.exit(); return; }
    if (this.manage) {
      // 함선 관리: there is a cursor (the room list / furniture bar are clicked), so the floor cursor follows it —
      // a camera ray onto the deck plane, clamped into the room.
      this.raycastCursor(rb);
    } else if (input.mouseDX !== 0 || input.mouseDY !== 0) {
      // Room console: pointer-locked deltas → room floor. The camera is on the +X side of **every** room looking −X
      // (Phase 10), so screen right = world −Z and screen down = world +X for every room — the mapping the port
      // rooms always had. It used to be multiplied by `rb.side`, which mirrored the starboard rooms along with their
      // mirrored camera; with one camera convention the factor is gone and both groups feel the same.
      this.cursor.z -= input.mouseDX * CURSOR_M_PER_PX;
      this.cursor.x += input.mouseDY * CURSOR_M_PER_PX;
      this.cursor.x = THREE.MathUtils.clamp(this.cursor.x, rb.minX, rb.maxX);
      this.cursor.z = THREE.MathUtils.clamp(this.cursor.z, rb.minZ, rb.maxZ);
      this.cursorInRoom = true;   // the locked-delta cursor can never leave the room
    }

    // keys
    // 2026-09-08: **M leaves the mode**, the same key that entered it (`HubSystem` reads `Keys.MAP` for 함선 관리).
    if (input.wasPressed(Keys.MAP)) { input.consume(Keys.MAP); this.exit(); return; }
    // 2026-09-09: **Tab leaves it exactly like M** (Tab closes every screen / mode). The mode hides the gameplay HUD
    // and `InventorySystem` polls the same key later in the frame, so it is consumed here — the inventory must not
    // open on the press that left 시설 관리.
    if (input.wasPressed(Keys.INVENTORY)) { input.consume(Keys.INVENTORY); this.exit(); return; }
    /*
     * Escape **는 여기서 읽지 않는다** (2026-09-09). 2026-09-08 에는 이 모드가 Escape 를 직접 먹고 소비했다 —
     * 카메라와 조작을 통째로 가져가는 모드 위에 일시정지 메뉴가 쌓이면 플레이어가 두 모드에 동시에 갇혔기
     * 때문이다. 그 예외는 이제 `ctx.escape` 스택이 일반 규칙으로 대신한다: 모드는 열릴 때 자기 닫기를
     * 스택에 올리고(`enter`), `game/escapeKey` 가 **가장 나중에 열린 것 하나**만 닫는다. 여기서 계속 키를
     * 폴링하면 시스템 등록 순서가 이기므로 — `HubSystem` 이 `GameFlowSystem` 보다 먼저 돌아 — 위에 떠 있는
     * 패널보다 모드가 먼저 닫혔다. C 는 그대로 남는다 (모드 전용 취소 키).
     */
    // C: cancel what the cursor holds; with an empty cursor it leaves the mode, exactly like Esc
    if (input.wasPressed(CANCEL_KEY) && !this.cancelSelection()) { this.exit(); return; }
    // 2026-09-12 (시설 관리): E 가 선택한 가구를 위치 이동 상태로 든다. 모드가 E 를 먹는다 — 다른 무엇도 같은 누름을 보지 않는다
    if (this.manage && input.wasPressed(Keys.INTERACT)) {
      input.consume(Keys.INTERACT);
      if (!this.moving && this.selectedUid) this.beginMove(this.selectedUid);
    }
    // R: 시설 관리에서는 위치 이동 상태에서만 돈다 (방 콘솔 모드는 언제나)
    if (input.wasPressed(Keys.ROTATE_ITEM) && (!this.manage || this.moving)) {
      if (this.carry) { this.carry.yaw = ((this.carry.yaw + 1) % 4) as Yaw; this.announceSelection(); }
      else housing?.rotateSelection();
    }
    // a wheel over the furniture bar scrolls that list — it must not cycle the selection as well
    const overUI = this.pointerOverUI();
    // `input.wheelDelta` / `wasMousePressed` are empty while 커서 모드 owns the mouse, so both
    // the native and the synthesised path are read here.
    const wheel = input.wheelDelta !== 0 ? input.wheelDelta : this.softWheel;
    let dir = 0;
    if (!overUI) {
      if (wheel > 0 || input.wasPressed('BracketRight')) dir = 1;
      else if (wheel < 0 || input.wasPressed('BracketLeft')) dir = -1;
    }
    // 2026-09-12: 시설 관리는 휠로 가구 창고를 돌지 않는다 — 새 가구는 카드 → 위치 이동 상태로만 든다
    if (dir !== 0 && !this.carry && !this.manage) this.cycleSelection(dir);

    this.refresh(false);

    // X: 시설 관리에서는 위치 이동 상태에서만 (들고 있는 것을 회수), 방 콘솔 모드는 커서 밑의 조각
    if (input.wasPressed(Keys.DROP_ITEM) && (this.manage ? this.moving : this.cursorInRoom)) this.recoverUnderCursor();
    // a click on the 방 목록 / 가구 카드 바 must not also drop a piece on the floor behind the panel,
    // and a click aimed outside the edit room (no cell highlight) must not place at the clamped edge cell
    const fire = input.wasMousePressed(MouseButtons.FIRE) || this.softPressed.has(MouseButtons.FIRE);
    if (fire && !overUI) {
      if (!this.manage) {
        if (this.cursorInRoom) this.primary();
      } else if (this.moving) {
        this.placeMoving();
      } else {
        // B-13 → 2026-09-12: 위치 이동 상태가 아니면 클릭은 **선택만** 한다 (빈 곳 · 방 밖 = 선택 해제)
        if (this.cursorInRoom) { this.selectUnderCursor(); this.startHold(this.selectedUid); }
        else this.select(null);
      }
    }
    // 2026-09-12: 꾹 눌러 옮기기 (시설 관리) — the press above may have started a hold; this frame advances or ends it
    if (this.manage) this.tickHold(dt, overUI);
    this.syncState();
    if (this.manage) this.syncOutline(overUI);
    this.clearSoftInput();
  }

  private clearSoftInput(): void {
    if (this.softPressed.size) this.softPressed.clear();
    this.softWheel = 0;
  }

  /** Any UI blocker except our own 함선 관리 token (the panels the hub / housing open own the input). */
  private blockedByPanel(): boolean {
    const b = this.ctx.uiBlockers;
    if (b.size === 0) return false;
    return !(b.size === 1 && b.has(MANAGE_BLOCKER));
  }

  /**
   * True while the UI cursor is over the HTML UI (`#ui-root`) — only possible in 함선 관리, the one mode with a
   * cursor. `input.elementUnderCursor()` is `document.elementFromPoint` at the real cursor.
   */
  private pointerOverUI(): boolean {
    if (!this.manage) return false;
    try {
      const e = this.ctx.input.elementUnderCursor();
      return !!e?.closest?.('#ui-root');
    } catch { return false; }
  }

  /** 함선 관리 cursor: UI cursor → NDC on the canvas → camera ray → deck plane (y = 0), clamped into the room. */
  private raycastCursor(rb: RoomBox): void {
    const ctx = this.ctx;
    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    _ndc.set(((ctx.input.uiX - rect.left) / rect.width) * 2 - 1, -((ctx.input.uiY - rect.top) / rect.height) * 2 + 1);
    _ray.setFromCamera(_ndc, ctx.camera);
    const o = _ray.ray.origin, d = _ray.ray.direction;
    if (Math.abs(d.y) < 1e-4) return;
    const t = -o.y / d.y;
    if (!(t > 0)) return;                    // the deck is behind the camera (mid-blend) — keep the last cursor
    const hx = o.x + d.x * t, hz = o.z + d.z * t;
    this.cursorInRoom = hx >= rb.minX && hx <= rb.maxX && hz >= rb.minZ && hz <= rb.maxZ;
    this.cursor.x = THREE.MathUtils.clamp(hx, rb.minX, rb.maxX);
    this.cursor.z = THREE.MathUtils.clamp(hz, rb.minZ, rb.maxZ);
  }

  /** Footprint of what the cursor carries: the housing selection, the picked-up piece, or a single cell. */
  private selection(): { defId: string | null; yaw: Yaw; level: number; cols: number; rows: number; ignoreUid?: string } {
    const housing = this.ctx.housing;
    if (this.carry) {
      const def = FURNITURE_DEF_MAP.get(this.carry.defId);
      const fp = def ? furnitureFootprint(def, this.carry.yaw) : { cols: 1, rows: 1 };
      return { defId: this.carry.defId, yaw: this.carry.yaw, level: this.carry.level, cols: fp.cols, rows: fp.rows, ignoreUid: this.carry.uid };
    }
    const defId = housing?.selectedFurniture ?? null;
    const yaw = (housing?.selectedYaw ?? 0) as Yaw;
    const def = defId ? FURNITURE_DEF_MAP.get(defId) : undefined;
    if (!def) return { defId: null, yaw, level: 1, cols: 1, rows: 1 };
    const fp = furnitureFootprint(def, yaw);
    let level = 1;
    if (housing) for (const s of housing.getStored()) if (s.defId === defId && s.qty > 0 && s.level > level) level = s.level;
    return { defId, yaw, level, cols: fp.cols, rows: fp.rows };
  }

  /** Recompute the footprint cell, validity, ghost and frame; emit `housing:cursorChanged` on change. */
  private refresh(force: boolean): void {
    const rb = roomBox(this.room);
    if (!rb) return;
    const sel = this.selection();
    // 2026-09-12: the grid is per area (`roomGridSize` — the cockpit is 20 × 12, rooms 16 × 16)
    const grid = roomGridSize(this.room);
    const fx = (this.cursor.x - rb.minX) / HOUSING_CELL_SIZE, fz = (this.cursor.z - rb.minZ) / HOUSING_CELL_SIZE;
    const x = THREE.MathUtils.clamp(Math.round(fx - sel.cols / 2), 0, grid.cols - sel.cols);
    const y = THREE.MathUtils.clamp(Math.round(fz - sel.rows / 2), 0, grid.rows - sel.rows);
    const housing = this.ctx.housing;
    const inRoom = this.cursorInRoom;
    let valid = false;
    if (!inRoom) valid = false;
    else if (sel.defId) {
      try { valid = !!housing && typeof housing.canPlace === 'function' && housing.canPlace(this.room, sel.defId, x, y, sel.yaw, sel.ignoreUid); } catch { valid = false; }
    } else {
      valid = this.layer?.pieceAt(this.room, x, y) !== null && this.layer !== null;
    }
    const changed = force || x !== this.cell.x || y !== this.cell.y || valid !== this.cell.valid;
    this.cell.x = x; this.cell.y = y; this.cell.valid = valid;

    // ghost (rebuilt only when def / yaw / level change)
    const key = sel.defId ? `${sel.defId}|${sel.yaw}|${sel.level}` : '';
    if (key !== this.ghostKey) {
      this.disposeGhost();
      this.ghostKey = key;
      if (sel.defId) {
        const def = FURNITURE_DEF_MAP.get(sel.defId);
        if (def && this.ship) {
          this.ghost = buildFurniture(def, sel.level);
          this.ghost.group.rotation.y = yawToRotation(sel.yaw);
          this.ship.root.add(this.ghost.group);
          this.ghostValid = null;
        }
      }
    }
    roomCellToWorld(this.room, x, y, _pos, sel.cols, sel.rows);
    if (this.ghost) {
      this.ghost.group.visible = inRoom;
      this.ghost.group.position.set(_pos.x, 0.01, _pos.z);
      if (this.ghostValid !== valid) {
        this.ghostValid = valid;
        for (const m of this.ghost.meshes) m.material = valid ? GHOST_OK : GHOST_BAD;
      }
    }
    this.frame.visible = inRoom;
    this.frame.position.set(_pos.x, 0.02, _pos.z);
    this.frame.scale.set(sel.cols * HOUSING_CELL_SIZE, sel.rows * HOUSING_CELL_SIZE, 1);
    this.frameMat.color.setHex(sel.defId ? (valid ? 0x5cff8a : 0xff5a4a) : valid ? 0xffd27a : 0x5fd7ff);

    if (changed) this.ctx.bus.emit('housing:cursorChanged', { room: this.room, x, y, valid });
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  /**
   * LMB on the room floor: put a carried piece down (`move`), place the storage selection (`place`), or — **room
   * console mode only** — pick up the piece under the cursor. Returns the uid that ended up on the floor (moved or
   * newly placed), null when nothing was put down.
   */
  private primary(): string | null {
    const housing = this.ctx.housing;
    if (!housing) return null;
    const { x, y } = this.cell;
    if (this.carry) {
      const uid = this.carry.uid;
      if (typeof housing.move === 'function' && housing.move(uid, x, y, this.carry.yaw)) {
        this.carry = null;
        this.announceSelection();
        this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
        this.refresh(true);
        return uid;
      }
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.refresh(true);
      return null;
    }
    const defId = housing.selectedFurniture;
    if (defId) {
      const placed = typeof housing.place === 'function' ? housing.place(this.room, defId, x, y, housing.selectedYaw) : null;
      this.ctx.bus.emit('audio:play', { id: placed ? 'ui_equip' : 'ui_deny' });
      this.refresh(true);
      return placed?.uid ?? null;
    }
    if (this.manage) return null;              // 2026-09-12: 시설 관리에서 클릭은 선택이다 — 집기는 위치 이동 상태로만
    const under = this.layer?.pieceAt(this.room, x, y) ?? null;
    if (under) {
      this.carry = { uid: under.uid, defId: under.defId, yaw: under.yaw, level: under.level };
      // keep the cursor on the piece so an immediate click puts it back where it was
      const def = FURNITURE_DEF_MAP.get(under.defId);
      const fp = def ? furnitureFootprint(def, under.yaw) : { cols: 1, rows: 1 };
      roomCellToWorld(this.room, under.x, under.y, this.cursor, fp.cols, fp.rows);
      this.announceSelection();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh(true);
    }
    return null;
  }

  /* ── 위치 이동 상태 (2026-09-12, 시설 관리) ─────────────────────────────── */
  /**
   * Enter the move state for placed piece `uid` (the 인스펙터's `위치 이동` button or E). Only a piece in the edit room;
   * a storage selection in progress is dropped first. The piece stays in the housing state while it is carried, so
   * C / Esc simply forget the carry and it is back where it was.
   */
  private beginMove(uid: string): void {
    if (!this.active || !this.manage || this.carry?.uid === uid) return;
    const housing = this.ctx.housing;
    const piece = housing?.getPlacedByUid(uid) ?? null;
    if (!housing || !piece || piece.room !== this.room) return;
    if (housing.selectedFurniture) housing.selectFurniture(null);
    this.carry = { uid: piece.uid, defId: piece.defId, yaw: piece.yaw, level: piece.level };
    this.select(uid);
    this.announceSelection();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh(true);
    this.syncState();
  }

  /**
   * LMB in the move state. A valid cell puts the piece down and **ends** the state (a storage selection is cleared
   * even when more copies are stored — 「배치하면 위치 이동 상태 종료」); the 인스펙터 then shows what was put down.
   * Anything else is refused with a 한국어 reason for the toast above the 인스펙터.
   */
  private placeMoving(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    if (!this.cursorInRoom || !this.cell.valid) { this.refuse(this.refuseReason(), true); return; }
    const uid = this.primary();
    if (!uid) { this.refuse(this.refuseReason(), false); return; }
    if (housing.selectedFurniture) housing.selectFurniture(null);
    this.select(uid);
  }

  /** Why the current footprint cannot be placed — the room's purpose when that is the reason, else a plain line. */
  private refuseReason(): string {
    if (!this.cursorInRoom) return '방 밖에는 설치할 수 없습니다';
    const defId = this.selection().defId;
    const def = defId ? FURNITURE_DEF_MAP.get(defId) : undefined;
    const purpose = this.ctx.housing?.getRoom(this.room)?.purpose;
    if (def && purpose && def.room !== 'any' && def.room !== purpose) {
      return isCockpitOnlyFurniture(def) ? '조종석 전용 시설입니다' : `${ROOM_PURPOSE_LABEL_KO[def.room]} 전용 가구입니다`;
    }
    return '설치할 수 없는 곳입니다';
  }

  private refuse(reason: string, sound: boolean): void {
    if (sound) this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    this.ctx.bus.emit('housing:placeRefused', { reason });
  }

  /* ── B-13 클릭 인스펙터 (입력 절반, 2026-09-11) ─────────────────────────── */
  /**
   * Tell `ui/hud/ShipManage` which placed piece the 인스펙터 should show (`null` = 빈 곳을 클릭해 선택이 풀렸다).
   * 시설 관리에서만 — the room-console mode has no cursor to click with. Emitted only on a real change, and the
   * controller itself never reads it back: this is a **읽기 전용 선택** bolted onto the existing click path.
   */
  private select(uid: string | null): void {
    if (!this.manage || uid === this.selectedUid) return;
    this.selectedUid = uid;
    this.ctx.bus.emit('housing:furnitureSelected', { uid });
  }

  /** Whatever is under the footprint cell right now (after the click's own action). */
  private selectUnderCursor(): void {
    if (!this.manage) return;
    this.select(this.layer?.pieceAt(this.room, this.cell.x, this.cell.y)?.uid ?? null);
  }

  /**
   * `housing:selectionChanged` for what the cursor carries: the picked-up piece (its def + yaw) while moving one,
   * otherwise the housing selection again — so the HUD hint never shows `선택 없음` while a piece is in hand.
   */
  private announceSelection(): void {
    const housing = this.ctx.housing;
    if (this.carry) this.ctx.bus.emit('housing:selectionChanged', { defId: this.carry.defId, yaw: this.carry.yaw });
    else this.ctx.bus.emit('housing:selectionChanged', { defId: housing?.selectedFurniture ?? null, yaw: (housing?.selectedYaw ?? 0) as Yaw });
  }

  /**
   * C: cancel what the cursor holds — a carried piece goes back to where it was picked up (it was never removed
   * from the housing state), otherwise the furniture selection is cleared. Returns **false** when the cursor held
   * nothing, and the caller then leaves the mode (Phase 8 UI pass: C with an empty cursor = Esc).
   */
  private cancelSelection(): boolean {
    if (this.carry) {
      this.carry = null;
      this.announceSelection();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh(true);
      this.syncState();                // Esc arrives through `ctx.escape`, outside `update`
      return true;
    }
    const housing = this.ctx.housing;
    if (!housing || typeof housing.selectFurniture !== 'function' || housing.selectedFurniture === null) return false;
    housing.selectFurniture(null);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh(true);
    this.syncState();
    return true;
  }

  private recoverUnderCursor(): void {
    const housing = this.ctx.housing;
    if (!housing || typeof housing.recover !== 'function') return;
    // 2026-09-12: 시설 관리에서 아직 놓이지 않은 새 가구(창고 선택)는 X 가 그냥 창고로 되돌린다
    if (this.manage && !this.carry) { this.cancelSelection(); return; }
    const uid = this.carry?.uid ?? this.layer?.pieceAt(this.room, this.cell.x, this.cell.y)?.uid ?? null;
    if (!uid) return;
    // 2026-09-13 (사용자 결정): 조종석 전용 시설은 가구 창고로 돌아가지 않는다 — 들고 있던 것은 그대로 들고, 이유는 인스펙터 위 토스트
    const piece = typeof housing.getPlacedByUid === 'function' ? housing.getPlacedByUid(uid) : null;
    if (piece && isCockpitOnlyFurniture(FURNITURE_DEF_MAP.get(piece.defId))) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      if (this.manage) this.ctx.bus.emit('housing:placeRefused', { reason: COCKPIT_ONLY_RECOVER_REASON });
      else this.ctx.bus.emit('ui:notify', { text: COCKPIT_ONLY_RECOVER_REASON, kind: 'warning' });
      return;
    }
    const ok = housing.recover(uid);
    if (ok && this.carry) { this.carry = null; this.announceSelection(); }
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    this.refresh(true);
    if (!this.manage) return;
    // B-13: the recovered piece is gone — close the 인스펙터 on it; a refusal (e.g. books that do not fit) says why
    if (ok) this.select(null);
    else this.ctx.bus.emit('housing:placeRefused', { reason: '지금은 회수할 수 없습니다' });
  }

  private cycleSelection(dir: number): void {
    const housing = this.ctx.housing;
    if (!housing || typeof housing.selectFurniture !== 'function') return;
    const ids: (string | null)[] = [null];
    for (const s of housing.getStored()) if (s.qty > 0 && !ids.includes(s.defId)) ids.push(s.defId);
    const cur = ids.indexOf(housing.selectedFurniture);
    const next = ids[((cur < 0 ? 0 : cur) + dir + ids.length) % ids.length];
    housing.selectFurniture(next);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /* ── 꾹 눌러 옮기기 · 외곽선 (2026-09-12, 시설 관리) ──────────────────────── */
  /** Arm a hold on the piece just clicked (only a real, still-held `pointerdown`; null = nothing under the cursor). */
  private startHold(uid: string | null): void {
    this.endHold();
    if (!uid || !this.manage || this.moving || !this.buttonDown) return;
    this.holdUid = uid;
  }

  /**
   * Advance the hold: still pressed, still over the same piece, not over the UI and not already moving → accumulate
   * `dt`; at `HOUSING_MOVE_HOLD_S` enter the move state. Anything else cancels. `housing:moveHold` goes out every frame
   * once the gauge is worth drawing (`HOLD_GAUGE_MIN_PROGRESS`).
   */
  private tickHold(dt: number, overUI: boolean): void {
    const uid = this.holdUid;
    if (!uid) return;
    const under = this.buttonDown && !overUI && !this.moving && this.cursorInRoom
      ? this.layer?.pieceAt(this.room, this.cell.x, this.cell.y)?.uid ?? null
      : null;
    if (under !== uid) { this.endHold(); return; }
    this.holdT += dt;
    const progress = Math.min(1, this.holdT / HOUSING_MOVE_HOLD_S);
    if (progress >= 1) {
      this.endHold();
      this.beginMove(uid);
      return;
    }
    if (progress >= HOLD_GAUGE_MIN_PROGRESS) {
      this.holdShown = true;
      this.ctx.bus.emit('housing:moveHold', { progress });
    }
  }

  /** Drop the hold (released / cancelled / completed); tells ui/ to hide the gauge only if it was shown. */
  private endHold(): void {
    this.holdUid = null;
    this.holdT = 0;
    if (!this.holdShown) return;
    this.holdShown = false;
    this.ctx.bus.emit('housing:moveHold', { progress: null });
  }

  /** The uid a hold is running on (debug / smoke). */
  get holdingUid(): string | null { return this.holdUid; }

  /**
   * Hover (weak white) and selected (yellow-green) outlines through `ctx.outline`. Hover = the placed piece under the
   * cursor while not moving, not over the UI and inside the edit area; a selected piece is never also hovered. Both are
   * off in the move state (the ghost says green / red there). Re-set only when the target **object** changes — a room
   * rebuild replaces a piece's group under the same uid.
   */
  private syncOutline(overUI: boolean): void {
    const outline = this.ctx.outline;
    const layer = this.layer;
    if (!outline || !layer) return;
    const moving = this.moving;
    const selUid = moving ? null : this.selectedUid;
    const hoverUid = !moving && !overUI && this.cursorInRoom ? layer.pieceAt(this.room, this.cell.x, this.cell.y)?.uid ?? null : null;
    const sel = selUid ? layer.objectOf(selUid) : null;
    const hover = hoverUid && hoverUid !== selUid ? layer.objectOf(hoverUid) : null;
    if (hover !== this.outlineHover) { this.outlineHover = hover; outline.set('hover', hover ? [hover] : null); }
    if (sel !== this.outlineSel) { this.outlineSel = sel; outline.set('selected', sel ? [sel] : null); }
  }

  private clearOutline(): void {
    if (!this.outlineHover && !this.outlineSel) return;
    this.outlineHover = null;
    this.outlineSel = null;
    this.ctx.outline?.clear();
  }

  private disposeGhost(): void {
    if (!this.ghost) return;
    for (const m of this.ghost.meshes) { m.geometry.dispose(); m.removeFromParent(); }
    this.ghost.group.removeFromParent();
    this.ghost = null;
    this.ghostKey = '';
    this.ghostValid = null;
  }

  dispose(): void {
    this.deactivate();
    window.removeEventListener('pointerdown', this.onSoftPointerDown);
    window.removeEventListener('mousedown', this.onSoftPointerDown);
    window.removeEventListener('wheel', this.onSoftWheel);
    window.removeEventListener('pointerup', this.onSoftPointerUp);
    window.removeEventListener('mouseup', this.onSoftPointerUp);
    window.removeEventListener('blur', this.onBlur);
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.frame.geometry.dispose();
    this.frameMat.dispose();
    this.frame.removeFromParent();
  }
}
