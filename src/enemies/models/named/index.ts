/**
 * src/enemies/models/named/index.ts — **네임드 로그 · 스캔 드론의 겉모습 분기** (2026-09-11).
 *
 * 네 종류 모두 휴머노이드 로그 리그(`models/RogueModel`)를 바탕으로 쓰고, 종류마다 파일 하나가 부품을 덧붙이고
 * (`decorate*` — 망치 · 미니건 · 긴 저격총 · 드론 몸체) 매 프레임 자세를 더한다(`animate*`, 기본 `animateRogue` **뒤에**).
 * 부품과 그 상태는 `RogueRig.named` 에 종류별 객체로 걸어 둔다.
 *
 * ⚠ 순환 import: `RogueModel` 이 이 파일을 **값으로** 부르므로, 이 폴더의 파일들은 `RogueModel` 에서
 * **`import type` 만** 한다. 공유 지오메트리 · 머티리얼이 필요하면 자기 파일 안에서 만든다.
 */
import * as THREE from 'three';
import type { BugAnim } from '../BugModel';
import { closestOnSegment, nearestOnCapsule, raySegmentCapsule } from '../../RayTests';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';
import { animateSniperLook, decorateSniperLook, disposeSniperLook, sniperBodyCapsule, sniperBodyCenterY } from './SniperLook';
import { animateHammerLook, decorateHammerLook, disposeHammerLook } from './HammerLook';
import { animateHeavyLook, decorateHeavyLook, disposeHeavyLook } from './HeavyLook';
import { animateScanDroneLook, decorateScanDroneLook, disposeScanDroneLook } from './ScanDroneLook';

/** `createRogueRig` 끝에서 한 번. 네임드가 아니면 아무것도 하지 않는다. */
export function decorateNamedRig(rig: RogueRig): void {
  switch (rig.type) {
    case 'rogue_sniper': decorateSniperLook(rig); return;
    case 'rogue_hammer': decorateHammerLook(rig); return;
    case 'rogue_heavy': decorateHeavyLook(rig); return;
    case 'rogue_scan_drone': decorateScanDroneLook(rig); return;
    default: return;
  }
}

/** `Enemy.animate` 에서 `animateRogue` 바로 뒤에 매 프레임. `e.namedHint` 는 호스트 AI · 리플리카 모두 채워 둔다. */
export function animateNamedRig(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  switch (rig.type) {
    case 'rogue_sniper': animateSniperLook(rig, a, e, dt); return;
    case 'rogue_hammer': animateHammerLook(rig, a, e, dt); return;
    case 'rogue_heavy': animateHeavyLook(rig, a, e, dt); return;
    case 'rogue_scan_drone': animateScanDroneLook(rig, a, e, dt); return;
    default: return;
  }
}

/* ── 세로가 아닌 몸통 판정 (C-55) ── */
const _ba = new THREE.Vector3();
const _bb = new THREE.Vector3();
/** `namedBodyRay` 의 답: 이 적은 기본 세로 캡슐을 쓴다. */
export const BODY_RAY_VERTICAL = -2;

/**
 * 몸통 판정이 **세로 캡슐이 아닌** 자세(지금은 엎드린 로든뿐)면 그 캡슐과 레이의 거리(맞지 않으면 -1), 기본 세로
 * 캡슐을 써야 하면 `BODY_RAY_VERTICAL`. `EnemySystem.raycastEx` 가 적마다 부르므로 네임드가 아니면 곧바로 돌아간다.
 */
export function namedBodyRay(e: Enemy, o: THREE.Vector3, d: THREE.Vector3): number {
  if (e.type !== 'rogue_sniper') return BODY_RAY_VERTICAL;
  const r = sniperBodyCapsule(e, _ba, _bb);
  return r > 0 ? raySegmentCapsule(o, d, _ba, _bb, r) : BODY_RAY_VERTICAL;
}

/** `namedBodyRay` 로 맞은 점의 바깥 법선 (명중점 − 캡슐 축의 최근접점, 정규화 전) → `out`. */
export function namedBodyNormal(e: Enemy, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (e.type !== 'rogue_sniper' || sniperBodyCapsule(e, _ba, _bb) <= 0) return out.set(point.x - e.position.x, 0, point.z - e.position.z);
  closestOnSegment(point, _ba, _bb, out);
  return out.set(point.x - out.x, point.y - out.y, point.z - out.z);
}

/**
 * 몸통 판정이 세로 캡슐이 아닌 자세(엎드린 로든)면 **`namedBodyRay` 와 같은 캡슐**에서 `from` 에 가장 가까운 점을 `out` 에
 * 적고 true, 기본 세로 캡슐을 써야 하면 false (C-62 — `Enemy.nearestBodyPoint` → `weapons/Melee` 원뿔).
 */
export function namedBodyNearest(e: Enemy, from: THREE.Vector3, out: THREE.Vector3): boolean {
  if (e.type !== 'rogue_sniper') return false;
  const r = sniperBodyCapsule(e, _ba, _bb);
  if (r <= 0) return false;
  nearestOnCapsule(from, _ba, _bb, r, out);
  return true;
}

/** 폭발이 재는 몸 중심 높이 (발 위, m) — 기본은 키의 절반, 엎드린 로든은 몸통 캡슐 가운데. */
export function namedBodyCenterY(e: Enemy): number {
  return e.type === 'rogue_sniper' ? sniperBodyCenterY(e) : e.stats.height * 0.5;
}

/** `disposeRogueRig` 에서. 종류 파일이 만든 인스턴스 머티리얼 등을 해제한다. */
export function disposeNamedRig(rig: RogueRig): void {
  switch (rig.type) {
    case 'rogue_sniper': disposeSniperLook(rig); return;
    case 'rogue_hammer': disposeHammerLook(rig); return;
    case 'rogue_heavy': disposeHeavyLook(rig); return;
    case 'rogue_scan_drone': disposeScanDroneLook(rig); return;
    default: return;
  }
}
