import * as THREE from 'three';
import {
  INTERACT_PILLAR_FADE, INTERACT_PILLAR_HEIGHT,
  INTERACT_PILLAR_RADIUS_BOTTOM, INTERACT_PILLAR_RADIUS_TOP,
} from '@/shared';

/**
 * 루팅 표시 = 빛기둥 (Phase 10). Shared builder for the light pillar that replaced the light-blue fresnel sphere in
 * `hud/Detection` (in range, depth-tested) and `hud/ScanReveal` (scan result, through-wall).
 *
 * The trick that makes it shader-free: the geometry carries **baked vertex colours** that go to black toward the top,
 * and the material blends **additively** — in additive blending black *is* transparent, so a `MeshBasicMaterial` with
 * `vertexColors: true` fades out on its own. The material's own `color` tints the whole pillar, so the vertex colours
 * are a plain greyscale ramp and `opacity` stays free for the breathing pulse.
 *
 * The pillar is translated by `+height / 2` so its **base sits at the mesh origin** — place the mesh at the target's
 * position and it starts at ground level (`PickupVisuals` / `Pings` use the same trick for their beams). Scaling a
 * mesh on Y keeps that (vertex colours are an attribute, so the ramp scales with it), which is how `ScanReveal`
 * turns its per-kind number into a height multiplier.
 */
export function makePillarGeometry(
  height = INTERACT_PILLAR_HEIGHT,
  radiusBottom = INTERACT_PILLAR_RADIUS_BOTTOM,
  radiusTop = INTERACT_PILLAR_RADIUS_TOP,
  fade = INTERACT_PILLAR_FADE,
): THREE.BufferGeometry {
  // 8 radial × 6 height segments, open-ended (no caps): the extra rings are what lets the ramp actually reach 0 at
  // `fade × height` instead of only at the very top, and a shared geometry pays for them once.
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 8, 6, true);
  geo.translate(0, height / 2, 0);
  const pos = geo.getAttribute('position');
  const span = Math.max(1e-3, height * Math.min(1, Math.max(0.05, fade)));
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / span));
    // slightly convex falloff: bright, solid base → nothing well before the top
    const c = Math.pow(1 - t, 1.4);
    colors[i * 3] = c; colors[i * 3 + 1] = c; colors[i * 3 + 2] = c;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** The one material shape a pillar needs: additive + vertex colours, no depth writes, no lights, both faces. */
export function makePillarMaterial(color: number, opacity: number, throughWall = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    vertexColors: true,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: !throughWall,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}
