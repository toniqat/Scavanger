/**
 * src/enemies/models/Portrait.ts — **적 얼굴 썸네일 · 표시 이름** (2026-09-15, 결과 창 개편).
 *
 * 사망 결과 창의 「사망 원인」 줄이 막타를 친 적의 얼굴을 보여 준다 (`EnemyManagerRef.renderPortrait`). 적 모델은
 * 절차 생성이라 그 모양을 아는 곳이 이 폴더뿐이므로 여기서 그린다.
 *
 * - 그 종류의 리그를 **새로** 하나 짓고(튜토리얼 `tut_*` 는 `baseTypeOf` 로 바탕 종류의 리그), 기본 자세를 한 번 입힌 뒤
 *   얼굴이 카메라를 보되 **보는 사람의 왼쪽으로 사선** 돌아가게 세운다 (리그 +Z = 정면, yaw 음수 = 화면 왼쪽).
 * - 인간형은 머리 + 어깨, 벌레는 머리 · 턱, 땅굴벌레는 입, 스캔 드론은 몸 전체를 잡는다.
 * - **자기 씬 · 자기 조명 3점(키 · 필 · 림) + 반구광 · 잠깐 쓰는 오프스크린 `WebGLRenderer`** 로 한 번 그리고
 *   곧바로 `toDataURL` 로 뽑은 뒤 리그 머티리얼 · 렌더러를 버린다(`forceContextLoss`). 메인 씬의 광원 개수 ·
 *   메인 캔버스는 건드리지 않는다 (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」 는 메인 씬의 규칙이다).
 * - 공유 지오메트리 캐시(`BugModel` · `RogueModel` · `WormModel` 의 `assets`)는 리그들이 함께 쓰는 것이라 버리지 않는다.
 * - (종류, 크기)마다 한 번만 그려 캐시한다. WebGL 을 못 만들면 null — 호출부(ui)가 대체 아이콘을 그린다.
 */
import * as THREE from 'three';
import { NAMED_ROGUE_NAME_KO, type EnemyType } from '@/shared';
import { ALL_ENEMY_TYPES, baseTypeOf, isRogueType, isWormType, type BugType } from '../EnemyTypes';
import { animateBug, createBugAnim, createBugRig, disposeBugRig, type BugRig } from './BugModel';
import { animateRogue, createRogueRig, disposeRogueRig, type RogueRig, type RogueType } from './RogueModel';
import { createWormRig, disposeWormRig, type WormRig } from './WormModel';

/**
 * 표시 이름. `data/enemies.csv` 에는 이름 칸이 없어(수치 표다) 글은 여기 둔다 — meta/ 의 NPC 목표 이름표와 같은 낱말.
 * 튜토리얼 종류는 바탕 종류의 이름을 쓴다.
 */
const ENEMY_NAME_KO: Readonly<Partial<Record<EnemyType, string>>> = {
  scavenger: '스캐빈저', hunter: '헌터', warrior: '워리어', spewer: '스퓨어', charger: '차저', artillery: '포격 버그',
  toxic: '독성 버그', behemoth: '베헤모스', sandworm: '땅굴벌레', sandworm_weak: '어린 땅굴벌레', rogue: '로그', rogue_boss: '로그 분대장',
  rogue_scan_drone: '스캔 드론', android: '안드로이드', raider: '레이더', ...NAMED_ROGUE_NAME_KO,
};

const KNOWN = new Set<string>(ALL_ENEMY_TYPES);

function asEnemyType(type: string): EnemyType | null {
  return KNOWN.has(type) ? (type as EnemyType) : null;
}

/** `EnemyManagerRef.enemyDisplayName`. 모르는 종류면 null. */
export function enemyDisplayNameOf(type: string): string | null {
  const t = asEnemyType(type);
  if (!t) return null;
  return ENEMY_NAME_KO[t] ?? ENEMY_NAME_KO[baseTypeOf(t)] ?? null;
}

/* ── 연출 수치 (화면 표현 전용 — 게임 밸런스가 아니다) ─────────────────────────────────── */
/** 얼굴을 보는 사람의 왼쪽으로 돌리는 각 (rad). 리그 정면 +Z 가 (sin, 0, cos) 로 간다 → 음수 = 화면 왼쪽. */
const FACE_YAW = -0.62;
const PORTRAIT_FOV_DEG = 30;
const MIN_PX = 16;
const MAX_PX = 512;

const cache = new Map<string, string | null>();

type Built =
  | { kind: 'bug'; rig: BugRig }
  | { kind: 'rogue'; rig: RogueRig }
  | { kind: 'worm'; rig: WormRig };

