/**
 * src/weapons/parts/AimLine.ts — **총알은 어느 선을 따라 나가나** (하이브리드 판정, 2026-09-12 사용자 결정).
 *
 * 3인칭 카메라는 어깨 뒤에 있고 총구는 그보다 옆 · 아래에 있다. 예전에는 모든 사격이 총구에서 나가 카메라 레이가 맞춘
 * 점으로 수렴했는데, 그래서 두 가지가 틀어졌다.
 *  1. 크로스헤어가 빈 공간(하늘 · 사거리 밖)을 가리키면 수렴점이 사거리 끝이라, 중간 거리에서 총알이 크로스헤어 선보다
 *     ~0.3 m 왼쪽을 지나 조준하지 않은 것을 맞혔다 ("거리에 따라 가끔 왼쪽으로 날아간다").
 *  2. 크로스헤어 선은 비켜 가는데 총구 선만 걸리는 가장자리(창틀 · 엄폐물 · 바위 모서리)에 맞았고, 쏘기 전에는 알 길이 없었다.
 *
 * 다른 3인칭 슈터들이 쓰는 해법(카메라 선으로 판정 + 총구 앞 짧은 구간만 막힘 검사 + 막힌 자리 표시)을 따른다:
 *  - **판정선** = 크로스헤어 선. 카메라와 몸 사이는 보지 않도록 **총구 깊이의 점 `P0`** 에서 시작한다.
 *  - **총열 검사** = 몸 축(총구 높이) → 총구. 벽에 붙어 총열이 벽을 뚫고 나가 있으면 여기서 걸린다.
 *  - **막힘 검사** = 총구 → 크로스헤어 점의 앞 `WEAPON_MUZZLE_BLOCK_RANGE` m. 여기서 걸리면 총알은 거기에 맞는다.
 *    그 자리가 크로스헤어가 가리키는 곳이 아니면 `obstructed` — 벽의 빨간 원(`fx/AimBlockMarker`)과 크로스헤어
 *    경고색(`weapon:aimBlocked` → ui)이 이 값 하나를 본다.
 *  - **`P0` 가 총구에서 안 보이면**(옆 벽에 붙어 카메라 선의 시작점이 벽 너머) 예전 수렴 방식으로 돌아간다 — 그때
 *    크로스헤어 선을 믿으면 벽을 뚫는다.
 * 그 너머의 장애물은 크로스헤어 선이 판정하므로 멀리 있는 바위 모서리는 카메라에 보이면 넘겨 쏠 수 있다 — 사용자가 고른 대가다.
 *
 * **미리보기와 실제 사격이 같은 함수다** (`begin` + `resolve`): `fire()` · 유니크 `hitscan` / `aimShot` · 빨간 원이 전부 이것을 부른다.
 */
import * as THREE from 'three';
import { WEAPON_MUZZLE_BLOCK_RANGE, type GameContext, type UniqueWeaponKind } from '@/shared';
import { AIM_BLOCK_SAME_EPS, makeHit, type HitInfo, type Host, type WeaponInstance } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/** `line` = 크로스헤어 선 · `near` = 총열 / 총구 앞에서 걸림 · `converge` = `P0` 가 가려져 총구 → 크로스헤어 점으로 수렴. */
export type ShotMode = 'line' | 'near' | 'converge';

/** One resolved shot. The vectors belong to this object; `hit` is the resolver's scratch — use it before the next `resolve`. */
export interface ShotLine {
  mode: ShotMode;
  /** Where the bullet / projectile leaves (falloff distances are measured from here). */
  readonly origin: THREE.Vector3;
  /** Unit direction it flies. */
  readonly dir: THREE.Vector3;
  /** What it meets within range, null = nothing. */
  hit: HitInfo | null;
  /** Where the shot ends: the hit point, else the far end of the line. */
  readonly end: THREE.Vector3;
  /** The crosshair point: first thing on the crosshair line (from `P0`), else its far end. */
  readonly target: THREE.Vector3;
  /** A wall / cover near the barrel takes the shot instead of the crosshair point (never an enemy or a shell). */
  obstructed: boolean;
}

