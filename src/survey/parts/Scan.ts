/**
 * src/survey/parts/Scan.ts — what the camera's frame sees this frame, and the progress it earns.
 *
 * Runs in `SurveySystem.lateUpdate` (after player/ moved the camera, so the frame and the tags match the image).
 * For every body of every subject kind: in range → its **centre** projects inside the frame → (zoomed) its whole
 * bounding box does too, else it only **crosses the border** → a clear world ray from the camera. The best body per
 * kind is kept in that kind's `ViewEntry`; a kind gains **once per frame** no matter how many of its bodies are in
 * the frame (user's decision). Zoomed, a kind with no fully-framed body gains nothing.
 */
import {
  SURVEY_CAMERA_WEAR_PER_S, SURVEY_MAX_RANGE_M, SURVEY_NOTIFY_INTERVAL_S, SURVEY_REPEAT_PLANET_MUL, SURVEY_ZOOM_MAX,
  SURVEY_ZOOM_MIN, SURVEY_ZOOM_SPEED_MAX_MUL, surveyCameraOf,
  type SurveySubjectDef,
} from '@/shared';
import { type ViewEntry, _camPos, _center, _dir, _v } from '../model';
import { recordOf } from './Store';
import type { SurveySystem } from '../SurveySystem';

/** Progress below this is treated as reached (float dust from `dt` sums). */
const EPS = 1e-9;

/** The frame's half extents in NDC and whether it is the zoomed (doubled) one — rewritten every frame. */
export interface FrameShape { halfW: number; halfH: number; zoomed: boolean }

/**
 * One body of `subject`: an axis-aligned box `x ± r`, `z ± r`, from `y0` up by `h`. Updates the kind's entry when
 * this body is a better view (in frame > crossing, then nearer).
 */
function consider(sys: SurveySystem, subject: SurveySubjectDef, x: number, y0: number, z: number, r: number, h: number, f: FrameShape): void {
  const cam = sys.ctx.camera;
  _center.set(x, y0 + h * 0.5, z);
  const dist = _center.distanceTo(_camPos);
  if (dist > SURVEY_MAX_RANGE_M + r) return;
  _v.copy(_center).applyMatrix4(cam.matrixWorldInverse);
  if (_v.z > -cam.near) return;                                   // behind the camera
  _v.applyMatrix4(cam.projectionMatrix);
  if (Math.abs(_v.x) > f.halfW || Math.abs(_v.y) > f.halfH) return;
  const entry = sys.views.get(subject.id);
  if (!entry) return;
  let status: 1 | 2 = 2;
  if (f.zoomed) {
    for (let i = 0; i < 8 && status === 2; i++) {
      _v.set(x + (i & 1 ? r : -r), y0 + (i & 2 ? h : 0), z + (i & 4 ? r : -r)).applyMatrix4(cam.matrixWorldInverse);
      if (_v.z > -cam.near) { status = 1; break; }
      _v.applyMatrix4(cam.projectionMatrix);
      if (Math.abs(_v.x) > f.halfW || Math.abs(_v.y) > f.halfH) status = 1;
    }
  }
  const fresh = entry.stamp !== sys.stamp;
  if (!fresh && (status < entry.status || (status === entry.status && dist >= entry.dist))) return;
  // line of sight last — the one query that costs: a hit short of the body's own near side hides it
  const world = sys.ctx.world;
  if (world) {
    _dir.copy(_center).sub(_camPos).divideScalar(Math.max(dist, EPS));
    const hit = world.raycast(_camPos, _dir, dist);
    if (hit && hit.distance < dist - r) return;
  }
  _v.set(x, y0 + h, z).project(cam);
  entry.stamp = sys.stamp;
  entry.status = status;
  entry.dist = dist;
  entry.lx = _v.x;
  entry.ly = _v.y;
}

/** Every body the world and the enemy list offer, by subject kind. */
export function scanBodies(sys: SurveySystem, f: FrameShape): void {
  const ctx = sys.ctx;
  const enemies = ctx.enemies?.getEnemies() ?? [];
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.isDead) continue;
    const s = sys.enemySubject.get(e.type);
    if (s) consider(sys, s, e.position.x, e.position.y, e.position.z, e.radius, e.height, f);
  }
  const world = ctx.world;
  if (!world || !world.ready) return;
  const nest = sys.kindSubject.nest;
  if (nest) {
    const holes = world.getNestPositions();
    for (let i = 0; i < holes.length; i++) consider(sys, nest, holes[i].x, holes[i].y, holes[i].z, nest.radius, nest.height, f);
  }
  const structures = world.getStructures?.() ?? [];
  for (let i = 0; i < structures.length; i++) {
    const st = structures[i];
    const s = sys.structureSubject.get(st.kind);
    if (s) consider(sys, s, st.position.x, st.position.y, st.position.z, st.radius, s.height, f);
  }
  const platform = sys.kindSubject.platform;
  const tram = sys.kindSubject.tram;
  if (platform) {
    const lines = world.getRailLines?.() ?? [];
    for (let i = 0; i < lines.length; i++) {
      const ps = lines[i].platforms;
      for (let k = 0; k < ps.length; k++) consider(sys, platform, ps[k].position.x, ps[k].position.y, ps[k].position.z, ps[k].radius, platform.height, f);
    }
  }
  if (tram) {
    const trams = world.getTrams?.() ?? [];
    for (let i = 0; i < trams.length; i++) consider(sys, tram, trams[i].position.x, trams[i].position.y, trams[i].position.z, tram.radius, tram.height, f);
  }
  const roverS = sys.kindSubject.rover;
  const rover = world.rover;
  if (roverS && rover) {
    const p = rover.vehicle.position;
    consider(sys, roverS, p.x, p.y, p.z, Math.max(rover.halfLength, rover.halfWidth), rover.height, f);
  }
}

