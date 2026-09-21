import * as THREE from 'three';
import type { FurniturePose, GameContext, GymMinigame } from '@/shared';
import { yawFromForward } from './GeoBatch';
import { roomBox } from './RoomLayout';
import { CAMERA_WALL_MARGIN, restRig, segmentHits, sitPoseOf, type FootBox, type StagedPiece } from './GymStaging';
import { SIT_SEAT_TOP, TV_GAME_HUD, TV_GAME_SCREEN } from './FurnitureLeisure';

/* ────────────────────────────────────────────────────────────────────────────
 * Video-game staging (2026-09-13, library series · video games). Modelled on `GymStaging` · `CookStaging`.
 *
 *   housing:gameSession {active:true}  → a `sit` pose on the seat (`seatUid`) spot closest to the TV · yaw toward the TV screen · an over-the-shoulder fixed camera
 *                                         → setFurniturePose (false → cancelGameSession **on the spot**) · the TV's game screen (`model.tv.overlay`) is turned on
 *                                         2026-09-17: `seatUid` null (no seat) = no pose and no camera, standing where the player is, the screen only
 *   housing:gameBeat                   → the marker **inside** the screen kicks and the progress bar climbs (2026-09-14, user's decision: the screen does not flash on every key press)
 *   housing:gameSession {active:false} → the pose is released (reason `caller`) · the game screen is hidden and the materials go back to their own colours
 *   player:furniturePoseEnded (sit, not released by this class) → cancelGameSession (so no minigame is left without a pose)
 *
 * The screen staging changes only the **emissive colour (uniform)** of the shared materials `TV_GAME_SCREEN` · `TV_GAME_HUD` — it
 * swaps no material and raises no `needsUpdate`, so there is no shader compile and no point light; one local session at a time is
 * why shared materials suffice. The piece is re-found by uid (a room rebuild swaps the group) — a rebuilt TV is built with its game screen already on (`BuildExtra.gameActive`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** How long the marker's kick lasts (s). */
const KICK_S = 0.25;
/**
 * Screen glow — the base intensity · the slow pulse amplitude. The HUD's base intensity.
 * **2026-09-14 (user's decision): the screen does not flash on every key press.** Kicking `emissive` · `emissiveIntensity` to the
 * judgement colour on every judgement (`flash` · `SCREEN_FLASH` · `HUD_FLASH`) was dropped — the screen is the disc's theme colour
 * + a quiet `SCREEN_PULSE`, and the marker **inside** the screen (`kick`) and the progress bar answer the judgement. Uniforms only, as before (zero point lights).
 */
const SCREEN_BASE = 1.15;
const SCREEN_PULSE = 0.18;
const HUD_BASE = 1.5;
const HUD_WHITE = new THREE.Color(0xdfefff);
/** The screen colour used when the disc's colour is unknown. */
const DEFAULT_THEME = '#3aa8ff';
/** The most the sitting direction may turn toward the TV screen (rad) — a seat offset sideways from the TV must not leave the body facing off it. */
const YAW_CLAMP = 0.6;

/**
 * Over-the-shoulder camera candidates (around the seat anchor, forward = anchor → TV screen): side (+1 = **right shoulder**) × lateral
 * distance × back distance × height off the floor. Right shoulder · close · back · low are preferred; entering a room wall or another
 * piece of the room's furniture (not the TV), or a blocked line of sight, costs a lot. A sofa against a wall that cannot step back goes sideways instead (back 0.3 m).
 */
const CAM_SIDES = [1, -1] as const;
const CAM_LATERAL = [0.45, 0.8, 1.25] as const;
const CAM_BACK = [1.1, 0.7, 0.3] as const;
const CAM_HEIGHT = [1.55, 1.85] as const;
/** Head height over the seat top (`FURN_EYE.sit` 0.85) · the head · shoulder box (seat-top relative) tested for blocking the screen. */
const HEAD_UP = 0.85;
const BODY = { half: 0.24, minUp: 0.5, maxUp: 1.0 } as const;

const _p = new THREE.Vector3();

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const contains = (b: FootBox, p: THREE.Vector3): boolean =>
  p.x >= b.minX - 0.02 && p.x <= b.maxX + 0.02 && p.y >= b.minY - 0.02 && p.y <= b.maxY + 0.02 && p.z >= b.minZ - 0.02 && p.z <= b.maxZ + 0.02;

