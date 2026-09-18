/**
 * src/enemies/models/EggModel.ts — **벌레 알 리그** (2026-09-18, 사용자 결정 「둥지의 장식 알을 부술 수 있는 적으로」).
 *
 * 2026-09-18 전까지 알은 `world/Nests` 가 둥지마다 하나로 합쳐 굽던 **장식 메시**였다. 부술 수 있는 적이 되면서 몸을
 * 그리는 주인이 이 폴더로 왔다 — **겉모습은 그대로**여야 하므로 옛 코드의 수치를 그대로 옮겼다 (`world/Nests.ts` 머리 주석에도 적혀 있다):
 *   `SphereGeometry(er, 8, 6)` 를 y 로만 ×1.2 늘린 타원체 · 세로 그러데이션 `0xb8a070`(밑) → `0xe0d0a0`(위) ·
 *   `MeshStandardMaterial({ roughness: 0.35, metalness: 0, emissive: 0x6a5020, emissiveIntensity: 0.25 })` · `castShadow`.
 *   자리(`NestEggSpot.position`)는 **그려진 구의 중심**이라 지면은 그보다 `radius × 0.6` 아래다.
 *
 * - **자리마다 크기가 다르다** (`NestEggSpot.radius` = 0.35~0.7 m). 지오메트리는 `data/enemies.csv` 의 `bug_egg` 반지름으로
 *   한 번만 굽고, 개체는 `rig.baseScale` 로 제 크기에 맞춘다 (`setEggScale`). 히트 캡슐도 같은 배수로 따라간다 —
 *   알은 `EnemyStats` 를 **개체마다 복사해** 들고 있는 유일한 종류다 (`Enemy` 생성자) — 그래서 「보이는 알 = 히트박스」다.
 * - **손상 표현**: 체력이 줄면 껍질에 어두운 파열구가 하나씩 벌어진다 (`animateEgg` 의 `hurt` = 1 − hp/maxHp).
 *   파열구는 제자리에서 **커지는** 렌즈라 껍질 표면에 붙어 있고, 멀쩡한 알에서는 `visible = false` 라 **드로우콜이 0** 이다
 *   (한 레이드에 알이 수십 개라 이 게 중요하다). 부서지면 껍질이 주저앉고(y 수축 · xz 퍼짐) 파열구가 활짝 벌어진 채
 *   `anim.fade` 로 땅에 가라앉는다.
 * - **광원 없음** (§4.5): 속의 노른빛은 emissive 뿐이다. 머티리얼은 정점색 `MeshStandardMaterial` 둘 — 벌레 리그(껍질 · 눈)와
 *   같은 프로그램이라 새 셰이더 변형이 생기지 않는다.
 * - 지오메트리는 종류당 한 번 구워 공유하고(`assets`), 머티리얼만 개체마다 clone 한다 (피격 번쩍임 · 상태 발광이 개체별이라 —
 *   벌레 리그와 같은 규칙). `disposeEggAssets()` 는 `parts/Pool.disposePools` 가 부른다.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import { ENEMY_STATS, type EggEnemyType } from '../EnemyTypes';
import type { BugAnim } from './BugModel';

export type EggType = EggEnemyType;

/* ── 그림 수치 (밸런스가 아니다 — 판정은 enemies.csv 의 반지름 · 높이) ────────────────────────── */
/** 옛 `world/Nests` 의 알: 구를 y 로만 이만큼 늘린다. */
export const EGG_Y_SCALE = 1.2;
/** 옛 `world/Nests` 의 알: 중심이 지면 위로 반지름 × 이만큼 (아래쪽은 흙에 묻혀 있다). */
export const EGG_CENTER_MUL = 0.6;
/** 옛 `world/Nests` 의 구 분할 (같은 실루엣을 위해 그대로). */
const EGG_SEG_W = 8;
const EGG_SEG_H = 6;
/** 껍질 그러데이션 (옛 `eggA` → `eggB`). */
const EGG_LOW = 0xb8a070;
const EGG_HIGH = 0xe0d0a0;
/** 옛 `eggMat` 의 emissive 색 · 세기 (속에서 배어 나오는 노른빛). */
const EGG_EMISSIVE = 0x6a5020;
const EGG_EMISSIVE_I = 0.25;
/** 파열구의 속살 (마른 피 같은 어두운 붉은 갈색). */
const EGG_INNER = 0x4a2416;
/** 파열구 수 · 껍질 표면에서의 거리(반지름 대비) · 다 벌어졌을 때의 크기(반지름 대비). */
const RUPTURES = 3;
const RUPTURE_SEAT = 0.9;
const RUPTURE_SIZE = 0.62;
/** 파열구가 보이기 시작하는 손상도 (0..1) — 스치기만 해도 갈라지면 「멀쩡한 알」이라는 그림이 없다. */
const CRACK_START = 0.2;
/** 부서진 껍질이 주저앉는 정도 (y 배수의 하한) · 그만큼 옆으로 퍼지는 배수. */
const DEATH_SQUASH = 0.35;
const DEATH_SPREAD = 1.25;

