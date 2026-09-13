/**
 * src/enemies/models/HumanoidParts.ts — 휴머노이드 리그의 **부품 도구와 자산 모양** (2026-09-13).
 *
 * `RogueModel`(로그 · 그룹장 · 네임드 바탕)과 `FactionLooks`(안드로이드 · 레이더 외피)가 같은 도구로 부품을 짓는다.
 * 전부 빌드 시점에 한 번 불리므로(타입당 캐시) 여기의 할당은 핫 패스가 아니다. 상태도 값도 없는 파일이라
 * 두 파일이 서로를 import 하지 않고 이것만 본다 (순환 import 없음).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 발광 부품이 붙는 리그 그룹 — 머리의 발광은 따로 `visor` 다. */
export type GlowPart = 'pelvis' | 'chest' | 'gunArms' | 'thigh' | 'shin';

/** 한 타입의 공유 자산 (리그 인스턴스는 머티리얼 둘만 복제한다). */
export interface HumanoidAssets {
  pelvis: THREE.BufferGeometry;
  chest: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  /** 머리의 발광 부품 (`eyeMat`) */
  visor: THREE.BufferGeometry;
  gunArms: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  grenade: THREE.BufferGeometry;
  /** 그 밖의 발광 부품 — 관절 링 · 안테나 끝 등. `eyeMat` 으로 그려져 사망 때 바이저와 함께 꺼진다. */
  glow: Partial<Record<GlowPart, THREE.BufferGeometry>>;
  chitin: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  grenadeMat: THREE.MeshStandardMaterial;
  /** 살아 있는 동안의 `eyeMat.emissiveIntensity` */
  eyeGlow: number;
}

export const HIP_Y = 0.95;
export const THIGH = 0.45;
export const SHIN = 0.5;

const tmpColor = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

export function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  tmpColor.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = tmpColor.r; arr[i * 3 + 1] = tmpColor.g; arr[i * 3 + 2] = tmpColor.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Cylinder from `a` to `b` (`taper` = top radius / bottom radius). */
export function limb(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number, taper = 0.85, seg = 7,
): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * taper, r, len, seg, 1);
  g.translate(0, len / 2, 0);
  _dir.copy(_b).sub(_a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}

/** Low-poly (optionally squashed) sphere. */
export function ball(r: number, x: number, y: number, z: number, hex: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 10, 8);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Flat cylinder (a disc) whose face points along `axis`. */
export function disc(r: number, depth: number, x: number, y: number, z: number, hex: number, axis: 'x' | 'y' | 'z' = 'z'): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, depth, 12, 1);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, hex);
}

/** Thin torus whose hole looks along `axis` (a joint ring around a limb that bends about that axis). */
export function ring(r: number, tube: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', hex: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(r, tube, 5, 16);
  if (axis === 'x') g.rotateY(Math.PI / 2);
  else if (axis === 'y') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return colorize(g, hex);
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] humanoid mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}

/** The off-hand grenade every humanoid carries (visible only in the throw wind-up). */
export function grenadeGeometry(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.075, 10, 8);
}
export function grenadeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x2a2e26, emissive: 0xc83a1a, emissiveIntensity: 0.8, roughness: 0.5, metalness: 0.4 });
}
export function eyeMaterial(hex: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x050505, emissive: hex, emissiveIntensity: intensity, roughness: 0.2 });
}
