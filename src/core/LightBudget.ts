import * as THREE from 'three';
import { SCENE_POINT_LIGHT_BUDGET } from '@/shared';

/**
 * Scratch stack for `countVisiblePointLights` — module scope so the walk below allocates nothing per frame. Entries
 * above `top` are stale references overwritten by the next walk, one frame later; nothing reads them.
 */
const _stack: THREE.Object3D[] = [];

/**
 * Point lights three.js would collect under `root` (`projectObject` skips invisible subtrees, so does this).
 * `skip` drops one subtree from the walk — `LightBudget` passes its own padding group, whose count it already knows.
 *
 * 2026-09-20 (`docs/PERF_PLAN.md` Phase C, finding B3): this is an explicit stack rather than `traverseVisible`
 * because it runs **every frame, over the whole scene** — 3 978 nodes in a raid — and `traverseVisible` pays a
 * recursive method call plus a closure call per node. Counting is still exact, and it has to be: the count is part
 * of three.js's shader program key, so a frame that sees one light too many recompiles every lit material in the
 * scene (twice — once up, once back). Recounting on a flag or on an interval was considered and rejected for that
 * reason: point lights really do enter and leave the scene mid-raid (`extraction/Ship`, `player/Hellpod`,
 * `game/parts/Leader`), and a flag missed by one owner is exactly the stall this class exists to prevent.
 */
export function countVisiblePointLights(root: THREE.Object3D, skip: THREE.Object3D | null = null): number {
  let n = 0;
  const stack = _stack;
  let top = 0;
  stack[top++] = root;
  while (top > 0) {
    const o = stack[--top];
    if (o.visible === false || o === skip) continue;
    if ((o as THREE.PointLight).isPointLight) n++;
    const kids = o.children;
    for (let i = 0; i < kids.length; i++) stack[top++] = kids[i];
  }
  return n;
}

/**
 * **씬의 점광원 개수를 세션 내내 하나로 고정한다** (2026-09-10).
 *
 * three.js 는 보이는 점광원 개수를 셰이더 프로그램 키에 넣는다. 개수가 바뀌면 씬의 모든 lit 머티리얼이 다음
 * 그리기에서 **다시 컴파일**되고, 개수마다 다른 프로그램이라 전에 컴파일한 것도 재사용되지 않는다. 측정값:
 * 개인 함선 27 → 도킹 컷씬 15 → 공유 함선 29 → 행성 20 — 전환마다 수백 ms ~ 3 초가 멈췄다.
 *
 * 2026-09-10 에 광원을 하나씩 "끄지 말고 어둡게만" 고친 것(탈출 함선 · 신호탄 · 헬포드 · 분대장 기기)은 **한 장면
 * 안에서** 개수를 지켰다. 이것은 **장면과 장면 사이**를 지킨다: intensity 0 인 여분 광원을 예산만큼 들고 있다가,
 * 매 프레임 그리기 직전에 진짜 광원을 세서 모자란 만큼만 켠다. 그래서 함선 · 컷씬 · 행성 어디서든 셰이더가 보는
 * 개수는 `SCENE_POINT_LIGHT_BUDGET` 이다.
 *
 * 여분 광원도 셰이더 루프를 한 바퀴씩 돈다 — 그래서 예산은 **실제로 가장 많이 켜지는 장면**에 맞춰 둔다: 상주 광원
 * 15 + 함선 `HUB_POINT_LIGHTS` 8 = 23 (함선은 자리가 스물이 넘어도 그 풀 안에서 돈다, `hub/interiors/LightPool`).
 * 행성은 패드 3 + 콘솔 3 이라 레이드 중 여분은 2 개다.
 * 진짜 광원이 예산을 넘으면 개수가 흔들리므로 그 값마다 한 번 경고한다.
 */
export class LightBudget {
  readonly budget: number;
  private readonly group = new THREE.Group();
  private readonly pads: THREE.PointLight[] = [];
  private shown: number;
  private warnedAt = -1;

  constructor(private readonly scene: THREE.Scene, budget = SCENE_POINT_LIGHT_BUDGET) {
    this.budget = Math.max(0, Math.floor(budget));
    this.group.name = 'LightBudget';
    for (let i = 0; i < this.budget; i++) {
      // black, zero intensity, a millimetre of reach, far below the world: it only occupies a slot in the shader loop
      const l = new THREE.PointLight(0x000000, 0, 0.001, 2);
      l.name = 'LightBudgetPad';
      l.position.set(0, -50000, 0);
      l.castShadow = false;
      this.pads.push(l);
      this.group.add(l);
    }
    this.shown = this.budget;
    scene.add(this.group);
  }

  /** Padding lights currently counted by three.js. */
  get padsShown(): number { return this.shown; }

  /** Real point lights in the scene right now (the padding group is skipped rather than counted and subtracted). */
  contentCount(): number { return countVisiblePointLights(this.scene, this.group); }

  /** Show exactly `n` padding lights (clamped). */
  setShown(n: number): void {
    const k = Math.max(0, Math.min(this.budget, n));
    if (k === this.shown) return;
    for (let i = 0; i < this.budget; i++) this.pads[i].visible = i < k;
    this.shown = k;
  }

  /** Top the scene up to the budget for `content` real point lights. */
  fill(content: number): void {
    if (content > this.budget && content !== this.warnedAt) {
      this.warnedAt = content;
      console.warn(`[LightBudget] ${content} point lights exceed SCENE_POINT_LIGHT_BUDGET ${this.budget} — shaders recompile whenever this count changes`);
    }
    this.setShown(this.budget - content);
  }

  /** Once per frame, right before rendering. */
  update(): void { this.fill(this.contentCount()); }
}
