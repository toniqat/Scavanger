/**
 * src/shared/render.ts — **셰이더 선컴파일과 광원 예산** (2026-09-10). `ctx.shaders` 의 계약이고 구현은 `core/ShaderWarmup`.
 *
 * 이 파일이 답하는 질문: *새 장면을 보여 주기 전에 그 셰이더를 어떻게 미리 컴파일해 두는가.*
 *
 * three.js 는 머티리얼이 **처음 그려지는 순간** 셰이더를 컴파일하고, 그동안 메인 스레드가 멈춘다 (ANGLE D3D11 에서
 * 프로그램 하나에 수십 ~ 수백 ms). 게다가 프로그램 키에는 **보이는 점광원 개수**와 **렌더 타깃 종류**가 들어가서,
 * 개수가 바뀌면 이미 컴파일한 것도 전부 다시 한다. 멀티플레이 도킹 · 강하에서 수 초씩 멈추던 것이 이것이다.
 *
 * - 점광원 개수는 `core/LightBudget` 이 세션 내내 `SCENE_POINT_LIGHT_BUDGET` 으로 고정한다 (모자란 만큼 intensity 0
 *   여분 광원을 켠다). 기능 폴더는 **자기 장면의 점광원이 그 예산 안에 들어가게만** 하면 된다.
 * - `warm` 은 렌더를 하지 않고 프로그램 링크만 걸어 두며(KHR_parallel_shader_compile — 드라이버가 백그라운드에서
 *   끝낸다), 끝나면 resolve 한다. **메인 스레드를 막지 않는다.**
 * - `hold*` 는 기다리는 동안 **시뮬레이션 시간을 멈추고 그리기를 건너뛴다** — `game:paused {freeze}` 와 같은 방식이라
 *   시스템은 dt 0 으로 계속 돌고(네트워크 메시지 처리 포함) 화면에는 마지막 프레임이 남는다.
 */
import type * as THREE from 'three';

export interface ShaderWarmupRef {
  /**
   * `root` 아래 모든 머티리얼을 **`root` 가 씬에 들어간 뒤의 모습 그대로** 컴파일해 둔다 (숨은 메시 포함).
   * `replaces` 를 주면 그것이 빠진 뒤의 광원 상태로 컴파일한다 — 도킹 컷씬이 끝나면 사라지고 함선이 들어오는 경우.
   * 씬 밖에 있는(아직 `add` 하지 않은) 오브젝트도 된다. 프로그램이 전부 준비되면 true, `SHADER_WARMUP_TIMEOUT_S`
   * 를 넘기면 false 로 resolve 한다. **reject 하지 않는다.**
   */
  warm(root: THREE.Object3D, replaces?: THREE.Object3D | null): Promise<boolean>;
  /**
   * 씬 전체를 **이번 프레임 끝(모든 update 뒤, 그리기 직전)에** 컴파일하고 끝날 때까지 hold 한다. 지금 이 순간
   * 부터 `holding` 이 true 라, 같은 프레임에 뒤따라 만들어지는 오브젝트까지 한 번에 들어간다.
   * 호출이 겹치면 한 번으로 합쳐진다.
   */
  holdForScene(): Promise<boolean>;
  /** `ready` 가 끝날 때까지(최대 `SHADER_WARMUP_TIMEOUT_S`) hold 한다. */
  hold(ready: Promise<unknown>): void;
  /** true 인 동안 Engine 은 시뮬레이션 dt 를 0 으로 주고 그리지 않는다. */
  readonly holding: boolean;
  /** 씬에 늘 보이는 점광원 개수 (`SCENE_POINT_LIGHT_BUDGET`). */
  readonly pointLightBudget: number;
}
