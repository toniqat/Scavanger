import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { FURNITURE_DEF_MAP, HOUSING_CELL_SIZE, Keys, MouseButtons, ROOM_GRID_COLS, ROOM_GRID_ROWS, furnitureFootprint } from '@/shared';
import { GHOST_BAD, GHOST_OK, buildFurniture, type FurnitureLayer, type FurnitureModel } from './interiors/Furniture';
import { ROOM_BOXES, roomCellToWorld, yawToRotation } from './interiors/RoomLayout';
import type { PersonalShip } from './interiors/PersonalShip';

/** Cursor speed: metres of room floor per pixel of pointer-locked mouse movement. */
const CURSOR_M_PER_PX = 0.012;
/** Camera over the room: how far toward the door from the room centre, and how high. */
const CAM_TOWARD_DOOR = 2.2;
const CAM_HEIGHT = 6.6;

type Yaw = 0 | 1 | 2 | 3;
interface Carry { uid: string; defId: string; yaw: Yaw; level: number }

const _cam = new THREE.Vector3();
const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();

/**
 * 3D side of housing mode (`housing:modeChanged {active:true, room}` → this; the rules live in `ctx.housing`).
 * Controls off, oblique top-down camera over the room from the door side (`setCameraOverride`, blended), the pointer
 * **stays locked** and its deltas move a floor cursor over the 8 × 8 grid. A ghost of `ctx.housing.selectedFurniture`
 * (or of a picked-up piece) follows the cursor, green / red by `canPlace`.
 *   LMB (`Keys.FIRE`)         place the selection · pick up the piece under the cursor · put a picked-up piece down (`move`)
 *   R   (`Keys.ROTATE_ITEM`)  rotate the selection / the carried piece
 *   X   (`Keys.DROP_ITEM`)    recover the piece under the cursor (→ furniture storage)
 *   wheel / [ ]               cycle the selection through the furniture storage (null = cursor only)
 *   Esc (`Keys.MENU`)         exit housing mode
 * Emits `housing:cursorChanged {room, x, y, valid}` whenever the footprint cell or its validity changes.
 */
export class HousingMode {
  active = false;
  room = -1;
  /** Top-left cell of the current footprint (debug / smoke). */
  readonly cell = { x: -1, y: -1, valid: false };

  private ship: PersonalShip | null = null;
  private layer: FurnitureLayer | null = null;
  private unsubs: Array<() => void> = [];
  private readonly cursor = new THREE.Vector3();
  private carry: Carry | null = null;
  private ghost: FurnitureModel | null = null;
  private ghostKey = '';
  private ghostValid: boolean | null = null;
  private readonly frame: THREE.Mesh;
  private readonly frameMat: THREE.MeshBasicMaterial;

