/**
 * src/enemies/models/Portrait.ts — **enemy face thumbnails · display names** (2026-09-15, the result screen rework).
 *
 * The 「사망 원인」 row of the death result screen shows the face of the enemy that landed the last hit
 * (`EnemyManagerRef.renderPortrait`). Enemy models are procedural, so this folder is the only place that knows the shape and it is drawn here.
 *
 * - It builds **a fresh** rig of that type (tutorial `tut_*` takes the base type's rig through `baseTypeOf`), applies the
 *   default pose once, then stands it so the face looks at the camera but **angled to the viewer's left** (rig +Z = front, negative yaw = screen left).
 * - Humanoids are framed on head + shoulders, bugs on head · mandibles, the sandworm on its mouth, the scan drone on the whole body.
 * - It draws once with **its own scene · its own three-point lighting (key · fill · rim) + a hemisphere light · a
 *   short-lived offscreen `WebGLRenderer`**, pulls the image straight out with `toDataURL` and then throws the rig
 *   materials · the renderer away (`forceContextLoss`). The main scene's light count · the main canvas are untouched (CLAUDE.md's 「never change the point-light count at runtime」 is a rule about the main scene).
 * - The shared geometry caches (`assets` in `BugModel` · `RogueModel` · `WormModel`) are shared by every rig, so they are not disposed.
 * - One draw per (type, size), then cached. With no WebGL, null — the caller (ui) draws a fallback icon.
 */
import * as THREE from 'three';
import { NAMED_ROGUE_NAME_KO, type EnemyType } from '@/shared';
import { ALL_ENEMY_TYPES, baseTypeOf, isEggType, isRogueType, isWormType, type BugType } from '../EnemyTypes';
import { animateBug, createBugAnim, createBugRig, disposeBugRig, type BugRig } from './BugModel';
import { animateRogue, createRogueRig, disposeRogueRig, type RogueRig, type RogueType } from './RogueModel';
import { createWormRig, disposeWormRig, type WormRig } from './WormModel';
/* appended (2026-09-18): the bug egg */
import { createEggRig, disposeEggRig, type EggRig } from './EggModel';

/**
 * Display names. `data/enemies.csv` has no name column (it is a table of numbers), so the text lives here — the same
 * words as the NPC objective labels in meta/. A tutorial type uses its base type's name.
 */
const ENEMY_NAME_KO: Readonly<Partial<Record<EnemyType, string>>> = {
  scavenger: '스캐빈저', hunter: '헌터', warrior: '워리어', spewer: '스퓨어', charger: '차저', artillery: '포격 버그',
  toxic: '독성 버그', behemoth: '베헤모스', sandworm: '땅굴벌레', sandworm_weak: '어린 땅굴벌레', rogue: '로그', rogue_boss: '로그 분대장',
  rogue_scan_drone: '스캔 드론', android: '안드로이드', raider: '레이더', ...NAMED_ROGUE_NAME_KO,
  /* 2026-09-18: the nest's bug egg (the same word has to go into `meta/NpcRules.ENEMY_TYPE_KO` for the quest objective label to match — that file belongs to meta/) */
  bug_egg: '벌레 알',
};

const KNOWN = new Set<string>(ALL_ENEMY_TYPES);

function asEnemyType(type: string): EnemyType | null {
  return KNOWN.has(type) ? (type as EnemyType) : null;
}

/** `EnemyManagerRef.enemyDisplayName`. null for an unknown type. */
export function enemyDisplayNameOf(type: string): string | null {
  const t = asEnemyType(type);
  if (!t) return null;
  return ENEMY_NAME_KO[t] ?? ENEMY_NAME_KO[baseTypeOf(t)] ?? null;
}

/* ── Presentation numbers (screen presentation only — not game balance) ────────────────── */
/** Angle that turns the face to the viewer's left (rad). The rig's front +Z goes to (sin, 0, cos) → negative = screen left. */
const FACE_YAW = -0.62;
const PORTRAIT_FOV_DEG = 30;
const MIN_PX = 16;
const MAX_PX = 512;

const cache = new Map<string, string | null>();

type Built =
  | { kind: 'bug'; rig: BugRig }
  | { kind: 'rogue'; rig: RogueRig }
  | { kind: 'worm'; rig: WormRig }
  | { kind: 'egg'; rig: EggRig };

function build(type: EnemyType): Built {
  const look = baseTypeOf(type);
  if (isEggType(look)) return { kind: 'egg', rig: createEggRig() };   // 2026-09-18
  if (isWormType(look)) return { kind: 'worm', rig: createWormRig() };
  if (isRogueType(look)) {
    const rig = createRogueRig(look as RogueType);
    const a = createBugAnim();
    try { animateRogue(rig, a); } catch { /* the model still draws without the default pose */ }
    return { kind: 'rogue', rig };
  }
  const rig = createBugRig(look as BugType);
  const a = createBugAnim();
  try { animateBug(rig, a); } catch { /* the same as above */ }
  return { kind: 'bug', rig };
}

function disposeBuilt(b: Built): void {
  if (b.kind === 'bug') disposeBugRig(b.rig);
  else if (b.kind === 'rogue') disposeRogueRig(b.rig);
  else if (b.kind === 'egg') disposeEggRig(b.rig);   // 2026-09-18
  else disposeWormRig(b.rig);
}

const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/** The sphere the camera frames (centre · radius, world). */
function frameOf(b: Built, center: THREE.Vector3): number {
  if (b.kind === 'egg') {
    // an egg's whole body is its face
    _box.setFromObject(b.rig.shell);
    _box.getCenter(center);
    _box.getSize(_size);
    return Math.max(0.2, Math.max(_size.x, _size.y, _size.z) * 0.62);
  }
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
    // head + shoulders: framed a little below the head centre, with a radius 1.45× the head size
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
    // bugs · humanoids almost head-on (a little above); the sandworm's upward-opening mouth is looked down on from in front and above
    const dir = built.kind === 'worm' ? new THREE.Vector3(0, 0.8, 1).normalize() : new THREE.Vector3(0, 0.14, 1).normalize();
    const camera = new THREE.PerspectiveCamera(fov, 1, Math.max(0.01, dist - radius * 4), dist + radius * 8);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    // three-point lighting (directions relative to the camera) + a hemisphere light — they live in this scene only
    const hemi = new THREE.HemisphereLight(0xd6dcea, 0x2a2622, 1.1);
    scene.add(hemi);
    const addDir = (color: number, intensity: number, x: number, y: number, z: number): void => {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.copy(center).add(new THREE.Vector3(x, y, z).multiplyScalar(dist));
      l.target.position.copy(center);
      scene.add(l, l.target);
    };
    addDir(0xfff0d8, 3.0, -1.3, 1.4, 1.5);  // key: screen upper-left, in front
    addDir(0x9fb6ff, 1.0, 1.5, 0.2, 1.0);   // fill: screen right
    addDir(0xffffff, 2.6, 0.9, 1.1, -1.7);  // rim: behind and above

    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    return url && url.startsWith('data:image') ? url : null;
  } catch (e) {
    console.warn('[enemies] portrait render failed', e);
    return null;
  } finally {
    try { if (built) disposeBuilt(built); } catch { /* already disposed */ }
    if (renderer) {
      try { renderer.dispose(); renderer.forceContextLoss(); } catch { /* the context is already gone */ }
    }
  }
}

/** `EnemyManagerRef.renderPortrait`. Drawn once per (type, size). Unknown type · no WebGL → null. */
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
