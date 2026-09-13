import * as THREE from 'three';
import type { CookBeatAction, CookGame, CookLiquid, FurniturePose, GameContext } from '@/shared';
import { yawFromForward } from './GeoBatch';
import { roomBox } from './RoomLayout';
import { CAMERA_WALL_MARGIN, segmentHits, type FootBox, type StagedPiece } from './GymStaging';
import { BEAKER_IDLE_LEVEL, COOK_TOOLS, cookToolTarget, liquidMat, poseCookKnife, restCookRig, type CookRig, type CookTool } from './FurnitureKitchen';

/* ────────────────────────────────────────────────────────────────────────────
 * 조리 연출 (2026-09-13, 요리 미니게임 — docs/plans/cooking-minigames.md §6-4). `GymStaging` 을 본뜬다.
 *
 *   housing:cookSession {active:true}  → 그 조리대 앞 바닥 anchor · 조리대를 보는 yaw · 어깨 너머 고정 카메라
 *                                         → setFurniturePose({kind:'cook'}) (false 면 cancelCook)
 *   housing:cookStep                   → 지금 단계 게임의 도구(도마 · 그릴 팬 · 웍 · 냄비 · 비커)가 작업 자리로 나온다 (`CookRig`)
 *   housing:cookBeat                   → 손 동작 누적 위상: 썰기 · 다지기 · 볶기 = 입력마다 **한 주기**를 빠르게 (칼이 위 → 도마 → 위,
 *                                         웍은 튕긴다), 젓기 = `stir` 가 오는 동안 연속으로 돈다, 굽기 · 붓기 · 단계 사이 = 느린 흔들림.
 *                                         굽기의 뒤집기 · 꺼내기 · 탐은 그릴 팬이 살짝 들썩이고, 붓기는 부는 동안 비커 액체가 오른다.
 *   housing:cookSession {active:false} → 자세를 풀고 도구는 제자리로 미끄러져 돌아간다
 *   player:furniturePoseEnded (cook, 우리가 푼 것이 아니면) → cancelCook (자세 없이 미니게임만 남지 않게)
 *
 * 위상은 player 의 `FURN_COOK` 규약(한 주기 = 1, φ 0 = 칼이 위 · 0.5 = 도마에 닿음)이고 `setFurniturePoseDrive` 에는 소수부를 넘긴다 —
 * player 가 감김으로 주기 수를 센다. 칼 · 국자 · 웍이 **같은 위상**을 읽는다. 조각은 늘 uid 로 다시 찾는다(방이 다시 지어지면 그룹이
 * 바뀐다) — 도구 자리는 이 객체가 들고 있다가 매 프레임 새 그룹에 쓰고, `BuildExtra.cookGame` 이 재빌드된 모델을 같은 자리에 짓는다.
 * ──────────────────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const frac = (x: number): number => x - Math.floor(x);

/** 도구가 쉬는 자리 ↔ 작업 자리로 옮겨 가는 감쇠 계수 · 옮겨 가는 동안 드는 높이 상한 (m) · 도착으로 보는 거리 (m). */
const TOOL_RATE = 9;
const TOOL_ARC = 0.08;
const TOOL_SETTLED = 0.004;
/** 입력 하나가 한 주기를 도는 시간 (초) — 칼질 · 다지기(더 짧게) · 웍 튕김. */
const STROKE_S: Readonly<Partial<Record<CookBeatAction, number>>> = { cut: 0.24, mince_h: 0.15, mince_v: 0.15, toss: 0.34 };
/** 박자 게임으로 넘어갈 때 반쯤 돈 손을 한 주기 끝(칼이 위)까지 마저 돌리는 시간 (초). */
const FINISH_STROKE_S = 0.4;
/** 젓기: 마지막 `stir` 뒤 이만큼(초)은 계속 돈다 (housing 은 누르는 동안 주기적으로 보낸다) · 도는 속도 (주기 / 초). */
const STIR_HOLD_S = 0.45;
const STIR_REV_PER_S = 1.25;
/** 굽기 · 붓기 · 단계 사이의 느린 흔들림 (주기 / 초). */
const SWAY_PER_S = 0.3;
/** 한 프레임에 위상이 넘어갈 수 있는 최대 (player 의 감김 판정이 반 주기 안쪽이어야 한다) · 밀린 입력이 쌓여도 남기는 최대 주기. */
const MAX_CYCLE_STEP = 0.45;
const MAX_CYCLE_LAG = 2;
const WOK_TOSS_LIFT = 0.06;
const WOK_TOSS_TILT = 0.28;
const GRILL_HOP_S = 0.3;
const GRILL_HOP_LIFT = 0.025;
/** 붓기: 단계 시작 액체 높이 · 부는 동안 오르는 속도 (/초) · 상한 · 자동으로 넘긴 단계의 높이. */
const POUR_START_LEVEL = 0.08;
const POUR_FILL_PER_S = 0.22;
const POUR_MAX_LEVEL = 0.95;
const POUR_AUTO_LEVEL = 0.7;

