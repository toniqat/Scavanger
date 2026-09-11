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
import type { BugAnim } from '../BugModel';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';
import { animateSniperLook, decorateSniperLook, disposeSniperLook } from './SniperLook';
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
