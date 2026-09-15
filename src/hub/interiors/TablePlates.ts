import * as THREE from 'three';
import type { GameContext, MealDef } from '@/shared';
import { MEAL_QUALITY_MAX, getMealDef, normalizeMealQuality } from '@/shared';
import { GeoBatch, disposeMeshes } from './GeoBatch';
import { TextPlane } from '../Labels';
import type { TablePlateSlot } from './stations';

/* ────────────────────────────────────────────────────────────────────────────
 * 식탁 위의 접시 (2026-09-16 접시 모델, 사용자 결정 — 요리는 아이템이 아니라 식탁의 접시다).
 *
 *  • `addPlateToBatch` — 접시 한 장(그릇 + 요리 모양)을 `GeoBatch` 에 넣는다. 개인 함선의 식탁 가구(`Furniture.ts` 의 `dining_table`
 *    빌더, `BuildExtra.plate`)와 공유 함선의 고정 식탁(`TablePlates`)이 같은 모양을 쓴다.
 *  • `TablePlates` — 공유 함선 고정 식탁의 **분대원 전원의 접시**(`HousingRef.getTablePlates(null)`)를 식기 네 자리에 올리고, 접시마다
 *    요리한 사람 이름표를 세운다. `housing:tablePlatesChanged` · `hub:entered` 에 다시 짓는다 (접시가 같으면 짓지 않는다).
 *
 * 요리 모양은 티어가 정한다 (1 채소 = 초록 수북 · 2 페이스트 = 동글동글 세 덩이 · 3 고기 = 두툼한 조각 · 4 유제품 = 크림색 둥근 요리),
 * 품질 별 `MEAL_QUALITY_MAX` 는 금빛 고명 한 점. **광원은 만들지 않는다** (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」 —
 * 고명의 빛은 emissive 뿐이다). 재질은 표준 재질이라 새 셰이더 프로그램이 생기지 않고, 모듈에 한 번 만들어 영원히 쓴다
 * (`FurnitureKitchen.liquidMat` 과 같은 규약 — 버리지 않는다). 색은 연출 값이지 밸런스 수치가 아니다.
 * ──────────────────────────────────────────────────────────────────────────── */

const std = (color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });

const MAT = {
  porcelain: std(0xe9e4da, 0.35, 0.05),
  rim: std(0xb9b2a4, 0.4, 0.2),
  veg: std(0x7f9c4e, 0.85, 0.02),
  vegDark: std(0x4f6e32, 0.9, 0.02),
  broth: std(0xb58a52, 0.55, 0.05),
  paste: std(0x9a5e3a, 0.75, 0.04),
  meat: std(0x7a3f28, 0.7, 0.05),
  sear: std(0x3e2217, 0.85, 0.05),
  cream: std(0xeadcae, 0.6, 0.03),
  crust: std(0xd49a4a, 0.7, 0.03),
  leaf: std(0x5fae4a, 0.8, 0.02),
  gold: std(0xffd27a, 0.35, 0.3, 0xffa640, 1.2),
};

/** 접시 그릇의 반지름 (m, 연출 값) — `withDish` 가 아닐 때(공유 식탁의 식기 위)는 그 식기 크기에 맞춰 작게. */
const DISH_R = 0.15;

/**
 * 접시 한 장을 `b` 에 넣는다. (`x`, `y`, `z`) = 상판 위 그릇 바닥 가운데, `ry` = 식탁의 yaw (조각 방향을 맞춘다).
 * `withDish` false = 이미 그려진 식기(공유 함선 식탁) 위에 요리만 올린다.
 */