/**
 * 어깨 너머 카메라 후보 (조리대 로컬, anchor 기준 m): 옆 (−1 = **오른 어깨** — 조리대를 보는 몸의 오른쪽이 로컬 −X) × 옆 거리 ×
 * 뒤 거리 × 높이. 오른 어깨 · 낮게 · 가깝게를 좋아하고, 방 벽 · 같은 방 다른 가구 · 조리대의 후드 · 몸(머리와 어깨)에 시선이 가리면
 * 크게 깎는다. 높이 2.25 m 이상인 이유: 칼 쥔 손(몸 오른쪽 0.1 m 앞 0.52 m)을 보는 선이 오른 어깨를 넘어가야 한다.
 */
const CAM_SIDES = [-1, 1] as const;
const CAM_LATERAL = [0.95, 0.7] as const;
const CAM_BACK = [0.55, 0.85] as const;
const CAM_HEIGHT = [2.25, 2.5] as const;
/** 가림 판정에 쓰는 몸 (anchor 기준 로컬 상자 — 숙인 머리 · 어깨) · 머리 높이 (`FURN_EYE.cook` 1.42 + 조금). */
const BODY = { halfX: 0.28, minY: 1.25, maxY: 1.85, back: 0.15, front: 0.18 } as const;
const HEAD_Y = 1.5;

const _c = new THREE.Vector3();
const _f = new THREE.Vector3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _target = new THREE.Vector3();

/** 로컬 상자 (min, max) 를 조각 그룹의 월드 AABB 로 (가구 yaw 는 사분회전뿐이라 꼭짓점 8개로 충분하다). */
function worldBox(g: THREE.Object3D, min: THREE.Vector3, max: THREE.Vector3): FootBox {
  const out: FootBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < 8; i++) {
    _c.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
    g.localToWorld(_c);
    out.minX = Math.min(out.minX, _c.x); out.maxX = Math.max(out.maxX, _c.x);
    out.minY = Math.min(out.minY, _c.y); out.maxY = Math.max(out.maxY, _c.y);
    out.minZ = Math.min(out.minZ, _c.z); out.maxZ = Math.max(out.maxZ, _c.z);
  }
  return out;
}
const inside = (p: THREE.Vector3, b: FootBox): boolean => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ;

/** 조리대의 어깨 너머 고정 카메라 (후보 점수 — 위 `CAM_*` 주석). 세션 시작에 한 번 도는 코드라 할당은 신경 쓰지 않는다. */
export function cookCameraOf(piece: StagedPiece, rig: CookRig, blockers: readonly FootBox[] = []): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const a = rig.anchor;
  const lookAt = g.localToWorld(rig.focus.clone());
  const head = g.localToWorld(new THREE.Vector3(a.x, a.y + HEAD_Y, a.z));
  const body = worldBox(g, _min.set(a.x - BODY.halfX, a.y + BODY.minY, a.z - BODY.back), _max.set(a.x + BODY.halfX, a.y + BODY.maxY, a.z + BODY.front));
  const hood = worldBox(g, rig.hood.min, rig.hood.max);
  const box = roomBox(piece.item.room);
  const p = new THREE.Vector3();
  let best: THREE.Vector3 | null = null, bestCost = Infinity;
  for (const side of CAM_SIDES) for (const lat of CAM_LATERAL) for (const back of CAM_BACK) for (const y of CAM_HEIGHT) {
    p.set(a.x + side * lat, a.y + y, a.z - back);
    g.localToWorld(p);
    let cost = (side > 0 ? 0.5 : 0) + (y - CAM_HEIGHT[0]) * 0.8 + (CAM_LATERAL[0] - lat) * 0.3 + (back - CAM_BACK[0]) * 0.2;
    if (box) {
      const minX = box.minX + CAMERA_WALL_MARGIN, maxX = box.maxX - CAMERA_WALL_MARGIN;
      const minZ = box.minZ + CAMERA_WALL_MARGIN, maxZ = box.maxZ - CAMERA_WALL_MARGIN;
      const over = Math.max(0, minX - p.x, p.x - maxX) + Math.max(0, minZ - p.z, p.z - maxZ);
      if (over > 0) {
        cost += 4 + over * 4;
        p.x = THREE.MathUtils.clamp(p.x, minX, maxX);
        p.z = THREE.MathUtils.clamp(p.z, minZ, maxZ);
      }
    }
    if (segmentHits(p, lookAt, body)) cost += 2;
    if (segmentHits(p, lookAt, hood)) cost += 3;
    for (const b of blockers) {
      if (inside(p, b)) cost += 6;
      if (segmentHits(p, lookAt, b)) cost += 3;
      if (segmentHits(p, head, b)) cost += 1.5;
    }
    if (cost < bestCost) { bestCost = cost; best = (best ?? new THREE.Vector3()).copy(p); }
  }
  return { position: best ?? lookAt.clone().add(_f.set(0, 1.2, 0)), lookAt };
}

