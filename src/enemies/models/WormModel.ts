/**
 * src/enemies/models/WormModel.ts — **지하벌레 리그** (2026-09-13).
 *
 * 듄의 샌드웜처럼 땅에서 솟은 거대한 마디 몸통과, 꽃잎처럼 벌어지는 턱 네 장 · 안쪽을 두른 이빨 고리 · 희미하게 달아오른
 * 목구멍. 외부 에셋 없이 절차 지오메트리이고 **광원은 없다** (목구멍은 emissive).
 *
 * - 머티리얼은 버그 리그와 같은 두 종류뿐이다: 정점색 `MeshStandardMaterial`(피부 · 흙 무덤) 과 정점색 없는
 *   `MeshStandardMaterial`(목구멍 — 버그 눈과 같은 프로그램). 그래서 레이드 중 처음 만들어져도 새 셰이더 변형이 생기지 않는다.
 *   (그래도 디렉터는 이벤트가 굴려진 레이드의 `world:ready` 에서 리그 하나를 미리 만들어 `ctx.shaders.warm` 한다.)
 * - 마디는 사슬 그룹이다 — 위로 갈수록 앞으로 숙이는 각을 나눠 가져 입이 표적 쪽을 본다. 히트 캡슐은 `EnemySystem.raycastEx`
 *   의 세로 캡슐(`enemies.csv` 반지름 · 높이) 그대로이고 숙임은 그 안에 들어가게 작다.
 * - `BugAnim` 을 그대로 쓴다: `mandible` = 입 벌림, `abdomen` = 뱉기 전 목구멍 꿀렁임, `aim` = 독극물 준비 숙임,
 *   `shake` = 떨림, `death` / `deathDir` / `fade` = 옆으로 쓰러지며 굴로 가라앉음. `sink` 인자 = 굴착 중 아직 땅속인 깊이
 *   (흙 무덤은 땅 위에 남고 몸통만 내려간다).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import { ENEMY_STATS } from '../EnemyTypes';
import { statusEmissive, type BugAnim } from './BugModel';

export type WormType = 'sandworm';

/* ── 그림 수치 (밸런스가 아니다 — 판정은 enemies.csv 의 반지름 · 높이 · 머리 구) ── */
/** 마디 수. */
const SEGMENTS = 9;
/** 턱 수. */
const JAWS = 4;
/** 몸통이 땅속에 박혀 시작하는 깊이(m) — 흙 무덤 아래로 몸통이 이어져 보인다. */
const BURIED_M = 0.8;
/** 가장 아래 마디 반지름 = 판정 반지름 × 이 값, 가장 위 마디는 × (이 값 − TAPER). */
const BASE_RADIUS_MUL = 0.92;
const TAPER = 0.24;
/** 서 있을 때 위로 갈수록 나눠 갖는 앞숙임 총량(rad). */
const LEAN_REST = 0.3;

const SKIN = 0xa68456;
const SKIN_DARK = 0x6a4b2d;
const RIDGE = 0x4f3620;
const TOOTH = 0xe6dac0;
const DIRT = 0x4e3c2b;

export interface WormParams {
  /** 입(머리) 구 — 발 기준 높이 · 정면 거리 · 반지름 (`Enemy.headCenter`). */
  readonly head: { y: number; z: number; r: number };
  /** 보행 위상용 (움직이지 않지만 공용 코드가 읽는다). */
  readonly strideLength: number;
  /** 마디 하나의 길이(m). */
  readonly segLen: number;
  /** 판정 반지름(m). */
  readonly radius: number;
}

export interface WormRig {
  kind: 'worm';
  type: WormType;
  params: WormParams;
  baseScale: number;
  root: THREE.Group;
  /** 몸통 전체 (굴착 · 사망 가라앉음이 여기를 내린다 — 흙 무덤은 root 에 남는다). */
  body: THREE.Group;
  segments: THREE.Group[];
  segMeshes: THREE.Mesh[];
  /** 가장 위 마디 끝에 붙은 입 (월드 위치 = 뱉는 자리). */
  mouth: THREE.Group;
  jaws: THREE.Group[];
  mound: THREE.Mesh;
  skin: THREE.MeshStandardMaterial;
  throat: THREE.MeshStandardMaterial;
}

