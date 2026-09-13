import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { EXTRACTION_CINEMATIC_BLEND_S } from '@/shared';
import type { Dropship } from './Ship';

/**
 * src/extraction/Cinematic.ts — **이륙 연출 카메라** (2026-09-13 탈출 개편, 사용자 결정).
 *
 * 이 파일이 답하는 질문: *출발 유예가 끝나 함선에 실려 떠나는 사람의 화면에 무엇이 보이는가.*
 *
 * 캐릭터 카메라 → 함선 뒤쪽 외부 카메라로 `EXTRACTION_CINEMATIC_BLEND_S` 에 걸쳐 부드럽게 넘어가고, 그 뒤로는 날아가는
 * 함선을 **늦게 따라간다**(감쇠 추적) — 함선이 가속하면 카메라가 뒤처져 하늘로 멀어지는 모습이 된다. HUD 는
 * `ui:cinematic` 으로 ui/ 가 스르륵 숨긴다.
 *
 * 블렌드는 `PlayerRef.setCameraOverride` 의 감쇠(12)에 맡기지 않고 여기서 직접 한다: 매 프레임 `snap = true` 로 **이미
 * 섞은** 자리를 넘기므로, 시작 프레임의 오버라이드 자리가 곧 지금 카메라 자리라 튀지 않는다. 호출은 `update` 에서 —
 * extraction 은 player 뒤에 등록돼 있고 오버라이드는 player 의 `lateUpdate` 가 소비한다.
 */

/** Settled shot: behind-right of the ship and a little above its deck, in the ship's yaw frame (local +Z = rear). */
const CAM_OFFSET = new THREE.Vector3(7.5, 3.2, 17);
/** Where the shot looks: the middle of the hull (ship-local, full attitude). */
const LOOK_LOCAL = new THREE.Vector3(0, 1.6, -3);
/** Follow rate (1/s) of the chase point — low, so the accelerating ship pulls away from the camera. */
const FOLLOW_RATE = 1.1;
/** Never put the camera underground. */
const MIN_ABOVE_TERRAIN = 1.5;

const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _outLook = new THREE.Vector3();

const smooth = (t: number): number => t * t * (3 - 2 * t);

export class DepartureCinematic {
  active = false;
  private t = 0;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromLook = new THREE.Vector3();
  private readonly chase = new THREE.Vector3();

  start(ctx: GameContext, ship: Dropship): void {
    this.active = true;
    this.t = 0;
    const cam = ctx.camera;
    this.fromPos.copy(cam.position);
    cam.getWorldDirection(_dir);
    this.fromLook.copy(cam.position).addScaledVector(_dir, 12);
    this.target(ship, this.chase);
    // an open screen would sit over the shot and keep the cursor — the ride is not interactive any more
    ctx.inventory?.closeAll();
    ctx.bus.emit('ui:cinematic', { active: true });
  }

  update(dt: number, ctx: GameContext, ship: Dropship): void {
    if (!this.active) return;
    this.t += dt;
    this.target(ship, _target);
    this.chase.lerp(_target, 1 - Math.exp(-FOLLOW_RATE * dt));
    const world = ctx.world;
    if (world?.ready) {
      const floor = world.getHeightAt(this.chase.x, this.chase.z) + MIN_ABOVE_TERRAIN;
      if (this.chase.y < floor) this.chase.y = floor;
    }
    ship.root.updateMatrixWorld(true);
    _look.copy(LOOK_LOCAL).applyMatrix4(ship.root.matrixWorld);
    const e = smooth(Math.min(1, this.t / Math.max(0.05, EXTRACTION_CINEMATIC_BLEND_S)));
    _pos.lerpVectors(this.fromPos, this.chase, e);
    _outLook.lerpVectors(this.fromLook, _look, e);
    ctx.player?.setCameraOverride(_pos, _outLook, true);
  }

  /** Hand the camera back (hard cut — the ship is far away by now) and bring the HUD back. */
  stop(ctx: GameContext): void {
    if (!this.active) return;
    this.active = false;
    ctx.player?.setCameraOverride(null, undefined, true);
    ctx.bus.emit('ui:cinematic', { active: false });
  }

  private target(ship: Dropship, out: THREE.Vector3): THREE.Vector3 {
    const p = ship.root.position;
    ship.bayToWorld(CAM_OFFSET.x, CAM_OFFSET.z, p.y + CAM_OFFSET.y, out);
    return out;
  }
}
