/**
 * src/player/SoldierRim.ts — **병사 전용 림(fresnel)** (2026-09-15, TODO D-7, 사용자 결정 「병사 전용 림」).
 *
 * 이 파일이 답하는 질문: *어두운 장갑이 이끼 · 독성 녹색 배경에 묻히지 않게 하려면.*
 *
 * 병사 재질은 환경 맵이 없어 금속감을 낮게 둔 `MeshStandardMaterial` 이다 (`SoldierModel` 생성자 주석). 베르단트 III 처럼
 * 배경이 어둡고 채도 낮은 녹색이면 짙은 청회색 장갑이 배경과 같은 밝기로 떨어져 실루엣이 사라졌다. 광원을 더하지 않고
 * (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」) **조각 셰이더 한 줄**로 가장자리만 밝힌다:
 *
 *   rim = 림 색 × pow(1 − N·V, `SOLDIER_RIM_POWER`) × `SOLDIER_RIM_STRENGTH` × 그 자리 **간접광 밝기**
 *
 * - N·V 는 뷰 공간 법선(`geometryNormal`, 양면 재질은 이미 뒤집혀 있다)과 시선(`geometryViewDir`)이다.
 * - 간접광 밝기 = 반구광 · 환경광 조도(`irradiance`)의 휘도, 1 로 자른다 — 어두운 실내 · 밤에는 림도 어두워져
 *   **어둠 속에서 혼자 빛나지 않는다.** 색은 차가운 중립색에 그 조도의 색조를 `RIM_AMBIENT_HUE` 만큼만 섞는다
 *   (녹색 조도를 그대로 쓰면 녹색 배경과 다시 같은 색이 된다).
 * - `totalEmissiveRadiance` 에 더하므로 톤매핑 · 포그 · 불투명도(근접 페이드) · 회색 처리 · 과충전 발광과 그대로 겹친다.
 * - `SOLDIER_RIM_STRENGTH` 0 이면 기여가 정확히 0 이다.
 *
 * **프로그램은 하나다.** `onBeforeCompile` 은 모듈 함수 하나, `customProgramCacheKey` 는 상수 문자열이고 유니폼 객체도
 * 모듈에 하나(`SOLDIER_RIM_UNIFORMS`)라 로컬 병사 · 원격 아바타 풀 · 시체 · 초상화 · 캐릭터 미리보기 · 방탄복 판이 모두
 * 같은 WebGL 프로그램을 쓴다 (단면 / 양면 망토처럼 three.js 가 원래 가르는 변형만 남는다). 악센트 색 · 페이드 · 발광은
 * 전부 셰이더를 정의하지 않는 값이라 새 변형을 만들지 않는다. 재질은 지금처럼 생성자에서 만들어지므로 `ctx.shaders`
 * 선컴파일이 함께 덮는다.
 *
 * 바이저(`SoldierModel.visorMat`)는 발광 모습을 그대로 두려고 **림을 달지 않는다**.
 */
import * as THREE from 'three';
import { SOLDIER_RIM_POWER, SOLDIER_RIM_STRENGTH } from '@/shared';

/** 림 기본 색 — 차가운 중립색 (sRGB hex). 녹색 · 모래 · 눈 어느 배경에서도 장갑의 청회색과 같은 계열로 읽힌다. */
const RIM_COLOR = 0xdce8ff;
/** 간접광 색조를 림 색에 섞는 비율 (0 = 늘 중립색, 1 = 조도 색 그대로). 조금만 섞어 주변광과 따로 놀지 않게 한다. */
const RIM_AMBIENT_HUE = 0.15;

/**
 * 모든 병사 재질이 **같은 객체**를 공유하는 유니폼 (값을 바꾸면 다음 프레임에 모든 병사에 반영된다 — 콘솔 · 스모크용).
 * `uSoldierRim` = (세기, 지수). 지수는 0 이하이면 `pow(0, 0)` 이 정의되지 않으므로 아주 작은 양수로 자른다.
 */
export const SOLDIER_RIM_UNIFORMS = {
  uSoldierRim: { value: new THREE.Vector2(Math.max(0, SOLDIER_RIM_STRENGTH), Math.max(0.01, SOLDIER_RIM_POWER)) },
  uSoldierRimColor: { value: new THREE.Color(RIM_COLOR) },
  uSoldierRimHue: { value: RIM_AMBIENT_HUE },
};

/** 모든 병사 재질의 프로그램 캐시 키 (three.js `WebGLPrograms` 가 이 값으로 프로그램을 공유한다). */
export const SOLDIER_RIM_PROGRAM_KEY = 'player-soldier-rim';

const RIM_PARS = /* glsl */`
uniform vec2 uSoldierRim;
uniform vec3 uSoldierRimColor;
uniform float uSoldierRimHue;
`;

const RIM_FRAGMENT = /* glsl */`
#include <lights_fragment_end>
{
	float rimNdv = saturate( dot( geometryNormal, geometryViewDir ) );
	float rimK = pow( 1.0 - rimNdv, uSoldierRim.y ) * uSoldierRim.x;
	#if defined( RE_IndirectDiffuse )
		vec3 rimAmb = irradiance;
	#else
		vec3 rimAmb = vec3( 1.0 );
	#endif
	float rimLum = min( dot( rimAmb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1.0 );
	vec3 rimHue = rimAmb / max( max( rimAmb.r, max( rimAmb.g, rimAmb.b ) ), 1e-4 );
	totalEmissiveRadiance += mix( uSoldierRimColor, rimHue, uSoldierRimHue ) * ( rimK * rimLum );
}
`;

/** 모듈 함수 하나 — 재질마다 새 클로저를 만들지 않는다. */
function installSoldierRim(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uSoldierRim = SOLDIER_RIM_UNIFORMS.uSoldierRim;
  shader.uniforms.uSoldierRimColor = SOLDIER_RIM_UNIFORMS.uSoldierRimColor;
  shader.uniforms.uSoldierRimHue = SOLDIER_RIM_UNIFORMS.uSoldierRimHue;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
    .replace('#include <lights_fragment_end>', RIM_FRAGMENT);
}

function rimProgramKey(): string { return SOLDIER_RIM_PROGRAM_KEY; }

/** `m` 에 병사 림을 단다 (한 번만 부르면 된다). 돌려주는 값은 같은 재질이다. */
export function applySoldierRim<M extends THREE.MeshStandardMaterial>(m: M): M {
  m.onBeforeCompile = installSoldierRim;
  m.customProgramCacheKey = rimProgramKey;
  return m;
}