/** Speed multiplier of the current zoom (1 unzoomed; 1 → `SURVEY_ZOOM_SPEED_MAX_MUL` across the zoom range). */
export function zoomSpeedMul(zoomed: boolean, zoom: number): number {
  if (!zoomed) return 1;
  const span = SURVEY_ZOOM_MAX - SURVEY_ZOOM_MIN;
  const t = span > 0 ? Math.max(0, Math.min(1, (zoom - SURVEY_ZOOM_MIN) / span)) : 1;
  return 1 + t * (SURVEY_ZOOM_SPEED_MAX_MUL - 1);
}

/** The camera instance in hand: its def's speed and whether it still has durability. Null when none is known. */
export function heldCamera(sys: SurveySystem): { speedMul: number; broken: boolean; uid: string } | null {
  const h = sys.ctx.weapons?.surveyHand;
  const cam = surveyCameraOf(h?.defId);
  if (!h || !h.uid || !cam) return null;
  const inst = sys.ctx.inventory?.findItem(h.uid) ?? null;
  const max = sys.ctx.loot?.getItemDef(cam.defId)?.durabilityMax ?? 0;
  const cur = inst?.durability ?? max;
  return { speedMul: cam.speedMul, broken: max > 0 && cur <= 0, uid: h.uid };
}

/**
 * One frame of recording for the kind of `entry` (status 2 only). Returns true when progress rose. Clamped by the
 * account ceiling (1) and the per-raid cap; ×`SURVEY_REPEAT_PLANET_MUL` when this planet was recorded before.
 */
export function gain(sys: SurveySystem, entry: ViewEntry, dt: number, speedMul: number): boolean {
  const s = entry.subject;
  const rec = recordOf(sys.save, s.id);
  if (rec.p >= 1 - EPS) return false;
  const used = sys.raidGained.get(s.id) ?? 0;
  const capLeft = s.raidCap - used;
  if (capLeft <= EPS) return false;
  let rate = speedMul / s.seconds;
  if (sys.raidPlanet && rec.pl.includes(sys.raidPlanet)) rate *= SURVEY_REPEAT_PLANET_MUL;
  const add = Math.min(rate * dt, capLeft, 1 - rec.p);
  if (!(add > 0)) return false;
  rec.p = Math.min(1, rec.p + add);
  if (rec.p >= 1 - EPS) rec.p = 1;
  sys.raidGained.set(s.id, used + add);
  sys.pendingPlanet.add(s.id);
  sys.gainsDirty = true;
  sys.dirty = true;
  sys.emitPercent(s.id, rec.p);
  if (rec.p >= 1) sys.bus.emit('ui:notify', { text: `조사 완료 — ${s.name}`, kind: 'success' });
  else if (used + add >= s.raidCap - EPS && !sys.capNotified.has(s.id)) {
    sys.capNotified.add(s.id);
    sys.bus.emit('ui:notify', { text: `${s.name} — 이번 레이드 조사 한도`, kind: 'info' });
  }
  return true;
}

/** Camera wear for `dt` seconds of recording, applied in whole durability units. */
export function wear(sys: SurveySystem, uid: string, dt: number): void {
  sys.wearAcc += SURVEY_CAMERA_WEAR_PER_S * dt;
  if (sys.wearAcc < 1) return;
  const n = Math.floor(sys.wearAcc);
  sys.wearAcc -= n;
  sys.ctx.inventory?.damageDurability(uid, n);
}

/** Throttled warning toast (`SURVEY_NOTIFY_INTERVAL_S`). */
export function warn(sys: SurveySystem, text: string): void {
  const now = sys.ctx.time;
  if (now - sys.notifyAt < SURVEY_NOTIFY_INTERVAL_S) return;
  sys.notifyAt = now;
  sys.bus.emit('ui:notify', { text, kind: 'warning' });
  sys.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
}