/** The centre of the TV screen's front face (world). null when the piece is not a TV. */
export function tvScreenWorld(tv: StagedPiece): THREE.Vector3 | null {
  const rig = tv.model.tv;
  if (!rig) return null;
  tv.model.group.updateWorldMatrix(true, false);
  return tv.model.group.localToWorld(rig.screen.clone());
}

/**
 * The game-screen camera. `blockers` = the boxes of the other furniture in the seat's room — **the box holding the TV screen (= the TV
 * itself) is dropped here** (the line to the screen ends inside the TV body, so it would always hit). Run once at session start, so allocation does not matter.
 */
export function gameCameraOf(seat: StagedPiece, anchor: THREE.Vector3, screen: THREE.Vector3, blockers: readonly FootBox[]): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  let fx = screen.x - anchor.x, fz = screen.z - anchor.z;
  const len = Math.hypot(fx, fz);
  if (len < 1e-3) { fx = 0; fz = -1; } else { fx /= len; fz /= len; }
  const rx = -fz, rz = fx;                                                   // right (forward (0, −1) → right (+1, 0))
  const floorY = anchor.y - SIT_SEAT_TOP;
  const head = new THREE.Vector3(anchor.x, anchor.y + HEAD_UP, anchor.z);
  const lookAt = head.clone().lerp(screen, 0.7);
  const body: FootBox = {
    minX: anchor.x - BODY.half, maxX: anchor.x + BODY.half, minY: anchor.y + BODY.minUp, maxY: anchor.y + BODY.maxUp,
    minZ: anchor.z - BODY.half, maxZ: anchor.z + BODY.half,
  };
  const others = blockers.filter((b) => !contains(b, screen));
  const box = roomBox(seat.item.room);
  let best: THREE.Vector3 | null = null, bestCost = Infinity;
  for (const side of CAM_SIDES) for (const lat of CAM_LATERAL) for (const back of CAM_BACK) for (const hgt of CAM_HEIGHT) {
    _p.set(anchor.x - fx * back + rx * side * lat, floorY + hgt, anchor.z - fz * back + rz * side * lat);
    let cost = (side < 0 ? 0.35 : 0) + (lat - CAM_LATERAL[0]) * 0.35 + (CAM_BACK[0] - back) * 0.3 + (hgt - CAM_HEIGHT[0]) * 0.5;
    if (box) {
      const minX = box.minX + CAMERA_WALL_MARGIN, maxX = box.maxX - CAMERA_WALL_MARGIN;
      const minZ = box.minZ + CAMERA_WALL_MARGIN, maxZ = box.maxZ - CAMERA_WALL_MARGIN;
      const over = Math.max(0, minX - _p.x, _p.x - maxX) + Math.max(0, minZ - _p.z, _p.z - maxZ);
      if (over > 0) {
        cost += 4 + over * 4;
        _p.x = THREE.MathUtils.clamp(_p.x, minX, maxX);
        _p.z = THREE.MathUtils.clamp(_p.z, minZ, maxZ);
      }
    }
    if (segmentHits(_p, screen, body)) cost += 2;
    for (const b of others) {
      if (contains(b, _p)) cost += 6;
      if (segmentHits(_p, screen, b)) cost += 3;
      if (segmentHits(_p, head, b)) cost += 1.5;
    }
    if (cost < bestCost) { bestCost = cost; best = (best ?? new THREE.Vector3()).copy(_p); }
  }
  return { position: best ?? head.clone().add(new THREE.Vector3(-fx * 1.1, 0.7, -fz * 1.1)), lookAt };
}

/**
 * One game-session pose — the seat spot closest to the TV screen · yaw toward the screen (±`YAW_CLAMP` off the seat's own) · an
 * over-the-shoulder fixed camera · not released by E. null when the seat is not a sitting piece or the TV has no game-screen rig.
 */
export function gamePoseOf(seat: StagedPiece, tv: StagedPiece, blockers: readonly FootBox[] = []): FurniturePose | null {
  const screen = tvScreenWorld(tv);
  if (!screen) return null;
  const base = sitPoseOf(seat, screen);
  if (!base) return null;
  const dx = screen.x - base.anchor.x, dz = screen.z - base.anchor.z;
  let yaw = base.yaw;
  if (dx * dx + dz * dz > 1e-6) yaw = base.yaw + THREE.MathUtils.clamp(wrapAngle(yawFromForward(dx, dz) - base.yaw), -YAW_CLAMP, YAW_CLAMP);
  return {
    kind: 'sit', anchor: base.anchor, yaw, camera: gameCameraOf(seat, base.anchor, screen, blockers),
    releaseOnInteract: false, furnitureUid: seat.item.uid,
  };
}