export function makeShotLine(): ShotLine {
  return { mode: 'line', origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), hit: null, end: new THREE.Vector3(), target: new THREE.Vector3(), obstructed: false };
}

/** What the resolver needs from its owner (structural, so this part never imports the system class as a value). */
export interface AimLineHost {
  readonly ctx: GameContext;
  raycastAll(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: HitInfo): void;
}

/** The body-axis anchor of the barrel check never starts under the terrain (prone on a downslope). */
const ANCHOR_GROUND_CLEARANCE = 0.1;
/** Weapons without a single impact point (cones / chain arcs) never show the marker. */
const CONE_UNIQUES: ReadonlySet<UniqueWeaponKind> = new Set<UniqueWeaponKind>(['flamethrower', 'shockgun']);

const _seg = new THREE.Vector3(), _p0 = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _ao = new THREE.Vector3(), _ad = new THREE.Vector3(), _am = new THREE.Vector3();

/**
 * The barrel and line-start checks look for **walls** only (terrain · obstacles · barriers · deployables). An enemy hugging
 * the player overlaps the body-axis → muzzle segment without the gun being "through" anything; the shot then starts at the
 * muzzle as usual and the near check in front of it decides. (Found by smoke-uniques: an air-burst rocket jump over a bug
 * standing at the feet was launched horizontally from the body axis into the bug instead of down at the ground.)
 */
function isWall(h: HitInfo): boolean { return h.valid && !h.enemy && !h.intercept; }

/** `out` = the crosshair line's start at the muzzle's depth; returns that depth (≥ 0.05 m). */
function lineStart(aimO: THREE.Vector3, dir: THREE.Vector3, muzzle: THREE.Vector3, out: THREE.Vector3): number {
  const depth = Math.max(0.05, _tmp.subVectors(muzzle, aimO).dot(dir));
  out.copy(aimO).addScaledVector(dir, depth);
  return depth;
}

export class ShotResolver {
  private readonly muzzle = new THREE.Vector3();
  private readonly aimO = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly barrelDir = new THREE.Vector3();
  private readonly lineHit = makeHit();
  private readonly nearHit = makeHit();
  private readonly convHit = makeHit();
  private readonly barrelHit = makeHit();
  private readonly probeHit = makeHit();
  /** Body axis → muzzle meets something: the barrel pokes through a wall. */
  private barrelBlocked = false;
  /** Muzzle → `P0` meets something: the crosshair line starts behind a wall beside the gun. */
  private lineStartBlocked = false;

  constructor(private readonly owner: AimLineHost) {}

  /**
   * Per trigger pull (or per marker frame): the checks that do not depend on the spread direction — the barrel and
   * whether the crosshair line's start is visible from the muzzle. `aimDir` is the unspread aim direction.
   */
  begin(host: Host, muzzle: THREE.Vector3, aimO: THREE.Vector3, aimDir: THREE.Vector3): void {
    const o = this.owner;
    this.muzzle.copy(muzzle);
    this.aimO.copy(aimO);
    const a = this.anchor.set(host.position.x, muzzle.y, host.position.z);
    const world = o.ctx.world;
    if (world && world.ready) a.y = Math.max(a.y, world.getHeightAt(a.x, a.z) + ANCHOR_GROUND_CLEARANCE);
    _seg.subVectors(muzzle, a);
    const len = _seg.length();
    this.barrelBlocked = false;
    this.barrelDir.copy(aimDir);
    if (len > 1e-3) {
      this.barrelDir.copy(_seg).divideScalar(len);
      o.raycastAll(a, this.barrelDir, len, this.barrelHit);
      this.barrelBlocked = isWall(this.barrelHit);
    }
    this.lineStartBlocked = false;
    if (!this.barrelBlocked) {
      lineStart(aimO, aimDir, muzzle, _p0);
      _seg.subVectors(_p0, muzzle);
      const lat = _seg.length();
      if (lat > 1e-3) {
        o.raycastAll(muzzle, _seg.divideScalar(lat), lat, this.probeHit);
        this.lineStartBlocked = isWall(this.probeHit);
      }
    }
  }

