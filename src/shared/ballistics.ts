import * as THREE from 'three';
import { SHELL_ARC_GRAVITY } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * 포탄 궤적 (2026-09-10)
 *
 * 곡사포탄이 나는 포물선의 **닫힌 식**이다. `enemies/fx/ShellProjectile` (실제 포탄) 과
 * `ui/hud/ShellMarkers` · 위험 인디케이터(HUD 마커) 가 **같은 자리**를 그려야 하는데 폴더끼리는
 * 서로 import 하지 않으므로 (`@/shared` 만) 수식을 여기 한 곳에 둔다. 예전에는 양쪽이 각자
 * 베껴 두고 있었다 — 한쪽만 고치면 마커가 포탄에서 떨어진다.
 *
 * 중력은 **`GRAVITY` 가 아니라 `SHELL_ARC_GRAVITY`** 다. 정점 높이가 `0.5 × g × (T/2)²` 라
 * 실제 중력(9.81)으로는 6.3 s 비행에서 49 m 까지 솟아 화면 밖에서 떨어졌다. 궤적을 낮추려면
 * `data/constants.csv` 의 `SHELL_ARC_GRAVITY` 한 줄만 고친다 — 코드는 그대로다.
 * ──────────────────────────────────────────────────────────────────────────── */

const _d = new THREE.Vector3();

/** `p(t) = from + vel0·t − ½·g·t²·ŷ`. `vel0` 는 `shellLaunchVelocity` 가 준 값이어야 한다. */
export function shellPositionAt(from: THREE.Vector3, vel0: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(
    from.x + vel0.x * t,
    from.y + vel0.y * t - 0.5 * SHELL_ARC_GRAVITY * t * t,
    from.z + vel0.z * t,
  );
}

/** `T` 초 뒤 정확히 `target` 에 닿는 발사 속도 (`T` 는 호출자가 ≥ 0.5 로 잘라 넘긴다). */
export function shellLaunchVelocity(from: THREE.Vector3, target: THREE.Vector3, T: number, out: THREE.Vector3): THREE.Vector3 {
  _d.subVectors(target, from);
  return out.set(_d.x / T, _d.y / T + 0.5 * SHELL_ARC_GRAVITY * T, _d.z / T);
}

/** 궤적의 정점이 발사점보다 얼마나 위인가 (m). 튜닝 · 디버그용. */
export function shellApexHeight(flightTime: number): number {
  const t = flightTime * 0.5;
  return 0.5 * SHELL_ARC_GRAVITY * t * t;
}