function build(type: EnemyType): Built {
  const look = baseTypeOf(type);
  if (isWormType(look)) return { kind: 'worm', rig: createWormRig() };
  if (isRogueType(look)) {
    const rig = createRogueRig(look as RogueType);
    const a = createBugAnim();
    try { animateRogue(rig, a); } catch { /* 기본 자세가 없어도 모델은 그려진다 */ }
    return { kind: 'rogue', rig };
  }
  const rig = createBugRig(look as BugType);
  const a = createBugAnim();
  try { animateBug(rig, a); } catch { /* 위와 같다 */ }
  return { kind: 'bug', rig };
}

function disposeBuilt(b: Built): void {
  if (b.kind === 'bug') disposeBugRig(b.rig);
  else if (b.kind === 'rogue') disposeRogueRig(b.rig);
  else disposeWormRig(b.rig);
}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/** 카메라가 잡을 구 (중심 · 반지름, 월드). */
function frameOf(b: Built, center: THREE.Vector3): number {
  if (b.kind === 'worm') {
    _box.setFromObject(b.rig.mouth);
    _box.getCenter(center);
    _box.getSize(_size);
    return Math.max(0.5, Math.max(_size.x, _size.y, _size.z) * 0.62);
  }
  if (b.kind === 'rogue') {
    if (b.rig.type === 'rogue_scan_drone') {
      _box.setFromObject(b.rig.root);
      _box.getCenter(center);
      _box.getSize(_size);
      return Math.max(0.2, Math.max(_size.x, _size.y, _size.z) * 0.6);
    }
    _box.setFromObject(b.rig.head);
    _box.getCenter(center);
    _box.getSize(_size);
    const h = Math.max(0.12, Math.max(_size.x, _size.y, _size.z));
    // 머리 + 어깨: 머리 중심보다 조금 아래를 잡고 머리 크기의 1.45배 반지름
    center.y -= h * 0.55;
    return h * 1.45;
  }
  _box.setFromObject(b.rig.head);
  _box.getCenter(center);
  _box.getSize(_size);
  const h = Math.max(0.1, Math.max(_size.x, _size.y, _size.z));
  center.y -= h * 0.08;
  return h * 0.95;
}

function draw(type: EnemyType, size: number): string | null {
  if (typeof document === 'undefined') return null;
  let renderer: THREE.WebGLRenderer | null = null;
  let built: Built | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    built = build(type);
    const root = built.rig.root;
    root.position.set(0, 0, 0);
    if (built.kind !== 'worm') root.rotation.y = FACE_YAW;
    root.visible = true;
    scene.add(root);
    scene.updateMatrixWorld(true);

    const center = new THREE.Vector3();
    const radius = frameOf(built, center);
    const fov = PORTRAIT_FOV_DEG;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(fov) / 2);
    // 벌레 · 인간형은 거의 정면(살짝 위), 땅굴벌레는 위로 벌린 입을 앞 위에서 내려다본다
    const dir = built.kind === 'worm' ? new THREE.Vector3(0, 0.8, 1).normalize() : new THREE.Vector3(0, 0.14, 1).normalize();
    const camera = new THREE.PerspectiveCamera(fov, 1, Math.max(0.01, dist - radius * 4), dist + radius * 8);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    // 3점 조명 (카메라 기준 방향) + 반구광 — 이 씬에만 산다
    const hemi = new THREE.HemisphereLight(0xd6dcea, 0x2a2622, 1.1);
    scene.add(hemi);
    const addDir = (color: number, intensity: number, x: number, y: number, z: number): void => {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.copy(center).add(new THREE.Vector3(x, y, z).multiplyScalar(dist));
      l.target.position.copy(center);
      scene.add(l, l.target);
    };
    addDir(0xfff0d8, 3.0, -1.3, 1.4, 1.5);  // key: 화면 왼쪽 위 앞
    addDir(0x9fb6ff, 1.0, 1.5, 0.2, 1.0);   // fill: 화면 오른쪽
    addDir(0xffffff, 2.6, 0.9, 1.1, -1.7);  // rim: 뒤 위

    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    return url && url.startsWith('data:image') ? url : null;
  } catch (e) {
    console.warn('[enemies] portrait render failed', e);
    return null;
  } finally {
    try { if (built) disposeBuilt(built); } catch { /* 이미 버려졌다 */ }
    if (renderer) {
      try { renderer.dispose(); renderer.forceContextLoss(); } catch { /* 컨텍스트가 이미 없다 */ }
    }
  }
}

/** `EnemyManagerRef.renderPortrait`. (종류, 크기)마다 한 번 그린다. 모르는 종류 · WebGL 없음 → null. */
export function renderEnemyPortrait(type: string, sizePx: number): string | null {
  const t = asEnemyType(type);
  if (!t) return null;
  const size = Math.max(MIN_PX, Math.min(MAX_PX, Math.round(Number.isFinite(sizePx) ? sizePx : 96)));
  const key = `${t}@${size}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const url = draw(t, size);
  cache.set(key, url);
  return url;
}