/** 조리대 앞 자세 한 벌 (anchor = 조리대 앞 바닥 · 조리대를 보는 yaw · 어깨 너머 카메라). 조리대가 아니면 null. */
export function cookPoseOf(piece: StagedPiece, blockers: readonly FootBox[] = []): FurniturePose | null {
  const rig = piece.model.cook;
  if (!rig) return null;
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const anchor = g.localToWorld(rig.anchor.clone());
  _f.set(rig.forward.x, 0, rig.forward.z).transformDirection(g.matrixWorld);
  return {
    kind: 'cook', anchor, yaw: yawFromForward(_f.x, _f.z), camera: cookCameraOf(piece, rig, blockers),
    releaseOnInteract: false, furnitureUid: piece.item.uid,
  };
}

const isStrikeGame = (g: CookGame | null): boolean => g === 'chop' || g === 'mince' || g === 'stirfry';

/** 조리 세션 연출. `FurnitureLayer` 가 자기 함선(방문 중이 아닌)일 때만 만든다. */
export class CookStaging {
  /** 연출 중인 조리대 uid, 없으면 null. */
  uid: string | null = null;
  /** 지금 단계의 게임 (조리 중이 아니면 null). */
  game: CookGame | null = null;
  /** 조리가 끝나 도구가 제자리로 돌아가는 중인 조리대. */
  private settleUid: string | null = null;
  private releasing = false;
  private readonly unsubs: Array<() => void> = [];
  private clock = 0;
  /** 손 동작 누적 위상 · 입력이 쌓아 둔 목표 · 목표를 쫓는 속도 (주기 / 초). */
  private cycle = 0;
  private target = 0;
  private rate = 1 / FINISH_STROKE_S;
  private stirUntil = -1;
  private pouring = false;
  private level = BEAKER_IDLE_LEVEL;
  private liquid: CookLiquid | null = null;
  private stepIndex = -1;
  private hop = 1;
  private readonly pos: Record<CookTool, THREE.Vector3> = {
    board: new THREE.Vector3(), pot: new THREE.Vector3(), wok: new THREE.Vector3(), grill: new THREE.Vector3(), beaker: new THREE.Vector3(),
  };