  constructor(private readonly ctx: GameContext) {
    this.frameMat = new THREE.MeshBasicMaterial({ color: 0x5fd7ff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.frameMat);
    this.frame.rotation.x = -Math.PI / 2;
    this.frame.renderOrder = 3;
    this.frame.visible = false;
    this.unsubs.push(
      ctx.bus.on('housing:modeChanged', ({ active, room }) => {
        if (active && room !== null) this.activate(room);
        else this.deactivate();
      }),
    );
  }

  /** The hub hands over the current personal ship (null in the shared ship / outside the hub). */
  setShip(ship: PersonalShip | null, layer: FurnitureLayer | null): void {
    if (this.active) this.deactivate();
    if (this.ship && this.frame.parent) this.frame.removeFromParent();
    this.ship = ship;
    this.layer = layer;
    if (ship) ship.root.add(this.frame);
  }

  /* ── enter / leave ───────────────────────────────────────────────────── */
  private activate(room: number): void {
    const ctx = this.ctx;
    const rb = ROOM_BOXES[room];
    if (!this.ship || !rb) { ctx.housing?.exitHousingMode(); return; }
    if (this.active && this.room === room) return;
    this.active = true;
    this.room = room;
    this.carry = null;
    this.cell.x = -1; this.cell.y = -1; this.cell.valid = false;
    const p = ctx.player;
    if (p) {
      p.setControlsEnabled(false);
      const cx = (rb.minX + rb.maxX) / 2, cz = (rb.minZ + rb.maxZ) / 2;
      // start the cursor where the player stands (clamped into the room), else at the room centre
      const inside = p.position.x >= rb.minX && p.position.x <= rb.maxX && p.position.z >= rb.minZ && p.position.z <= rb.maxZ;
      this.cursor.set(inside ? p.position.x : cx, 0, inside ? p.position.z : cz);
      _cam.set(cx - rb.side * CAM_TOWARD_DOOR, CAM_HEIGHT, cz);
      _look.set(cx, 0.2, cz);
      p.setCameraOverride(_cam, _look, false);
    }
    this.frame.visible = true;
    this.refresh(true);
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.room = -1;
    this.carry = null;
    this.disposeGhost();
    this.frame.visible = false;
    const p = this.ctx.player;
    if (p && this.ctx.phase === 'hub') {
      p.setCameraOverride(null);
      p.setControlsEnabled(true);
    }
  }

  /** Esc / lost pointer lock: ask housing to leave; if it stays silent (stub) leave locally and tell the HUD. */
  exit(): void {
    const housing = this.ctx.housing;
    if (housing && typeof housing.exitHousingMode === 'function') housing.exitHousingMode();
    if (this.active && !(housing?.housingMode ?? false)) {
      this.deactivate();
      this.ctx.bus.emit('housing:modeChanged', { active: false, room: null });
    }
  }

  /* ── frame ────────────────────────────────────────────────────────────── */
  update(): void {
    if (!this.active) return;
    const ctx = this.ctx, input = ctx.input;
    const housing = ctx.housing;
    if (ctx.phase !== 'hub' || !this.ship) { this.exit(); return; }
    if (ctx.uiBlockers.size > 0) return;        // a DOM panel (console / housing menu) has the input

    // cursor: pointer-locked deltas → room floor (screen right = world ±Z, screen up = away from the door)
    const rb = ROOM_BOXES[this.room];
    if (input.mouseDX !== 0 || input.mouseDY !== 0) {
      this.cursor.z += input.mouseDX * CURSOR_M_PER_PX * rb.side;
      this.cursor.x -= input.mouseDY * CURSOR_M_PER_PX * rb.side;
      this.cursor.x = THREE.MathUtils.clamp(this.cursor.x, rb.minX, rb.maxX);
      this.cursor.z = THREE.MathUtils.clamp(this.cursor.z, rb.minZ, rb.maxZ);
    }

    // keys
    if (input.wasPressed(Keys.MENU)) { this.exit(); return; }
    if (input.wasPressed(Keys.ROTATE_ITEM)) {
      if (this.carry) this.carry.yaw = ((this.carry.yaw + 1) % 4) as Yaw;
      else housing?.rotateSelection();
    }
    let dir = 0;
    if (input.wheelDelta > 0 || input.wasPressed('BracketRight')) dir = 1;
    else if (input.wheelDelta < 0 || input.wasPressed('BracketLeft')) dir = -1;
    if (dir !== 0 && !this.carry) this.cycleSelection(dir);

    this.refresh(false);

    if (input.wasPressed(Keys.DROP_ITEM)) this.recoverUnderCursor();
    if (input.wasMousePressed(MouseButtons.FIRE)) this.primary();
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
    const rb = ROOM_BOXES[this.room];
    const sel = this.selection();
    const fx = (this.cursor.x - rb.minX) / HOUSING_CELL_SIZE, fz = (this.cursor.z - rb.minZ) / HOUSING_CELL_SIZE;
    const x = THREE.MathUtils.clamp(Math.round(fx - sel.cols / 2), 0, ROOM_GRID_COLS - sel.cols);
    const y = THREE.MathUtils.clamp(Math.round(fz - sel.rows / 2), 0, ROOM_GRID_ROWS - sel.rows);
    const housing = this.ctx.housing;
    let valid = false;
    if (sel.defId) {
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
      this.ghost.group.position.set(_pos.x, 0.01, _pos.z);
      if (this.ghostValid !== valid) {
        this.ghostValid = valid;
        for (const m of this.ghost.meshes) m.material = valid ? GHOST_OK : GHOST_BAD;
      }
    }
    this.frame.position.set(_pos.x, 0.02, _pos.z);
    this.frame.scale.set(sel.cols * HOUSING_CELL_SIZE, sel.rows * HOUSING_CELL_SIZE, 1);
    this.frameMat.color.setHex(sel.defId ? (valid ? 0x5cff8a : 0xff5a4a) : valid ? 0xffd27a : 0x5fd7ff);

    if (changed) this.ctx.bus.emit('housing:cursorChanged', { room: this.room, x, y, valid });
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  private primary(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const { x, y } = this.cell;
    if (this.carry) {
      if (typeof housing.move === 'function' && housing.move(this.carry.uid, x, y, this.carry.yaw)) {
        this.carry = null;
        this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      } else this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.refresh(true);
      return;
    }
    const defId = housing.selectedFurniture;
    if (defId) {
      const placed = typeof housing.place === 'function' ? housing.place(this.room, defId, x, y, housing.selectedYaw) : null;
      this.ctx.bus.emit('audio:play', { id: placed ? 'ui_equip' : 'ui_deny' });
      this.refresh(true);
      return;
    }
    const under = this.layer?.pieceAt(this.room, x, y) ?? null;
    if (under) {
      this.carry = { uid: under.uid, defId: under.defId, yaw: under.yaw, level: under.level };
      // keep the cursor on the piece so an immediate click puts it back where it was
      const def = FURNITURE_DEF_MAP.get(under.defId);
      const fp = def ? furnitureFootprint(def, under.yaw) : { cols: 1, rows: 1 };
      roomCellToWorld(this.room, under.x, under.y, this.cursor, fp.cols, fp.rows);
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh(true);
    }
  }

  private recoverUnderCursor(): void {
    const housing = this.ctx.housing;
    if (!housing || typeof housing.recover !== 'function') return;
    const uid = this.carry?.uid ?? this.layer?.pieceAt(this.room, this.cell.x, this.cell.y)?.uid ?? null;
    if (!uid) return;
    const ok = housing.recover(uid);
    if (ok) this.carry = null;
    this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
    this.refresh(true);
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
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.frame.geometry.dispose();
    this.frameMat.dispose();
    this.frame.removeFromParent();
  }
}