/** 알의 그림 수치 — 전부 그 종류의 `enemies.csv` 줄에서 나온다 (개체 크기는 `rig.baseScale`). */
export interface EggParams {
  /** 공용 코드가 읽는 「머리」 구 — 발 기준 높이 · 정면 거리 · 반지름 (`Enemy.headCenter`). 알은 약점이 없어 `headMul` 이 1 이다. */
  readonly head: { y: number; z: number; r: number };
  /** 보행 위상용 (걷지 않지만 공용 코드가 읽는다). */
  readonly strideLength: number;
  /** csv 껍질 반지름(m) — 개체의 실제 반지름은 여기에 `baseScale` 을 곱한 것이다. */
  readonly radius: number;
}

export interface EggRig {
  kind: 'egg';
  type: EggType;
  params: EggParams;
  /** 개체 크기 배수 (`NestEggSpot.radius` / csv 반지름) — `Enemy.reset` 이 root 스케일로 쓴다. */
  baseScale: number;
  root: THREE.Group;
  /** 껍질 + 파열구를 함께 눌러 주저앉히는 그룹 (지면 기준 중심 높이도 여기 있다). */
  body: THREE.Group;
  shell: THREE.Mesh;
  /** 파열구 세 개 — 손상도에 따라 **제자리에서** 커진다 (0 이면 `visible` false = 드로우콜 없음). */
  ruptures: THREE.Group[];
  shellMat: THREE.MeshStandardMaterial;
  innerMat: THREE.MeshStandardMaterial;
}

interface EggAssets {
  shell: THREE.BufferGeometry;
  rupture: THREE.BufferGeometry;
}

const assets = new Map<EggType, EggAssets>();
let materials: { shell: THREE.MeshStandardMaterial; inner: THREE.MeshStandardMaterial } | null = null;
const _color = new THREE.Color();
const _lo = new THREE.Color();
const _hi = new THREE.Color();

/** 옛 `world/build.paintGradient` 와 같은 요령 — y 로 두 색을 섞어 정점색으로 굽는다. */
function paintGradient(geo: THREE.BufferGeometry, lo: number, hi: number, y0: number, y1: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  _lo.setHex(lo); _hi.setHex(hi);
  const pos = g.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  const span = Math.max(1e-4, y1 - y0);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - y0) / span));
    _color.copy(_lo).lerp(_hi, t);
    arr[i * 3] = _color.r; arr[i * 3 + 1] = _color.g; arr[i * 3 + 2] = _color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function flat(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  _color.setHex(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _color.r; arr[i * 3 + 1] = _color.g; arr[i * 3 + 2] = _color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[enemies] egg mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}

/** 알 껍질 — 옛 장식 알과 같은 구 (분할 · y 눌림 · 그러데이션까지). 중심이 원점이다. */
function buildShell(r: number): THREE.BufferGeometry {
  const sph = new THREE.SphereGeometry(r, EGG_SEG_W, EGG_SEG_H);
  sph.scale(1, EGG_Y_SCALE, 1);
  return paintGradient(sph, EGG_LOW, EGG_HIGH, -r * EGG_Y_SCALE, r * EGG_Y_SCALE);
}

/**
 * 파열구 한 개 — 껍질에 반쯤 박히는 납작한 덩어리(원점 중심, +Z 가 바깥). 부모 그룹이 껍질 표면에 앉히고 방향을 잡으므로
 * `scale` 하나로 **제자리에서 커진다** (원점을 향해 오그라들지 않는다 = 커지는 그림이 실제로 보인다).
 */
function buildRupture(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const lens = new THREE.SphereGeometry(1, 6, 4);
  lens.scale(r * RUPTURE_SIZE, r * RUPTURE_SIZE * 0.72, r * 0.2);
  parts.push(flat(lens, EGG_INNER));
  return merge(parts);
}

function getMaterials(): NonNullable<typeof materials> {
  if (materials) return materials;
  materials = {
    shell: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0, emissive: EGG_EMISSIVE, emissiveIntensity: EGG_EMISSIVE_I }),
    inner: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0, emissive: EGG_EMISSIVE, emissiveIntensity: EGG_EMISSIVE_I * 2 }),
  };
  return materials;
}

