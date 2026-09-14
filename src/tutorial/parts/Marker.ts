import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext } from '@/shared';
import {
  MARKER_BASE_Y, MARKER_BOB, MARKER_BOB_PERIOD, MARKER_CHEVRON_ANGLE, MARKER_CHEVRON_LEN, MARKER_CHEVRON_W,
  MARKER_COLOR, MARKER_TOP_Y, MARKER_WIDTH,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Marker.ts — **목표 마커** (2026-09-14 3차, 사용자 결정).
 *
 * 퀘스트 표식 하나: **세로선 + 아래를 가리키는 chevron**, 하이라이트 주황(`MARKER_COLOR` = UI 강조색과 같은 값)
 * 이고 위아래로 **천천히** 오간다. `corpseLoot` 단계의 목표 시체 위에 선다.
 *
 * 세 가지가 규약이다.
 *   ① **자리를 코드에 적지 않는다** — `TutorialSystem` 이 `ctx.interactables` 에서 찾은 시체의 자리를 넘긴다
 *      (`world/tutorial` 이 좌표를 옮겨도 따라간다).
 *   ② **광원을 만들지 않는다** — `CLAUDE.md` 의 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」. `MeshBasicMaterial`
 *      이라 빛을 받지도 내지도 않고, 머티리얼 하나뿐이라 셰이더 변형도 늘지 않는다.
 *   ③ **외부 에셋 금지** — 전부 `BoxGeometry` 를 합친 절차 지오메트리 하나다 (draw call 1).
 *
 * chevron 은 평면 도형이라 옆에서 보면 사라진다. 그래서 그룹의 **yaw 만 카메라를 향해** 돌린다(빌보드) —
 * 세로선은 축 대칭이라 돌아도 티가 나지 않고, chevron 은 어디서 봐도 「∨」로 읽힌다.
 * 안내선(`parts/Guide`)과 같은 이유로 `depthTest: false` 다: 「저쪽이다」를 알려 주는 물건이지 시야 판정이 아니다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 로컬 XY 평면에 놓인 막대 하나 (길이 `len`, 두께 `w`) — 원점에서 `dir` 방향으로 뻗는다. */
function bar(len: number, w: number, angle: number, x: number, y: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, w, w);
  g.translate(len / 2, 0, 0);
  g.rotateZ(angle);
  g.translate(x, y, 0);
  return g;
}

/** 세로선 + chevron 을 하나로 합친 지오메트리 (원점 = 대상의 발치). */
function markerGeometry(): THREE.BufferGeometry | null {
  const a = MARKER_CHEVRON_ANGLE;
  const tip = MARKER_BASE_Y;
  const stemY0 = tip + MARKER_CHEVRON_LEN * Math.cos(a) + 0.14;
  const parts: THREE.BufferGeometry[] = [
    // 세로선 — 위로 뻗는 막대 (각도 π/2)
    bar(Math.max(0.2, MARKER_TOP_Y - stemY0), MARKER_WIDTH, Math.PI / 2, 0, stemY0),
    // chevron 두 날개 — tip 에서 위로 벌어진다 (「∨」)
    bar(MARKER_CHEVRON_LEN, MARKER_CHEVRON_W, Math.PI / 2 + a, 0, tip),
    bar(MARKER_CHEVRON_LEN, MARKER_CHEVRON_W, Math.PI / 2 - a, 0, tip),
  ];
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

export class ObjectiveMarker {
  private readonly group = new THREE.Group();
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly base = new THREE.Vector3();
  private mounted = false;
  private time = 0;
  private has = false;

  constructor(private readonly ctx: GameContext) {
    this.group.name = 'TutorialObjectiveMarker';
    this.group.renderOrder = 4;
    const geo = markerGeometry();
    const mat = new THREE.MeshBasicMaterial({
      color: MARKER_COLOR, transparent: true, opacity: 0.92,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.disposables.push(mat);
    if (geo) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo);
    }
  }

  /** 목표 자리 (null = 마커 끄기). 발치 좌표를 그대로 넘긴다 — 높이는 이 파일이 정한다. */
  setTarget(position: THREE.Vector3 | null): void {
    if (!position) { this.has = false; this.unmount(); return; }
    this.has = true;
    this.base.copy(position);
  }

  update(dt: number): void {
    if (!this.has) return;
    this.time += dt;
    this.mount();
    const bob = Math.sin((this.time / MARKER_BOB_PERIOD) * Math.PI * 2) * MARKER_BOB;
    this.group.position.set(this.base.x, this.base.y + bob, this.base.z);
    // chevron 이 평면이라 yaw 만 카메라 쪽으로 (세로선은 축 대칭이라 영향이 없다)
    const cam = this.ctx.camera.position;
    this.group.rotation.y = Math.atan2(cam.x - this.base.x, cam.z - this.base.z);
  }

  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.ctx.scene.add(this.group);
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.ctx.scene.remove(this.group);
  }

  /** 스모크 / 디버그. */
  get visible(): boolean { return this.mounted; }

  dispose(): void {
    this.unmount();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