  /** Resolve one shot along `dir` (the spread direction; `begin` must have run this frame for the same muzzle). */
  resolve(dir: THREE.Vector3, range: number, out: ShotLine): ShotLine {
    const o = this.owner, m = this.muzzle;
    const depth = lineStart(this.aimO, dir, m, _p0);
    const rest = Math.max(0.05, range - depth);
    o.raycastAll(_p0, dir, rest, this.lineHit);
    if (this.lineHit.valid) out.target.copy(this.lineHit.point); else out.target.copy(_p0).addScaledVector(dir, rest);
    out.obstructed = false;

    // the gun's direction toward the crosshair point
    _seg.subVectors(out.target, m);
    const mdist = _seg.length();
    if (mdist > 1e-3) _seg.divideScalar(mdist); else _seg.copy(dir);

    // ① the barrel is through a wall: the shot stops on it (a projectile starts behind it, on the body axis)
    if (this.barrelBlocked) return this.near(out, this.barrelHit, this.anchor, this.barrelDir);
    // ② something in the gun's first metres
    if (mdist > 1e-3) {
      o.raycastAll(m, _seg, Math.min(WEAPON_MUZZLE_BLOCK_RANGE, mdist + 0.05), this.nearHit);
      if (this.nearHit.valid) return this.near(out, this.nearHit, m, _seg);
    }
    // ③ the crosshair line starts behind a wall beside the gun: trust the gun line instead (old convergence)
    if (this.lineStartBlocked && mdist > 1e-3) {
      o.raycastAll(m, _seg, mdist + 0.05, this.convHit);
      out.mode = 'converge';
      out.origin.copy(m); out.dir.copy(_seg);
      out.hit = this.convHit.valid ? this.convHit : this.lineHit.valid ? this.lineHit : null;
      out.end.copy(out.hit ? out.hit.point : out.target);
      return out;
    }
    // ④ the crosshair line decides
    out.mode = 'line';
    out.origin.copy(_p0); out.dir.copy(dir);
    out.hit = this.lineHit.valid ? this.lineHit : null;
    out.end.copy(out.target);
    return out;
  }

  private near(out: ShotLine, h: HitInfo, origin: THREE.Vector3, dir: THREE.Vector3): ShotLine {
    out.mode = 'near';
    out.origin.copy(origin); out.dir.copy(dir);
    out.hit = h;
    out.end.copy(h.point);
    // aiming straight at a wall 2 m ahead is not an obstruction — the gun meets the crosshair's own point
    out.obstructed = !h.enemy && !h.intercept && h.point.distanceTo(out.target) > AIM_BLOCK_SAME_EPS;
    return out;
  }
}

/**
 * 총구 막힘 표시 (every frame, after the trigger logic). Runs the very resolver `fire()` uses with the unspread aim, puts
 * the red marker on the obstruction and emits `weapon:aimBlocked` on change. Off while no line weapon is ready in hand.
 */
export function updateAimBlock(sys: WeaponSystem, host: Host, weapon: WeaponInstance | null, armedAndFree: boolean): void {
  const w = weapon;
  if (!w || sys.holstered || !armedAndFree || sys.phase === 'swapping' || (w.def.unique && CONE_UNIQUES.has(w.def.unique))) {
    setAimBlocked(sys, false);
    return;
  }
  const ctx = sys.ctx;
  host.getAimRay(_ao, _ad);
  w.model.muzzle.updateWorldMatrix(true, false);
  _am.setFromMatrixPosition(w.model.muzzle.matrixWorld);
  sys.aim.begin(host, _am, _ao, _ad);
  const s = sys.aim.resolve(_ad, w.def.range, sys.aimLine);
  const blocked = s.obstructed && s.hit !== null;
  if (blocked && s.hit) sys.aimMarker.show(s.hit.point, s.hit.normal, s.dir, ctx.camera, ctx.time);
  setAimBlocked(sys, blocked);
}

/** Marker off when clear; `weapon:aimBlocked` only when the state changes. */
export function setAimBlocked(sys: WeaponSystem, blocked: boolean): void {
  if (!blocked) sys.aimMarker?.hide();
  if (sys.aimBlocked === blocked) return;
  sys.aimBlocked = blocked;
  sys.ctx.bus.emit('weapon:aimBlocked', { blocked });
}