interface WormAssets {
  segment: THREE.BufferGeometry;
  jaw: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  throat: THREE.BufferGeometry;
  mound: THREE.BufferGeometry;
  skin: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  throatMat: THREE.MeshStandardMaterial;
}

let assets: WormAssets | null = null;
const tmpColor = new THREE.Color();

function colorize(geo: THREE.BufferGeometry, hex: number, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  tmpColor.setHex(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = jitter > 0 ? 1 + (Math.random() - 0.5) * jitter : 1;
    arr[i * 3] = Math.min(1, tmpColor.r * k); arr[i * 3 + 1] = Math.min(1, tmpColor.g * k); arr[i * 3 + 2] = Math.min(1, tmpColor.b * k);
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[enemies] worm mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}

/** 마디 하나 (반지름 1 · 길이 `len`, 밑면이 y 0). 메시 스케일 xz 가 실제 반지름이다. */
function buildSegment(len: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(colorize(new THREE.CylinderGeometry(0.95, 1.0, len, 18, 3, true).translate(0, len * 0.5, 0), SKIN, 0.12));
  // 마디 사이 두꺼운 고리 (밑단) — 어두운 색이 마디를 끊어 읽히게 한다
  parts.push(colorize(new THREE.TorusGeometry(1.0, 0.11, 6, 18).rotateX(Math.PI / 2).translate(0, 0.06, 0), RIDGE, 0.1));
  // 등쪽 비늘판 세 장 (뒤 · 좌 · 우)
  for (let k = 0; k < 3; k++) {
    const a = Math.PI + (k - 1) * 0.9;
    const plate = new THREE.SphereGeometry(1, 8, 6);
    plate.scale(0.34, len * 0.34, 0.12);
    plate.rotateY(a);
    plate.translate(Math.sin(a) * 0.96, len * 0.52, Math.cos(a) * 0.96);
    parts.push(colorize(plate, SKIN_DARK, 0.15));
  }
  return merge(parts);
}

/** 턱 한 장 — 밑동(y 0)이 입 가장자리에 붙고 +Y 로 뻗는 휜 꽃잎, 안쪽(−Z)에 이빨. */
function buildJaw(len: number, width: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const petal = new THREE.SphereGeometry(1, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  petal.scale(width, len, width * 0.42);
  parts.push(colorize(petal, SKIN, 0.1));
  const teeth = 5;
  for (let i = 0; i < teeth; i++) {
    const t = (i + 0.5) / teeth;
    const cone = new THREE.ConeGeometry(width * 0.1, width * 0.55, 5);
    cone.rotateX(-Math.PI / 2 - 0.35);   // 안쪽 · 아래를 향한다
    cone.translate((t - 0.5) * width * 1.2, len * (0.25 + 0.55 * (1 - Math.abs(t - 0.5))), -width * 0.3);
    parts.push(colorize(cone, TOOTH, 0.05));
  }
  return merge(parts);
}

/** 입 가장자리 고리 + 목구멍을 두른 안쪽 이빨. */
function buildRim(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(colorize(new THREE.TorusGeometry(r, r * 0.12, 6, 20).rotateX(Math.PI / 2), RIDGE, 0.1));
  const ring = 14;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const cone = new THREE.ConeGeometry(r * 0.07, r * 0.42, 5);
    cone.rotateZ(Math.PI / 2 + 0.5);        // 가운데를 향해 기울어진다
    cone.rotateY(-a);
    cone.translate(Math.cos(a) * r * 0.78, -r * 0.05, Math.sin(a) * r * 0.78);
    parts.push(colorize(cone, TOOTH, 0.05));
  }
  return merge(parts);
}

/** 흙 무덤 — 납작한 둔덕 + 흩어진 흙덩이. */
function buildMound(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const dome = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  dome.scale(r * 1.9, r * 0.45, r * 1.9);
  parts.push(colorize(dome, DIRT, 0.2));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.random() * 0.4;
    const d = r * (1.7 + Math.random() * 0.8);
    const s = r * (0.18 + Math.random() * 0.16);
    const rock = new THREE.DodecahedronGeometry(s, 0);
    rock.translate(Math.cos(a) * d, s * 0.3, Math.sin(a) * d);
    parts.push(colorize(rock, DIRT, 0.3));
  }
  return merge(parts);
}