/** Game-session staging. `FurnitureLayer` creates it only for the own ship (never while visiting). */
export class GameStaging {
  /** The TV · seat uid being staged (null with no session). */
  tvUid: string | null = null;
  seatUid: string | null = null;
  private minigame: GymMinigame = 'press';
  /** The pose this class set is the one currently held. */
  private held = false;
  private releasing = false;
  private readonly unsubs: Array<() => void> = [];
  private clock = 0;
  private kick = 0;
  private progress = 0;
  private shownProgress = 0;
  private side = 1;
  private readonly theme = new THREE.Color(DEFAULT_THEME);
  private readonly screenBase = { color: TV_GAME_SCREEN.emissive.clone(), intensity: TV_GAME_SCREEN.emissiveIntensity };
  private readonly hudBase = { color: TV_GAME_HUD.emissive.clone(), intensity: TV_GAME_HUD.emissiveIntensity };

  /** `find` = the piece for a uid right now, `blockers` = the boxes of the other furniture in its room (camera occlusion). */
  constructor(private readonly ctx: GameContext, private readonly find: (uid: string) => StagedPiece | null, private readonly blockers: (uid: string) => readonly FootBox[] = () => []) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:gameSession', (e) => this.onSession(e.tvUid, e.seatUid, e.discDefId, e.minigame, e.active)),
      b.on('housing:gameBeat', (e) => this.onBeat(e.tvUid, e.quality, e.index, e.total)),
      b.on('player:furniturePoseEnded', (e) => {
        // the game pose was released without going through this class (phase change · spawn · the reset on hub:left) → drop the minigame too
        if (!this.tvUid || !this.held || this.releasing || e.kind !== 'sit') return;
        this.held = false;
        this.stop(false);
        this.cancelHousing();
      }),
    );
  }

  /** Is a game running on this TV (`BuildExtra.gameActive`). */
  activeOn(tvUid: string): boolean {
    return this.tvUid === tvUid;
  }

  /**
   * Debug · smoke: the staged session · the judgement response (`kick`) · the progress bar · whether the game screen shows · the
   * screen's emissive intensity. null with no session. 2026-09-14: the old `flash` (the screen flash) is gone — `kick` says it now.
   */
  get stage(): { tvUid: string; seatUid: string | null; minigame: GymMinigame; held: boolean; kick: number; progress: number; overlay: boolean; screenIntensity: number } | null {
    if (!this.tvUid) return null;
    const rig = this.find(this.tvUid)?.model.tv;
    return {
      tvUid: this.tvUid, seatUid: this.seatUid, minigame: this.minigame, held: this.held, kick: this.kick, progress: this.progress,
      overlay: rig?.overlay.visible === true, screenIntensity: TV_GAME_SCREEN.emissiveIntensity,
    };
  }

  private onSession(tvUid: string, seatUid: string | null, discDefId: string, minigame: GymMinigame, active: boolean): void {
    if (!active) { if (this.tvUid === tvUid) this.stop(true); return; }
    const same = this.tvUid === tvUid && this.seatUid === seatUid;
    if (this.tvUid && !same) this.stop(true);
    const tv = this.find(tvUid), seat = seatUid ? this.find(seatUid) : null;
    if (!tv?.model.tv || (seatUid && (!seat || seat.model.rig?.pose !== 'sit'))) { this.cancelHousing(); return; }
    if (!same) {
      this.tvUid = tvUid; this.seatUid = seatUid; this.minigame = minigame;
      this.clock = 0; this.kick = 0; this.progress = 0; this.shownProgress = 0; this.side = 1;
      this.theme.set(this.discColor(discDefId));
    }
    tv.model.tv.overlay.visible = true;
    // 2026-09-17 (user's decision): a seat is not a condition — with no seat the session runs **standing where the player is**, with no
    // pose and no fixed camera (the `housing.game` blocker stops movement while the game screen is up). The only standing furniture pose is the cook bench's (`cook`), so none was added.
    if (!seat) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function') return;   // player does not know poses yet — the minigame is left alone
    if (same && this.held && p.furniturePose === 'sit') return;    // the same session was announced again — re-setting the pose would make the seat the spot it returns to on release
    const pose = gamePoseOf(seat, tv, this.blockers(seat.item.uid));
    let ok = false;
    // a pose-ended notice raised inside this call (a rocking chair being sat in · the previous pose) belongs to this class
    this.releasing = true;
    try { ok = pose !== null && p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose(game) failed', err); } finally { this.releasing = false; }
    if (!ok) { this.stop(false); this.cancelHousing(); return; }
    this.held = true;
  }

  /** One judgement — **the screen does not flash** (2026-09-14). The marker inside the screen kicks and the progress bar climbs. */
  private onBeat(tvUid: string, _quality: 'perfect' | 'good' | 'miss', index: number, total: number): void {
    if (tvUid !== this.tvUid) return;
    this.kick = 1;
    this.progress = total > 0 ? THREE.MathUtils.clamp((index + 1) / total, 0, 1) : 0;
    this.side = -this.side;
  }

  /** Every frame (`FurnitureLayer.update`). No per-frame allocation. */
  update(dt: number): void {
    this.clock += dt;
    if (!this.tvUid) return;
    const tv = this.find(this.tvUid);
    const seat = this.seatUid ? this.find(this.seatUid) : null;
    const rig = tv?.model.tv;
    if (!rig || (this.seatUid && !seat)) { this.stop(true); this.cancelHousing(); return; }   // the TV, or the seat being sat in, disappeared mid-session
    rig.overlay.visible = true;
    this.kick = Math.max(0, this.kick - dt / KICK_S);
    // the screen keeps one brightness — the disc's theme colour + a quiet pulse only (2026-09-14, user's decision)
    TV_GAME_SCREEN.emissive.copy(this.theme);
    TV_GAME_SCREEN.emissiveIntensity = SCREEN_BASE + SCREEN_PULSE * Math.sin(this.clock * 2.4);
    TV_GAME_HUD.emissive.copy(HUD_WHITE);
    TV_GAME_HUD.emissiveIntensity = HUD_BASE;
    // the marker inside the screen — one per minigame (bench press = a cursor sweeping side to side · breath = a bar swelling and shrinking · cycle = it hops sides on every beat)
    const half = rig.screenW * 0.4, m = rig.marker;
    if (this.minigame === 'press') {
      m.position.x = Math.sin(this.clock * 3.2) * half * 0.9;
      m.scale.y = 1 + this.kick * 0.25;
    } else if (this.minigame === 'breath') {
      m.position.x = 0;
      m.scale.y = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.clock * 1.6)) + this.kick * 0.3;
    } else {
      const target = this.side * half * 0.55;
      m.position.x += (target - m.position.x) * Math.min(1, dt * 14);
      m.scale.y = 1 + this.kick * 0.25;
    }
    this.shownProgress += (this.progress - this.shownProgress) * Math.min(1, dt * 8);
    rig.progress.scale.x = Math.max(0.001, this.shownProgress);
  }

  /** Take the staging down: hide the game screen and put the materials back. `release` = also release the pose this class set. */
  private stop(release: boolean): void {
    const tvUid = this.tvUid, seatUid = this.seatUid;
    this.tvUid = null;
    this.seatUid = null;
    const rig = tvUid ? this.find(tvUid)?.model.tv : undefined;
    if (rig) {
      rig.overlay.visible = false;
      rig.marker.position.x = 0;
      rig.marker.scale.y = 1;
      rig.progress.scale.x = 0.001;
    }
    const seatRig = seatUid ? this.find(seatUid)?.model.rig : undefined;
    if (seatRig) restRig(seatRig);
    TV_GAME_SCREEN.emissive.copy(this.screenBase.color);
    TV_GAME_SCREEN.emissiveIntensity = this.screenBase.intensity;
    TV_GAME_HUD.emissive.copy(this.hudBase.color);
    TV_GAME_HUD.emissiveIntensity = this.hudBase.intensity;
    const wasHeld = this.held;
    this.held = false;
    if (!release || !wasHeld) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function' || p.furniturePose !== 'sit') return;
    this.releasing = true;
    try { p.setFurniturePose(null); } catch { /* player mid-build */ } finally { this.releasing = false; }
  }

  /** The game disc's theme colour (`GameDiscDef.color`), the default colour when unknown. */
  private discColor(defId: string): string {
    try {
      const c = this.ctx.loot?.getItemDef(defId)?.gameDisc?.color;
      return typeof c === 'string' && c ? c : DEFAULT_THEME;
    } catch { return DEFAULT_THEME; }
  }

  private cancelHousing(): void {
    const h = this.ctx.housing;
    if (h && typeof h.cancelGameSession === 'function') {
      try { h.cancelGameSession(); } catch (err) { console.warn('[hub] cancelGameSession failed', err); }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.tvUid) { this.stop(true); this.cancelHousing(); }
  }
}