function eggParams(type: EggType): EggParams {
  const st = ENEMY_STATS[type];
  const r = Math.max(0.05, st.radius);
  /* 머리 구는 늘 껍질 **안**에 있고 `headMul` 이 1 이라 판정에 아무 영향이 없다 (약점이 없는 몸이다).
     그래도 0 으로 두지 않는 것은 `raycastEx` 의 브로드페이즈 반경이 이 값을 더해 쓰기 때문이다. */
  return { head: { y: r * EGG_CENTER_MUL, z: 0, r: st.headRadius }, strideLength: 1, radius: r };
}

function getAssets(type: EggType): EggAssets {
  const have = assets.get(type);
  if (have) return have;
  const p = eggParams(type);
  const built: EggAssets = { shell: buildShell(p.radius), rupture: buildRupture(p.radius) };
  assets.set(type, built);
  return built;
}

/** 공유 지오메트리 · 템플릿 머티리얼 해제 (리그를 먼저 dispose). */
export function disposeEggAssets(): void {
  for (const a of assets.values()) { a.shell.dispose(); a.rupture.dispose(); }
  assets.clear();
  if (materials) { materials.shell.dispose(); materials.inner.dispose(); materials = null; }
}

export function createEggRig(type: EggType = 'bug_egg'): EggRig {
  const a = getAssets(type);
  const m = getMaterials();
  const p = eggParams(type);
  const shellMat = m.shell.clone();
  const innerMat = m.inner.clone();

  const root = new THREE.Group();
  root.name = `egg_${type}`;
  const body = new THREE.Group();
  // 옛 장식 알과 같은 자리: 구의 중심이 지면 위로 반지름 × 0.6 (아래쪽은 흙에 묻혀 있다)
  body.position.y = p.radius * EGG_CENTER_MUL;
  root.add(body);

  const shell = new THREE.Mesh(a.shell, shellMat);
  shell.castShadow = true;
  shell.layers.enable(Layers.ENEMY);
  body.add(shell);

  const ruptures: THREE.Group[] = [];
  for (let i = 0; i < RUPTURES; i++) {
    const g = new THREE.Group();
    // 셋이 한 줄로 보이지 않게 방위 · 높이를 다르게 — 껍질 표면에 앉히고 바깥(+Z 회전 뒤)을 본다
    const yaw = (i / RUPTURES) * Math.PI * 2 + 0.6;
    const pitch = (i - 1) * 0.42;
    g.rotation.set(pitch, yaw, 0, 'YXZ');
    g.position.set(
      Math.sin(yaw) * Math.cos(pitch) * p.radius * RUPTURE_SEAT,
      Math.sin(pitch) * p.radius * EGG_Y_SCALE * RUPTURE_SEAT,
      Math.cos(yaw) * Math.cos(pitch) * p.radius * RUPTURE_SEAT,
    );
    g.visible = false;                       // 멀쩡한 알은 드로우콜이 껍질 하나뿐이다
    const mesh = new THREE.Mesh(a.rupture, innerMat);
    mesh.layers.enable(Layers.NO_RAYCAST);   // 판정은 껍질 캡슐 하나다
    g.add(mesh);
    body.add(g);
    ruptures.push(g);
  }

  return { kind: 'egg', type, params: p, baseScale: 1, root, body, shell, ruptures, shellMat, innerMat };
}