export function addPlateToBatch(b: GeoBatch, x: number, y: number, z: number, mealDefId: string, quality: number, ry = 0, withDish = true): void {
  const meal: MealDef | undefined = getMealDef(mealDefId)?.meal;
  const s = withDish ? 1 : 0.78;
  let top = y;
  if (withDish) {
    b.cyl(DISH_R, DISH_R * 0.8, 0.022, 20, x, y + 0.011, z, MAT.porcelain);
    b.cyl(DISH_R + 0.004, DISH_R + 0.004, 0.008, 20, x, y + 0.024, z, MAT.rim, 0, 0, 0, true);   // 테두리 (열린 원통)
    top = y + 0.024;
  }
  const L = (ox: number, oz: number): [number, number] => [x + Math.cos(ry) * ox + Math.sin(ry) * oz, z - Math.sin(ry) * ox + Math.cos(ry) * oz];
  switch (meal?.tier ?? 1) {
    case 1: {                                                          // 채소 · 국물 요리: 국물 한 겹 + 수북한 채소 + 잎
      b.cyl(0.1 * s, 0.1 * s, 0.012, 16, x, top + 0.006, z, MAT.broth);
      b.cyl(0.05 * s, 0.085 * s, 0.04 * s, 12, x, top + 0.012 + 0.02 * s, z, MAT.veg);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.4;
        const [px, pz] = L(Math.cos(a) * 0.05 * s, Math.sin(a) * 0.05 * s);
        b.box(0.03 * s, 0.012, 0.018 * s, px, top + 0.05 * s, pz, k === 1 ? MAT.vegDark : MAT.leaf, ry + a);
      }
      break;
    }
    case 2: {                                                          // 페이스트 요리: 동글동글 세 덩이
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        const [px, pz] = L(Math.cos(a) * 0.045 * s, Math.sin(a) * 0.045 * s);
        b.cyl(0.026 * s, 0.03 * s, 0.03 * s, 10, px, top + 0.015 * s, pz, MAT.paste);
        b.cyl(0.018 * s, 0.024 * s, 0.008, 10, px, top + 0.032 * s, pz, MAT.sear);
      }
      b.box(0.04 * s, 0.01, 0.02 * s, x, top + 0.04 * s, z, MAT.leaf, ry + 0.6);
      break;
    }
    case 3: {                                                          // 고기 요리: 두툼한 조각 + 탄 자국 + 곁들임
      const [mx, mz] = L(-0.012 * s, 0);
      b.box(0.14 * s, 0.035 * s, 0.09 * s, mx, top + 0.0175 * s, mz, MAT.meat, ry + 0.25);
      b.box(0.1 * s, 0.004, 0.012 * s, mx, top + 0.037 * s, mz, MAT.sear, ry + 0.25);
      const [gx, gz] = L(0.07 * s, 0.045 * s);
      b.box(0.035 * s, 0.018 * s, 0.03 * s, gx, top + 0.009 * s, gz, MAT.leaf, ry);
      break;
    }
    default: {                                                         // 유제품 요리: 크림색 둥근 요리 + 노릇한 윗면
      b.cyl(0.075 * s, 0.09 * s, 0.035 * s, 18, x, top + 0.0175 * s, z, MAT.cream);
      b.cyl(0.055 * s, 0.07 * s, 0.01, 18, x, top + 0.037 * s, z, MAT.crust);
      break;
    }
  }
  if (normalizeMealQuality(quality) >= MEAL_QUALITY_MAX) {
    const [gx, gz] = L(0, -0.02 * s);
    b.box(0.014, 0.014, 0.014, gx, top + 0.07 * s, gz, MAT.gold, ry + Math.PI / 4, Math.PI / 4);   // 금빛 고명 (별 다섯)
  }
}

/** 공유 함선 고정 식탁의 접시들 — 분대원 전원 (`getTablePlates(null)`). 식기 자리(`slots`)보다 많으면 앞에서부터. */
export class TablePlates {
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private labels: TextPlane[] = [];
  private key = '';
  private readonly offs: Array<() => void>;
  /** 스모크: 지금 올라가 있는 접시 수. */
  shown = 0;

  constructor(private readonly ctx: GameContext, parent: THREE.Object3D, private readonly slots: readonly TablePlateSlot[], private readonly yaw: number) {
    this.group.name = 'table-plates';
    parent.add(this.group);
    this.offs = [
      ctx.bus.on('housing:tablePlatesChanged', () => this.refresh()),
      ctx.bus.on('hub:entered', () => this.refresh()),
    ];
    this.refresh();
  }

  refresh(): void {
    let plates: ReturnType<NonNullable<NonNullable<GameContext['housing']>['getTablePlates']>> = [];
    try { plates = this.ctx.housing?.getTablePlates?.(null) ?? []; } catch { plates = []; }
    const list = plates.slice(0, this.slots.length);
    const key = list.map((p) => `${p.ownerId ?? 'me'}:${p.mealDefId}:${p.quality}:${p.ownerName}`).join('|');
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const b = new GeoBatch();
    const ry = this.yaw;
    list.forEach((p, i) => {
      const slot = this.slots[i];
      addPlateToBatch(b, slot.position.x, slot.position.y, slot.position.z, p.mealDefId, p.quality, ry, false);
      // 요리한 사람 이름표 — 식기 뒤(식탁 가운데 쪽)에 세우고, 그 자리에 앉는 사람 쪽을 본다 (PlaneGeometry 는 +Z 를 본다)
      const tag = new TextPlane(0.3, 0.075, 256);
      const inward = -slot.side * 0.15;
      tag.mesh.position.set(slot.position.x + Math.sin(ry) * inward, slot.position.y + 0.1, slot.position.z + Math.cos(ry) * inward);
      tag.mesh.rotation.y = ry + (slot.side < 0 ? Math.PI : 0);
      tag.set([p.mine ? `${p.ownerName} (나)` : p.ownerName], p.mine ? '#ffc98a' : '#e8e6e1', 'rgba(6,8,10,0.78)');
      this.group.add(tag.mesh);
      this.labels.push(tag);
    });
    b.build(this.group, this.meshes, true, true);
    this.shown = list.length;
  }

  private clear(): void {
    disposeMeshes(this.meshes);
    for (const t of this.labels) { t.mesh.removeFromParent(); t.dispose(); }
    this.labels = [];
    this.shown = 0;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.clear();
    this.group.removeFromParent();
  }
}