function wormParams(): WormParams {
  const st = ENEMY_STATS.sandworm;
  const segLen = (st.height + BURIED_M) / SEGMENTS;
  return { head: { y: st.height * 0.9, z: 1.6, r: st.headRadius }, strideLength: 1, segLen, radius: st.radius };
}

function getAssets(): WormAssets {
  if (assets) return assets;
  const p = wormParams();
  const topR = p.radius * (BASE_RADIUS_MUL - TAPER);
  assets = {
    segment: buildSegment(p.segLen),
    jaw: buildJaw(topR * 1.25, topR * 0.9),
    rim: buildRim(topR * 1.02),
    throat: new THREE.CircleGeometry(topR * 0.82, 20).rotateX(-Math.PI / 2),
    mound: buildMound(p.radius),
    skin: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.1, emissive: 0x000000 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.1, emissive: 0x000000 }),
    throatMat: new THREE.MeshStandardMaterial({ color: 0x250a06, emissive: 0xff5a1e, emissiveIntensity: 2.4, roughness: 0.3 }),
  };
  return assets;
}

/** 공유 지오메트리 · 템플릿 머티리얼 해제 (리그를 먼저 dispose). */
export function disposeWormAssets(): void {
  if (!assets) return;
  assets.segment.dispose(); assets.jaw.dispose(); assets.rim.dispose(); assets.throat.dispose(); assets.mound.dispose();
  assets.skin.dispose(); assets.dirt.dispose(); assets.throatMat.dispose();
  assets = null;
}

export function createWormRig(): WormRig {
  const a = getAssets();
  const p = wormParams();
  const skin = a.skin.clone();
  const throat = a.throatMat.clone();
  const root = new THREE.Group();
  root.name = 'worm_sandworm';

  const mound = new THREE.Mesh(a.mound, a.dirt);
  mound.receiveShadow = true;
  mound.layers.enable(Layers.NO_RAYCAST);
  root.add(mound);

  const body = new THREE.Group();
  body.position.y = -BURIED_M;
  root.add(body);

  const segments: THREE.Group[] = [];
  const segMeshes: THREE.Mesh[] = [];
  let parent: THREE.Object3D = body;
  for (let i = 0; i < SEGMENTS; i++) {
    const g = new THREE.Group();
    g.position.y = i === 0 ? 0 : p.segLen;
    const m = new THREE.Mesh(a.segment, skin);
    const r = p.radius * (BASE_RADIUS_MUL - TAPER * (i / (SEGMENTS - 1)));
    m.scale.set(r, 1, r);
    m.castShadow = true;
    m.layers.enable(Layers.ENEMY);
    g.add(m);
    parent.add(g);
    segments.push(g);
    segMeshes.push(m);
    parent = g;
  }

  const mouth = new THREE.Group();
  mouth.position.y = p.segLen;
  parent.add(mouth);
  const rim = new THREE.Mesh(a.rim, skin);
  rim.layers.enable(Layers.ENEMY);
  mouth.add(rim);
  const throatMesh = new THREE.Mesh(a.throat, throat);
  throatMesh.position.y = -0.25;
  throatMesh.layers.enable(Layers.ENEMY);
  mouth.add(throatMesh);

  const topR = p.radius * (BASE_RADIUS_MUL - TAPER);
  const jaws: THREE.Group[] = [];
  for (let k = 0; k < JAWS; k++) {
    const ang = (k / JAWS) * Math.PI * 2 + Math.PI / JAWS;
    const hinge = new THREE.Group();
    hinge.position.set(Math.sin(ang) * topR, 0, Math.cos(ang) * topR);
    hinge.rotation.y = ang;
    const tilt = new THREE.Group();   // rotation.x = 벌림 (+ = 바깥으로 젖힘)
    const jm = new THREE.Mesh(a.jaw, skin);
    jm.castShadow = true;
    jm.layers.enable(Layers.ENEMY);
    tilt.add(jm);
    hinge.add(tilt);
    mouth.add(hinge);
    jaws.push(tilt);
  }

  return { kind: 'worm', type: 'sandworm', params: p, baseScale: 1, root, body, segments, segMeshes, mouth, jaws, mound, skin, throat };
}

