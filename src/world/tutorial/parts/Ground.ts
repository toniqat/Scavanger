import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  CHASM, CORRIDOR_HALF_X, DECKS, DECK_TILE_M, DECK_UPPER_Y, VOID_Y, WALL_T, WALL_TOP_Y, Z_END, Z_START,
  box, rectBox, tileRect, type Rect,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * 튜토리얼 행성의 **땅** — 협곡 바닥 · 데크 · 양옆 절벽 벽 · 막다른 끝.
 *
 * 콜라이더와 그림이 갈라져 있다:
 *   - **콜라이더**는 `DECK_TILE_M` 짜리 사각 타일 (`SpatialHash.addBox`). 한 장으로 넣으면 외접원이 85 m 가 되어
 *     `maxRadius` 가 그만큼 커지고 **모든** 해시 질의가 한 프레임마다 수백 칸을 훑는다.
 *   - **그림**은 데크 사각형마다 상자 하나 + 윗면 판 하나. 타일 경계마다 메시를 나눌 이유가 없다.
 * 광원은 **하나도 만들지 않는다** (`CLAUDE.md`: 씬의 광원 개수를 플레이 중에 바꾸지 않는다) — 전부 emissive 다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 협곡 바닥 판이 덮는 반폭 · 반길이 (벽 바깥까지 넉넉히). */
const FLOOR_HALF_X = CORRIDOR_HALF_X + WALL_T + 6;

function groundTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5a5044'; g.fillRect(0, 0, S, S);
  // 돌결 얼룩
  for (let i = 0; i < 220; i++) {
    const x = (i * 71) % S, y = (i * 137) % S, r = 4 + ((i * 29) % 26);
    g.fillStyle = i % 3 === 0 ? 'rgba(110,98,82,0.30)' : 'rgba(58,50,41,0.26)';
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, (i % 7) * 0.45, 0, Math.PI * 2); g.fill();
  }
  // 갈라진 틈
  g.strokeStyle = 'rgba(32,27,22,0.55)'; g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = (i * 53) % S, y = (i * 97) % S;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += ((i + k) % 5) * 11 - 18; y += ((i * k) % 6) * 9 + 6; g.lineTo(x, y); }
    g.stroke();
  }
  // 잔모래
  g.fillStyle = 'rgba(150,136,112,0.22)';
  for (let i = 0; i < 400; i++) g.fillRect((i * 181) % S, (i * 61) % S, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cliffTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a342c'; g.fillRect(0, 0, S, S);
  // 수평 지층
  for (let y = 0; y < S; y += 9) {
    g.fillStyle = `rgba(${26 + ((y * 7) % 40)},${22 + ((y * 5) % 34)},${18 + ((y * 3) % 28)},0.5)`;
    g.fillRect(0, y, S, 4 + ((y * 11) % 5));
  }
  // 세로 균열
  g.strokeStyle = 'rgba(18,15,12,0.7)'; g.lineWidth = 3;
  for (let i = 0; i < 10; i++) {
    let x = (i * 27) % S;
    g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y < S; y += 24) { x += ((i + y) % 5) * 4 - 8; g.lineTo(x, y); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 윗면 판 하나 (`rect` 크기에 맞춰 텍스처를 반복한다). */
function topPlane(rect: Rect, y: number, tex: THREE.CanvasTexture): THREE.Mesh {
  const w = rect.x1 - rect.x0, d = rect.z0 - rect.z1;
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  geo.translate((rect.x0 + rect.x1) / 2, y, (rect.z0 + rect.z1) / 2);
  const map = tex.clone();
  map.needsUpdate = true;
  map.repeat.set(w / 8, d / 8);
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0.03, emissive: 0x161310, emissiveIntensity: 0.5 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'tut-deck-top';
  mesh.receiveShadow = true;
  mesh.layers.enable(Layers.TERRAIN);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export class Ground {
  readonly group = new THREE.Group();
  private entries: ObstacleEntry[] = [];
  private disposables: Array<{ dispose(): void }> = [];

  constructor() { this.group.name = 'TutorialGround'; }

  build(root: THREE.Group, hash: SpatialHash): void {
    root.add(this.group);
    const groundTex = groundTexture();
    const cliffTex = cliffTexture();
    this.disposables.push(groundTex, cliffTex);

    const cliffMap = cliffTex.clone(); cliffMap.needsUpdate = true; cliffMap.repeat.set(6, 4);
    const rockMat = new THREE.MeshStandardMaterial({ map: cliffMap, roughness: 0.96, metalness: 0.04, emissive: 0x0d0b09, emissiveIntensity: 0.6 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x231f1a, roughness: 1, metalness: 0.02, emissive: 0x090807, emissiveIntensity: 0.7 });
    this.disposables.push(cliffMap, rockMat, darkMat);

    /* ── 협곡 바닥 (그림만; 높이 질의는 `TutorialWorld.heightAt` 이 상수로 답한다) ── */
    const floorGeo = new THREE.PlaneGeometry(FLOOR_HALF_X * 2, Z_START - Z_END);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, VOID_Y, (Z_START + Z_END) / 2);
    const floor = new THREE.Mesh(floorGeo, darkMat);
    floor.name = 'tut-void-floor';
    floor.layers.enable(Layers.TERRAIN);
    floor.matrixAutoUpdate = false;
    this.group.add(floor);
    this.disposables.push(floorGeo);

    /* ── 데크: 몸통 상자(그림) + 윗면 판(그림) + 타일 콜라이더 ── */
    const bodies: THREE.BufferGeometry[] = [];
    for (const d of DECKS) {
      bodies.push(rectBox(d.rect, VOID_Y, d.top));
      const top = topPlane(d.rect, d.top + 0.02, groundTex);
      this.group.add(top);
      this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
      for (const t of tileRect(d.rect, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, d.top, 'tut_deck');
    }
    this.addMerged(bodies, rockMat, 'tut-deck-body');

    /* ── 양옆 절벽 벽 · 막다른 끝 ──
     * 곧은 판 하나면 복도처럼 보이므로 z 10 m 마다 **구간**으로 끊어 안쪽 면과 높이를 흔든다. 구간마다
     * 콜라이더를 따로 넣으므로 **그려진 실루엣이 곧 콜라이더**다 (`CLAUDE.md` 의 소품 규약과 같은 판단) —
     * 안쪽으로만 파고들게 해서 데크(±`CORRIDOR_HALF_X`)와 벽 사이에 틈이 생기지 않는다. */
    const walls: THREE.BufferGeometry[] = [];
    const SEG = 10;
    for (const sx of [-1, 1]) {
      for (let i = 0; ; i++) {
        const z0 = Z_START - i * SEG;
        const z1 = Math.max(Z_END, z0 - SEG);
        if (z0 <= Z_END) break;
        const k = i * 7 + (sx > 0 ? 3 : 0);
        const bite = (k % 5) * 0.55;                       // 안쪽으로 파고든 깊이 (0 ~ 2.2 m)
        const top = WALL_TOP_Y - (k % 4) * 1.6;
        const inner = sx * (CORRIDOR_HALF_X - bite), outer = sx * (CORRIDOR_HALF_X + WALL_T);
        const rect: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0, z1 };
        walls.push(rectBox(rect, VOID_Y, top));
        this.addBox(hash, rect, VOID_Y, top, 'tut_wall');
      }
    }
    for (const cap of [
      { x0: -CORRIDOR_HALF_X - WALL_T, x1: CORRIDOR_HALF_X + WALL_T, z0: Z_START, z1: Z_START - WALL_T },
      { x0: -CORRIDOR_HALF_X - WALL_T, x1: CORRIDOR_HALF_X + WALL_T, z0: Z_END + WALL_T, z1: Z_END },
    ] as Rect[]) {
      walls.push(rectBox(cap, VOID_Y, WALL_TOP_Y));
      for (const t of tileRect(cap, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, WALL_TOP_Y, 'tut_wall');
    }
    this.addMerged(walls, rockMat, 'tut-walls');

    /* ── 절벽 1 의 틈에 부러져 걸린 다리 (그림만 — **데크 윗면보다 아래**라 밟을 수도, 건널 수도 없다) ── */
    const bridge: THREE.BufferGeometry[] = [];
    const zMid = (CHASM.z0 + CHASM.z1) / 2;
    for (const sx of [-1, 1]) {
      bridge.push(box(1.1, 0.5, 3.0, sx * 12, DECK_UPPER_Y - 1.1, CHASM.z0 - 0.6, sx * 0.22));
      bridge.push(box(0.9, 0.4, 3.6, sx * 12.8, DECK_UPPER_Y - 2.9, zMid, sx * 0.55));
    }
    bridge.push(box(3.2, 0.4, 1.2, -12.4, DECK_UPPER_Y - 4.4, CHASM.z1 + 0.4, 0.3));
    this.addMerged(bridge, darkMat, 'tut-broken-bridge', true);
  }

  private addBox(hash: SpatialHash, r: Rect, y0: number, top: number, kind: string): void {
    const hx = (r.x1 - r.x0) / 2, hz = (r.z0 - r.z1) / 2;
    const pos = new THREE.Vector3((r.x0 + r.x1) / 2, y0, (r.z0 + r.z1) / 2);
    this.entries.push(hash.addBox(pos, hx, hz, 0, top - y0, kind));
  }

  /** `cast` 는 기본이 false 다 — 데크 · 절벽 벽은 **땅**이라 그림자를 만들 것이 아니라 받는 것이다. */
  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast = false): void {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.disposables.push(merged);
  }

  dispose(hash: SpatialHash): void {
    for (const e of this.entries) hash.remove(e);
    this.entries.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}