  /** `find` = uid 로 지금의 조각, `blockers` = 그 조각과 같은 방의 다른 가구 상자 (카메라 가림). */
  constructor(private readonly ctx: GameContext, private readonly find: (uid: string) => StagedPiece | null, private readonly blockers: (uid: string) => readonly FootBox[] = () => []) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:cookSession', (e) => this.onSession(e.uid, e.active)),
      b.on('housing:cookStep', (e) => this.onStep(e.uid, e.index, e.game, e.phase, e.auto)),
      b.on('housing:cookBeat', (e) => this.onBeat(e.uid, e.action)),
      b.on('player:furniturePoseEnded', (e) => {
        // 조리 자세가 우리 손을 거치지 않고 풀렸다 (페이즈 변경 · 스폰 · hub:left 의 reset) → 미니게임도 거둔다
        if (!this.uid || this.releasing || e.kind !== 'cook') return;
        this.stop(false);
        this.cancelHousing();
      }),
    );
  }

  /** 이 조리대로 조리 중이면 지금 단계의 게임 (`BuildExtra.cookGame`), 아니면 null. */
  gameFor(uid: string): CookGame | null {
    return uid === this.uid ? this.game : null;
  }

  /** 디버그 · 스모크: 연출 중인 조리대 · 게임 · 누적 위상 · 작업 자리에 나와 있는 도구. 조리 중이 아니면 null. */
  get stage(): { uid: string; game: CookGame | null; phase: number; atWork: CookTool | null } | null {
    if (!this.uid) return null;
    const rig = this.find(this.uid)?.model.cook;
    let atWork: CookTool | null = null;
    if (rig) for (const t of COOK_TOOLS) { const p = this.pos[t]; if (Math.hypot(p.x - rig.work.x, p.z - rig.work.z) < 0.02) atWork = t; }
    return { uid: this.uid, game: this.game, phase: this.cycle, atWork };
  }

  private onSession(uid: string, active: boolean): void {
    if (!active) { if (this.uid === uid) this.stop(true); return; }
    if (this.uid && this.uid !== uid) this.stop(true);
    const piece = this.find(uid);
    const rig = piece?.model.cook;
    if (!piece || !rig) { this.cancelHousing(); return; }
    const fresh = this.uid !== uid;
    if (fresh) {
      // 다른 조리대가 제자리로 돌아가던 중이면 그 자리에 박고, 같은 조리대면 지금 미끄러지던 자리에서 이어 간다
      if (this.settleUid && this.settleUid !== uid) { const other = this.find(this.settleUid)?.model.cook; if (other) restCookRig(other); }
      if (this.settleUid !== uid) for (const t of COOK_TOOLS) this.pos[t].copy(rig.tools[t].position);
      this.settleUid = null;
      this.uid = uid;
      this.stepIndex = -1; this.stirUntil = -1; this.pouring = false; this.hop = 1; this.liquid = null; this.level = BEAKER_IDLE_LEVEL;
      this.target = this.cycle;
      const s = this.ctx.housing?.cookSession;
      this.game = s && s.uid === uid ? (s.steps[0]?.game ?? null) : null;
    }
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function') return;   // player 가 아직 자세를 모른다 — 미니게임은 그대로 둔다
    if (!fresh && p.furniturePose === 'cook') return;              // 같은 세션을 다시 알렸다 — 다시 걸면 풀 때 돌아갈 자리가 조리대 앞이 된다
    const pose = cookPoseOf(piece, this.blockers(uid));
    let ok = false;
    // 우리 호출 안에서 나오는 자세 끝 알림(앉아 있던 흔들의자 · 이전 자세)은 우리 것이다
    this.releasing = true;
    try { ok = pose !== null && p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose(cook) failed', err); } finally { this.releasing = false; }
    if (!ok) { this.stop(false); this.cancelHousing(); }
  }

  private onStep(uid: string, index: number, game: CookGame, phase: 'choose' | 'play' | 'done', auto: boolean): void {
    if (uid !== this.uid) return;
    if (game !== this.game) {
      // 박자 게임으로 넘어가면 반쯤 돈 손을 한 주기 끝까지 마저 돌려 칼이 위에서 시작한다
      if (isStrikeGame(game)) { this.target = Math.max(this.target, Math.ceil(this.cycle - 1e-6)); this.rate = 1 / FINISH_STROKE_S; }
      this.game = game;
    }
    if (index !== this.stepIndex) {
      this.stepIndex = index;
      this.stirUntil = -1; this.pouring = false; this.hop = 1;
      const step = this.ctx.housing?.cookSession?.steps[index];
      this.liquid = step?.liquid ?? null;
      this.level = game === 'pour' ? POUR_START_LEVEL : BEAKER_IDLE_LEVEL;
    }
    if (phase === 'done') {
      this.stirUntil = -1; this.pouring = false;
      if (game === 'pour' && auto) this.level = POUR_AUTO_LEVEL;
    }
  }

  private onBeat(uid: string, action: CookBeatAction): void {
    if (uid !== this.uid) return;
    const s = STROKE_S[action];
    if (s !== undefined) {
      this.target = Math.max(this.target, Math.ceil(this.cycle - 1e-6)) + 1;
      this.rate = 1 / s;
      return;
    }
    if (action === 'stir') this.stirUntil = this.clock + STIR_HOLD_S;
    else if (action === 'pour_start') this.pouring = true;
    else if (action === 'pour_stop') this.pouring = false;
    else this.hop = 0;   // flip · remove · burn — 그릴 팬이 들썩인다
  }

  /** 손 동작 위상을 민다 — 쌓인 입력 → 젓기 → 느린 흔들림 순. 박자 게임은 입력 사이에 멈춰 칼이 위에 있다. */
  private advance(dt: number): void {
    const game = this.game;
    let step = 0;
    if (this.cycle < this.target - 1e-6) {
      if (this.target - this.cycle > MAX_CYCLE_LAG) this.cycle = this.target - MAX_CYCLE_LAG;
      step = Math.min(this.target - this.cycle, dt * this.rate);
    } else if (game === 'stir') {
      if (this.clock < this.stirUntil) step = dt * STIR_REV_PER_S;
    } else if (!isStrikeGame(game)) {
      step = dt * SWAY_PER_S;
    }
    this.cycle += Math.min(step, MAX_CYCLE_STEP);
    if (this.target < this.cycle) this.target = this.cycle;
  }

  /** 매 프레임 (`FurnitureLayer.update`). */
  update(dt: number): void {
    this.clock += dt;
    const uid = this.uid ?? this.settleUid;
    if (!uid) return;
    const rig = this.find(uid)?.model.cook;
    if (!rig) {
      if (this.uid) { this.stop(true); this.cancelHousing(); }   // 세션 도중 조리대가 사라졌다
      else this.settleUid = null;
      return;
    }
    const game = this.uid ? this.game : null;
    if (this.uid) this.advance(dt);
    const k = 1 - Math.exp(-TOOL_RATE * dt);
    let settled = true;
    for (const t of COOK_TOOLS) {
      const tg = cookToolTarget(rig, t, game, _target);
      const p = this.pos[t];
      p.x += (tg.x - p.x) * k; p.y += (tg.y - p.y) * k; p.z += (tg.z - p.z) * k;
      const dist = Math.hypot(tg.x - p.x, tg.z - p.z);
      if (dist < TOOL_SETTLED) p.copy(tg); else settled = false;
      const grp = rig.tools[t];
      grp.position.set(p.x, p.y + Math.min(TOOL_ARC, dist * 0.6), p.z);
      grp.rotation.set(0, 0, 0);
    }
    const ph = frac(this.cycle);
    poseCookKnife(rig, game === 'chop' || game === 'mince', this.cycle);
    rig.ladle.rotation.y = game === 'stir' ? -TAU * ph : 0;
    if (game === 'stirfry') {
      const s = Math.sin(Math.PI * ph);
      rig.tools.wok.position.y += WOK_TOSS_LIFT * s;
      rig.tools.wok.rotation.z = -WOK_TOSS_TILT * s;
    }
    if (this.hop < 1) {
      this.hop = Math.min(1, this.hop + dt / GRILL_HOP_S);
      if (game === 'grill') rig.tools.grill.position.y += GRILL_HOP_LIFT * Math.sin(Math.PI * this.hop);
    }
    if (game === 'pour' && this.pouring) this.level = Math.min(POUR_MAX_LEVEL, this.level + dt * POUR_FILL_PER_S);
    rig.liquid.scale.y = Math.max(0.04, this.level);
    if (rig.liquidMesh && this.liquid) {
      const m = liquidMat(this.liquid);
      if (rig.liquidMesh.material !== m) rig.liquidMesh.material = m;
    }
    if (!this.uid) {
      if (settled) { restCookRig(rig); this.settleUid = null; }
      return;
    }
    const pl = this.ctx.player;
    if (pl && typeof pl.setFurniturePoseDrive === 'function' && pl.furniturePose === 'cook') {
      try { pl.setFurniturePoseDrive(ph); } catch { /* player mid-build */ }
    }
  }

  /** 연출을 거둔다 (도구는 `update` 가 제자리로 미끄러뜨린다). `release` = 플레이어 자세도 푼다. */
  private stop(release: boolean): void {
    const uid = this.uid;
    this.uid = null;
    this.game = null;
    this.stepIndex = -1; this.stirUntil = -1; this.pouring = false; this.hop = 1;
    this.liquid = null; this.level = BEAKER_IDLE_LEVEL;
    this.settleUid = uid;
    if (!release) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function' || p.furniturePose !== 'cook') return;
    this.releasing = true;
    try { p.setFurniturePose(null); } catch { /* player mid-build */ } finally { this.releasing = false; }
  }

  private cancelHousing(): void {
    const h = this.ctx.housing;
    if (h && typeof h.cancelCook === 'function') {
      try { h.cancelCook(); } catch (err) { console.warn('[hub] cancelCook failed', err); }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.uid) { this.stop(true); this.cancelHousing(); }
    const settle = this.settleUid;
    this.settleUid = null;
    const rig = settle ? this.find(settle)?.model.cook : undefined;
    if (rig) restCookRig(rig);
  }
}
