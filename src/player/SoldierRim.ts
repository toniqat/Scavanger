/**
 * src/player/SoldierRim.ts — **the soldier-only fresnel rim** (2026-09-15, TODO D-7, user's decision 「병사 전용 림」).
 *
 * The question this file answers: *how to keep dark armor from sinking into a mossy · toxic green background.*
 *
 * Soldier materials are `MeshStandardMaterial` with metalness kept low because there is no environment map (the
 * `SoldierModel` constructor comment). Against a background as dark and desaturated-green as `베르단트 III`, the
 * deep blue-grey armor fell to the same brightness as the background and the silhouette disappeared. Without
 * adding a light (CLAUDE.md "Never change the point-light count at runtime") **one line of fragment shader**
 * lights the edge only:
 *
 *   rim = rim colour × pow(1 − N·V, `SOLDIER_RIM_POWER`) × `SOLDIER_RIM_STRENGTH` × the **indirect brightness** there
 *
 * - N·V is the view-space normal (`geometryNormal`, already flipped on a double-sided material) against the view
 *   direction (`geometryViewDir`).
 * - The indirect brightness is the luminance of the hemisphere · ambient irradiance (`irradiance`), clipped at 1 —
 *   in a dark interior or at night the rim darkens too, so it **never glows on its own in the dark.** The colour is
 *   a cool neutral with only `RIM_AMBIENT_HUE` of that irradiance's hue mixed in
 *   (taking the green irradiance as it is would make it the same colour as the green background again).
 * - It is added to `totalEmissiveRadiance`, so it layers with tone mapping · fog · opacity (the near fade) · greying
 *   and the overcharge glow exactly as they are.
 * - With `SOLDIER_RIM_STRENGTH` 0 the contribution is exactly 0.
 *
 * **There is one program.** `onBeforeCompile` is one module function, `customProgramCacheKey` a constant string and
 * the uniform object is one per module (`SOLDIER_RIM_UNIFORMS`), so the local soldier · the remote avatar pool ·
 * corpses · portraits · the character preview · armor plates all use the same WebGL program (only the variants
 * three.js splits on anyway, such as a single- / double-sided cape, remain). The accent colour · fade · glow are
 * all values that define no shader, so they create no new variant. Materials are still made in the constructor, so
 * the `ctx.shaders` pre-compile covers them along with everything else.
 *
 * The visor (`SoldierModel.visorMat`) **gets no rim**, so its emissive look is left as it is.
 */
import * as THREE from 'three';
import { SOLDIER_RIM_POWER, SOLDIER_RIM_STRENGTH } from '@/shared';

/**
 * Default rim colour — a cool neutral (sRGB hex). Against a green · sand · snow background alike it reads as the
 * same family as the armor's blue-grey.
 */
const RIM_COLOR = 0xdce8ff;
/**
 * How much of the indirect light's hue is mixed into the rim colour (0 = always neutral, 1 = the irradiance colour
 * as it is). Only a little is mixed, so the rim never plays apart from the surrounding light.
 */
const RIM_AMBIENT_HUE = 0.15;

/**
 * The uniforms every soldier material shares as **the same object** (changing a value reaches every soldier on the
 * next frame — for the console · smoke tests). `uSoldierRim` = (strength, exponent). An exponent of 0 or less
 * leaves `pow(0, 0)` undefined, so it is clamped to a very small positive number.
 */
export const SOLDIER_RIM_UNIFORMS = {
  uSoldierRim: { value: new THREE.Vector2(Math.max(0, SOLDIER_RIM_STRENGTH), Math.max(0.01, SOLDIER_RIM_POWER)) },
  uSoldierRimColor: { value: new THREE.Color(RIM_COLOR) },
  uSoldierRimHue: { value: RIM_AMBIENT_HUE },
};

/** Program cache key for every soldier material (three.js `WebGLPrograms` shares programs by this value). */
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

/** One module function — no new closure per material. */
function installSoldierRim(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uSoldierRim = SOLDIER_RIM_UNIFORMS.uSoldierRim;
  shader.uniforms.uSoldierRimColor = SOLDIER_RIM_UNIFORMS.uSoldierRimColor;
  shader.uniforms.uSoldierRimHue = SOLDIER_RIM_UNIFORMS.uSoldierRimHue;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${RIM_PARS}`)
    .replace('#include <lights_fragment_end>', RIM_FRAGMENT);
}

function rimProgramKey(): string { return SOLDIER_RIM_PROGRAM_KEY; }

/** Fits the soldier rim onto `m` (calling it once is enough). The value returned is the same material. */
export function applySoldierRim<M extends THREE.MeshStandardMaterial>(m: M): M {
  m.onBeforeCompile = installSoldierRim;
  m.customProgramCacheKey = rimProgramKey;
  return m;
}