/**
 * 이 개체의 크기를 그 알자리의 반지름(m)에 맞춘다 (`NestEggSpot.radius`). `Enemy.reset` 이 `rig.baseScale` 을 root 스케일로
 * 쓰므로 **스폰 직전에** 부른다. 히트 캡슐은 부르는 쪽(`NestDirector`)이 개체별 `EnemyStats` 에 같은 배수로 넣는다.
 */
export function setEggScale(rig: EggRig, radius: number): void {
  const r = Number.isFinite(radius) && radius > 0 ? radius : rig.params.radius;
  rig.baseScale = r / rig.params.radius;
}

export function disposeEggRig(rig: EggRig): void {
  rig.shellMat.dispose();
  rig.innerMat.dispose();
  rig.root.removeFromParent();
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * 한 프레임의 자세. `hurt` = 1 − hp / maxHp (0 멀쩡 … 1 곧 깨진다) — 호스트도 리플리카도 `hp` 를 들고 있어(스냅숏에 실린다)
 * 와이어를 더하지 않고 양쪽이 같은 그림을 그린다. 할당 없음.
 */
export function animateEgg(rig: EggRig, a: BugAnim, hurt: number): void {
  const dying = a.death >= 0;
  const d = dying ? smooth(Math.min(1, a.death * 1.6)) : 0;
  const fade = dying ? smooth(Math.min(1, a.fade)) : 0;
  const r = rig.params.radius;

  // 껍질: 피격 때 잠깐 움찔하고, 부서지면 주저앉으며 옆으로 퍼진다
  const wobble = a.flinch > 0.001 ? 1 + 0.06 * a.flinch * Math.sin(a.time * 33) : 1;
  rig.body.scale.set((1 + d * (DEATH_SPREAD - 1)) * (2 - wobble), (1 - d * (1 - DEATH_SQUASH)) * wobble, (1 + d * (DEATH_SPREAD - 1)) * (2 - wobble));
  // 부서진 껍질은 수명 마지막 `corpseFadeS` 초 동안 땅으로 가라앉는다
  rig.body.position.y = r * EGG_CENTER_MUL - fade * r * EGG_Y_SCALE * 2.2;

  // 파열구: 손상도에 따라 하나씩 벌어지고, 부서지면 셋 다 활짝
  const open = Math.max(dying ? 1 : 0, hurt <= CRACK_START ? 0 : (hurt - CRACK_START) / (1 - CRACK_START));
  for (let i = 0; i < rig.ruptures.length; i++) {
    const g = rig.ruptures[i];
    // 셋이 차례로 — 첫 개는 곧, 마지막 개는 거의 다 깎였을 때
    const k = Math.max(0, Math.min(1, open * rig.ruptures.length - i));
    if (k <= 0.001) { if (g.visible) g.visible = false; continue; }
    if (!g.visible) g.visible = true;
    g.scale.setScalar(k);
  }

  /* 발광: 속의 노른빛은 늘 있고(정해진 세기), 피격 번쩍임 · 화상 · 감전만 그 위에 얹는다.
     `BugModel.statusEmissive` 를 쓰지 않는 이유 — 그 함수는 상태가 없을 때 emissive 를 **0 으로 지워** 알의 기본 노른빛까지 꺼 버린다. */
  const glow = a.writhe * (0.32 + 0.18 * Math.abs(Math.sin(a.time * 17)));
  _color.setHex(EGG_EMISSIVE).multiplyScalar(dying ? 1 - d * 0.8 : 1);
  if (a.hitFlash > 0.001) { _color.r += 1.0 * a.hitFlash; _color.g += 0.7 * a.hitFlash; _color.b += 0.35 * a.hitFlash; }
  if (glow > 0.001) { _color.r += 1.0 * glow; _color.g += 0.32 * glow; _color.b += 0.05 * glow; }
  if (a.spark > 0.001) { _color.r += 0.35 * a.spark; _color.g += 0.85 * a.spark; _color.b += 1.1 * a.spark; }
  rig.shellMat.emissive.copy(_color);
  rig.innerMat.emissive.copy(_color);
}