export function disposeWormRig(rig: WormRig): void {
  rig.skin.dispose();
  rig.throat.dispose();
  rig.root.removeFromParent();
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * 한 프레임의 자세. `sink` = 굴착 중 아직 땅속에 있는 깊이(m, `Enemy.burrowSink`) — 몸통만 내리고 흙 무덤은 땅에 남는다.
 * 할당 없음.
 */
export function animateWorm(rig: WormRig, a: BugAnim, sink: number): void {
  const t = a.time;
  const dying = a.death >= 0;
  const n = rig.segments.length;
  const d = dying ? smooth(Math.min(1, a.death * 1.4)) : 0;
  const side = a.deathDir === 1 ? 1 : a.deathDir === 0 ? -1 : 0;
  const shake = a.shake > 0 ? (Math.sin(t * 47) * 0.05 + Math.sin(t * 31) * 0.035) * a.shake : 0;
  const wr = a.writhe;

  // 몸통: 굴착 가라앉음 · 떨림 · 사망 가라앉음 · 페이드
  rig.body.position.set(shake, -BURIED_M - sink - d * rig.params.segLen * 2.5 - smooth(Math.min(1, a.fade)) * rig.params.segLen * 4, shake * 0.6);

  const lean = LEAN_REST + a.aim * 0.18 + Math.sin(t * 0.55) * 0.05 + a.flinch * a.flinchZ * 0.12;
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += Math.pow((i + 1) / n, 1.5);
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    const w = Math.pow(f, 1.5) / wsum;
    const g = rig.segments[i];
    const sway = Math.sin(t * 0.9 + i * 0.55) * 0.03 * f + Math.sin(t * 7.3 + i) * 0.06 * wr * f;
    // 사망: 앞숙임이 커지고 옆으로 말리며 쓰러진다 (deathDir 2 = 뒤로 젖힌다)
    const deathBend = side === 0 ? -d * 1.4 * w * n * 0.2 : d * 0.35 * w * n * 0.2;
    g.rotation.set(lean * w + deathBend + a.flinch * 0.02 * f, 0, sway + side * d * 1.7 * w + a.flinch * a.flinchX * 0.03 * f);
    // 뱉기 전 꿀렁임: 아래에서 위로 올라가는 불룩한 고리
    const ripple = a.abdomen > 0.001 ? 1 + 0.14 * a.abdomen * Math.max(0, Math.sin(t * 8 - i * 0.85)) : 1;
    const m = rig.segMeshes[i];
    const r0 = rig.params.radius * (BASE_RADIUS_MUL - TAPER * (i / (n - 1)));
    m.scale.set(r0 * ripple, 1, r0 * ripple);
  }

  // 입: 쉬는 동안에도 조금씩 여닫는다
  const open = dying ? THREE.MathUtils.lerp(Math.max(a.mandible, 0.2), 1.25, d) : Math.max(a.mandible, 0.12 + 0.08 * Math.sin(t * 1.3)) + wr * 0.3 * Math.abs(Math.sin(t * 9));
  for (let k = 0; k < rig.jaws.length; k++) {
    rig.jaws[k].rotation.x = -0.28 + open * 1.15 + Math.sin(t * 2.1 + k * 1.7) * 0.03;
  }

  statusEmissive(rig.skin, a, 1, 0.55, 0.3, 1.0);
  rig.throat.emissiveIntensity = dying ? 2.4 * (1 - smooth(Math.min(1, a.death / 0.6))) : 1.2 + open * 1.6 + a.abdomen * 1.2;
}
