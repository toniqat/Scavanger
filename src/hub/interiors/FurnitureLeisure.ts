import * as THREE from 'three';
import type { FurnitureModelKind, FurniturePoseKind, Rarity } from '@/shared';
import { RARITY_COLORS, SHELF_SLOTS } from '@/shared';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BuildExtra, FurnitureModel } from './Furniture';

/* ────────────────────────────────────────────────────────────────────────────
 * 서재 매체 (A-3e) · 헬스장 (A-3a) 가구 11종 — 2026-09-12.
 *
 * `Furniture.ts` 의 다른 빌더와 같은 규약이다 (발자국 가운데 · 바닥 y 0 · **앞 = −Z** · `GeoBatch` 로 재질당 메시 하나).
 * 다른 점은 둘:
 *  1. **움직이는 부분**(바벨 · 원반 · 러닝 벨트 줄무늬 · 크랭크 · 플라이휠 · 흔들의자 · 레코드)은 따로 병합된 **하위 그룹**이고
 *     `FurnitureModel.rig` / `spin` 으로 넘어가 `FurnitureLayer.update` 가 돌린다. 하위 그룹의 메시도 `model.meshes` 에 들어가므로
 *     조각을 버릴 때 · 시설 관리 고스트가 재질을 바꿀 때 똑같이 처리된다.
 *  2. **자세 기하**(`FurnitureRig.anchor` · `forward` · `focus`)를 **가구 로컬 좌표**로 함께 낸다 — hub 가 그것을 월드로 바꿔
 *     `PlayerRef.setFurniturePose` 에 넘긴다. 치수를 모델과 한 파일에 둬야 좌판을 옮겼는데 앉는 자리가 안 따라오는 일이 없다.
 *
 * 빛나는 것(TV 화면 · 축음기 나팔 · 주크박스 네온 · 턴테이블 LED)은 전부 emissive 재질이고 **점광원은 하나도 없다**
 * (CLAUDE.md 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」 · `smoke-lights`). 켜짐 / 꺼짐은 재질을 골라 다시 짓는 것으로 바뀐다.
 * 새 재질은 전부 `MeshStandardMaterial`(불투명 · FrontSide)이라 이미 컴파일된 프로그램을 그대로 쓴다 — 조각을 처음 놓아도
 * 셰이더 컴파일이 일어나지 않는다 (나팔 안쪽을 `DoubleSide` 로 그리지 않고 입구 원판으로 막은 이유다).
 * ──────────────────────────────────────────────────────────────────────────── */

/** 가구 모델 중 이 파일이 짓는 것. */
export type LeisureKind =
  | 'disc_stand' | 'record_rack' | 'rocking_chair' | 'tv' | 'gramophone' | 'jukebox' | 'turntable'
  | 'bench_rack' | 'smith_machine' | 'treadmill' | 'exercise_bike';

const LEISURE_KIND_SET: ReadonlySet<FurnitureModelKind> = new Set<FurnitureModelKind>([
  'disc_stand', 'record_rack', 'rocking_chair', 'tv', 'gramophone', 'jukebox', 'turntable',
  'bench_rack', 'smith_machine', 'treadmill', 'exercise_bike',
]);
export function isLeisureKind(kind: FurnitureModelKind): kind is LeisureKind { return LEISURE_KIND_SET.has(kind); }

/**
 * 자세 · 애니메이션 정보 (전부 가구 로컬 좌표, 앞 = −Z). 운동 기구 넷과 흔들의자가 갖는다.
 */
export interface FurnitureRig {
  pose: FurniturePoseKind;
  /** 몸을 받치는 면 — `FurniturePose.anchor` 의 로컬 값 (좌판 윗면 · 벤치 패드 윗면의 견갑골 자리 · 벨트 윗면 · 안장 윗면). */
  anchor: THREE.Vector3;
  /** 향하는 방향 (x, z) — `sit` · `run` · `cycle` = 몸이 보는 쪽, `bench` = **엉덩이 → 머리**. */
  forward: { x: number; z: number };
  /** 고정 카메라가 비추는 점 (운동 기구만). */
  focus?: THREE.Vector3;
  /** 옆 카메라의 거리 · 높이 (focus 기준). */
  camDist?: number;
  camUp?: number;
  /* ── 벤치프레스 (벤치 랙 · 스미스 머신) ── */
  /** 바벨 그룹 (원반 · 칼라 포함). `position` 이 바의 중심이다. */
  bar?: THREE.Group;
  /** 세션 중에만 보이는 원반 (`bar` 의 자식). */
  plates?: THREE.Group;
  /** 거치된 바의 자리 (y, z). */
  barRest?: { y: number; z: number };
  /**
   * 운동 중 바의 자리 — 위상 0(가슴) · 1(팔 다 편 자리), 그 사이는 **선형** (player 의 `FURN_BENCH` 주먹 경로와 같은 규약).
   * 스미스 머신은 레일이 수직이라 두 z 가 같다.
   */
  barPress?: { low: { y: number; z: number }; high: { y: number; z: number } };
  /* ── 트레드밀 ── */
  /** 벨트 줄무늬 그룹 — `position.z` 를 `[0, beltSpacing)` 로 밀면 끊김 없이 흐른다. */
  belt?: THREE.Group;
  beltSpacing?: number;
  /* ── 사이클 ── */
  /** 크랭크 그룹 (X 축 회전). 0 = 왼발(−X) 페달이 위. */
  crank?: THREE.Group;
  /** 페달 그룹 둘 — 크랭크와 반대로 돌려 수평을 지킨다. */
  pedals?: THREE.Group[];
  /** 플라이휠 그룹 (X 축 회전). */
  flywheel?: THREE.Group;
  /* ── 흔들의자 ── */
  /** 의자 전체 (앉아 있는 동안 X 축으로 흔들린다, 피벗 = 흔들 다리가 바닥에 닿는 점). */
  rock?: THREE.Group;
}

/* ── 재질 (전부 공용 · 버리지 않는다) ─────────────────────────────────────── */
function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}
const WOOD = std(0x7a5634, 0.78, 0.05);
const WOOD_DARK = std(0x4e3521, 0.82, 0.05);
const CHROME = std(0xc3cad2, 0.22, 0.92);
const RUBBER = std(0x17191c, 0.95, 0.05);
const VINYL = std(0x0f1012, 0.32, 0.25);
const DISC_FACE = std(0xd6dde6, 0.16, 0.9, 0x24303c, 0.3);
const BENCH_PAD = std(0x1d1f23, 0.72, 0.08);
const PLATE = std(0x202328, 0.58, 0.55);
const BELT = std(0x141619, 0.92, 0.05);
const BELT_STRIPE = std(0x3a4149, 0.85, 0.1);
const SLATE = std(0x353a41, 0.42, 0.4);
const JUKE_BODY = std(0x5b2630, 0.5, 0.25);
/** TV 화면 — 켜짐 (밝은 청백색 발광). 꺼짐은 `M.glassDark`. */
const TV_ON = std(0x9fd8ff, 0.3, 0.1, 0x4aa8f0, 1.5);
const TV_SKY = std(0x6fe0ff, 0.3, 0.1, 0x2fc4ff, 1.9);
const TV_GROUND = std(0x3a8a6a, 0.4, 0.1, 0x1f7a58, 1.4);
const TV_SUN = std(0xffd28a, 0.3, 0.1, 0xffa640, 2.2);
/** 축음기 · 주크박스의 따뜻한 불빛 (켜짐). */
const WARM_GLOW = std(0xffe3a0, 0.3, 0, 0xffb050, 2.3);
/** 주크박스 창 (켜짐) — 안쪽이 호박색으로 비친다. */
const JUKE_WINDOW_ON = std(0xffd8a8, 0.25, 0.1, 0xff9a50, 1.3);

const caseCache = new Map<string, THREE.MeshStandardMaterial>();
/** 매체 케이스 · 슬리브 재질 (등급색, 어두운 방에서도 읽히게 약한 발광). */
function caseMat(rarity: Rarity): THREE.MeshStandardMaterial {
  const css = RARITY_COLORS[rarity];
  let m = caseCache.get(css);
  if (!m) {
    const c = new THREE.Color(css);
    m = std(c.getHex(), 0.55, 0.15, c.getHex(), 0.22);
    caseCache.set(css, m);
  }
  return m;
}
const neonCache = new Map<string, THREE.MeshStandardMaterial>();
/** 네온관 (켜짐 = 강한 발광, 꺼짐 = 같은 색을 어둡게 · 발광 없음). */
function neon(css: string, on: boolean): THREE.MeshStandardMaterial {
  const key = `${css}|${on ? 1 : 0}`;
  let m = neonCache.get(key);
  if (!m) {
    const c = new THREE.Color(css);
    m = on ? std(c.getHex(), 0.3, 0.05, c.getHex(), 2.6) : std(c.clone().multiplyScalar(0.35).getHex(), 0.5, 0.2);
    neonCache.set(key, m);
  }
  return m;
}

/** 악센트 재질(`Furniture.tint`)의 원래 CSS 색 — 네온관이 카탈로그 색을 따라가게. */
function accentCss(a: THREE.Material): string {
  const c = (a as THREE.MeshStandardMaterial).color;
  return c instanceof THREE.Color ? `#${c.getHexString()}` : '#ffffff';
}

/* ── 헬퍼 ───────────────────────────────────────────────────────────────── */
/** 하위 그룹 하나를 `fill` 로 채워 병합한다. 메시는 `model.meshes` 에 들어간다. */
function rigGroup(model: FurnitureModel, parent: THREE.Object3D, name: string, x: number, y: number, z: number, fill: (b: GeoBatch) => void): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  const b = new GeoBatch();
  fill(b);
  b.build(g, model.meshes);
  parent.add(g);
  return g;
}

/** 원기둥(Y 축)을 방향 (dx, dy, dz)(단위 벡터)로 세우는 YXZ 오일러 — `GeoBatch.cyl` 의 rx, ry. */
function aim(dx: number, dy: number, dz: number): { rx: number; ry: number } {
  return { rx: Math.acos(THREE.MathUtils.clamp(dy, -1, 1)), ry: Math.atan2(dx, dz) };
}

/** Y 축 원기둥을 X 축으로 눕힌다 (바벨 · 원반 · 크랭크 축). */
const ALONG_X = Math.PI / 2;

/*
 * 자세 치수는 player 의 `SoldierModel` (`FURN_SIT` · `FURN_BENCH` · `FURN_CYCLE`, anchor 기준 m)에 맞췄다 — 손발이 IK 로 그 점에
 * 정확히 내려앉으므로 가구가 그 점에 맞춰 선다:
 *   sit   발바닥 (±0.17, −0.36, 앞 0.40)            → 좌판 윗면 0.36
 *   bench 발바닥 (±0.36, −0.40, 발 쪽 0.78) · 골반 발 쪽 0.42 → 패드 윗면 0.40
 *         주먹(= 바) 위상 0: 위 0.50 · 발 쪽 0.03 / 위상 1: 위 0.81 · 머리 쪽 0.06, 그립 x ±0.42
 *   cycle 크랭크 축 (0, −0.60, 앞 0.25) · 반지름 0.16 · 페달 x ±0.13 · 손잡이 (±0.22, +0.14, 앞 0.50)
 */
/** 벤치 패드 윗면 높이 — 벤치 랙과 스미스 머신이 같은 벤치를 쓴다. */
const PAD_TOP = 0.4;
/** 벤치의 발 쪽 끝 · 머리 끝 z. 머리 쪽이 +Z (거치대 쪽)이다. 발 쪽 끝은 골반(z 0.18) 조금 너머 — 발바닥(z −0.18)이 패드 옆 바닥에 닿는다. */
const PAD_Z0 = -0.2, PAD_Z1 = 0.78;
/** 벤치에 누운 견갑골 자리 z (패드 머리 끝에서 0.18 m). */
const BENCH_SHOULDER_Z = 0.6;
/** 벤치프레스 바(주먹 중심)의 위상 0 · 1 자리 — 패드 윗면 · 견갑골 기준 (위, 머리 쪽 +). */
const PRESS_LOW_UP = 0.5, PRESS_LOW_Z = -0.03, PRESS_HIGH_UP = 0.81, PRESS_HIGH_Z = 0.06;
/** 벤치 랙 · 스미스의 운동 중 바 자리 (가구 로컬). */
const BENCH_BAR_LOW = { y: PAD_TOP + PRESS_LOW_UP, z: BENCH_SHOULDER_Z + PRESS_LOW_Z };
const BENCH_BAR_HIGH = { y: PAD_TOP + PRESS_HIGH_UP, z: BENCH_SHOULDER_Z + PRESS_HIGH_Z };

/** 플랫 벤치 (패드 · 받침판 · 다리 둘 · 발 막대 · 척추 보). */
function flatBench(b: GeoBatch, a: THREE.Material): void {
  const len = PAD_Z1 - PAD_Z0, cz = (PAD_Z0 + PAD_Z1) / 2;
  b.box(0.3, 0.07, len, 0, PAD_TOP - 0.035, cz, BENCH_PAD);                                    // 패드
  b.box(0.306, 0.014, len + 0.006, 0, PAD_TOP - 0.064, cz, a);                                 // 파이핑
  b.box(0.26, 0.03, len - 0.06, 0, PAD_TOP - 0.086, cz, M.gunmetal);                           // 받침판
  for (const lz of [PAD_Z0 + 0.14, PAD_Z1 - 0.16]) {
    b.boxB(0.06, PAD_TOP - 0.1, 0.06, 0, 0, lz, M.hullLight);                                  // 다리
    b.box(0.46, 0.04, 0.07, 0, 0.02, lz, M.hullLight);                                         // 발 막대
    for (const sx of [-1, 1]) b.box(0.07, 0.022, 0.08, sx * 0.23, 0.011, lz, RUBBER);          // 고무 발
  }
  b.box(0.06, 0.05, len - 0.36, 0, 0.065, cz, M.hullLight);                                    // 척추 보
}

/** 바벨 (샤프트 · 널링 · 슬리브 · 칼라) + 원반 그룹. `half` = 샤프트 반길이, `sleeveIn` = 슬리브가 시작하는 |x|. */
function barbell(model: FurnitureModel, parent: THREE.Object3D, y: number, z: number, half: number, sleeveIn: number, a: THREE.Material, extra: (b: GeoBatch) => void, gymActive: boolean): { bar: THREE.Group; plates: THREE.Group } {
  const bar = rigGroup(model, parent, 'barbell', 0, y, z, (b) => {
    b.cyl(0.016, 0.016, half * 2, 12, 0, 0, 0, CHROME, 0, 0, ALONG_X);                         // 샤프트
    for (const sx of [-1, 1]) {
      b.cyl(0.019, 0.019, 0.22, 12, sx * 0.27, 0, 0, M.gunmetal, 0, 0, ALONG_X);               // 널링
      const sl = half - sleeveIn;
      b.cyl(0.026, 0.026, sl, 12, sx * (sleeveIn + sl / 2), 0, 0, CHROME, 0, 0, ALONG_X);      // 슬리브
      b.cyl(0.042, 0.042, 0.026, 14, sx * (sleeveIn + 0.013), 0, 0, M.trim, 0, 0, ALONG_X);    // 칼라
    }
    extra(b);
  });
  const plates = rigGroup(model, bar, 'plates', 0, 0, 0, (b) => {
    for (const sx of [-1, 1]) {
      const x0 = sleeveIn + 0.03;
      b.cyl(0.22, 0.22, 0.04, 28, sx * (x0 + 0.02), 0, 0, PLATE, 0, 0, ALONG_X);               // 큰 원반
      b.cyl(0.224, 0.224, 0.012, 28, sx * (x0 + 0.02), 0, 0, a, 0, 0, ALONG_X);                // 원반 테 (악센트)
      b.cyl(0.16, 0.16, 0.034, 24, sx * (x0 + 0.058), 0, 0, PLATE, 0, 0, ALONG_X);             // 작은 원반
      b.cyl(0.05, 0.05, 0.08, 14, sx * (x0 + 0.04), 0, 0, CHROME, 0, 0, ALONG_X);              // 허브
      b.cyl(0.036, 0.036, 0.02, 12, sx * (x0 + 0.09), 0, 0, M.stripRed, 0, 0, ALONG_X);        // 클립
    }
  });
  plates.visible = gymActive;
  return { bar, plates };
}

/* ── 빌더 ────────────────────────────────────────────────────────────────── */
type LeisureBuilder = (b: GeoBatch, model: FurnitureModel, w: number, d: number, h: number, a: THREE.Material, extra?: BuildExtra) => void;

/** 매체 칸 배열을 `n` 칸으로 맞춘다 (빈 칸 = null). */
function slotsOf(extra: BuildExtra | undefined, n: number): (Rarity | null)[] {
  const out: (Rarity | null)[] = new Array(n).fill(null);
  const src = extra?.media ?? [];
  for (let i = 0; i < n && i < src.length; i++) out[i] = src[i] ?? null;
  return out;
}

export const LEISURE_BUILDERS: Record<LeisureKind, LeisureBuilder> = {
  /**
   * 디스크 전시대 (`3 × 1 · 1.8`): 금속 프레임 진열장 — 선반 셋에 칸이 둘씩(`SHELF_SLOTS.disc`), 칸마다 앞으로 살짝 기운
   * 디스크 케이스가 선다. 케이스 뒷판이 **등급색**이고 앞에 은빛 디스크 면이 보인다. 빈 칸은 받침만 남는다.
   * 선반마다 앞 가장자리 아래에 흰 LED 띠(emissive)가 있어 진열장으로 읽힌다.
   */
  disc_stand: (b, _model, w, d, h, a, extra) => {
    const n = SHELF_SLOTS.disc;
    const slots = slotsOf(extra, n);
    b.boxB(w - 0.04, 0.1, d - 0.04, 0, 0, 0, M.gunmetal);                                        // 받침
    for (const sx of [-1, 1]) b.boxB(0.05, h, d, sx * (w / 2 - 0.025), 0, 0, M.hullLight);       // 옆판
    b.box(w - 0.1, h - 0.1, 0.03, 0, h / 2, d / 2 - 0.02, M.hullDark);                           // 뒷판
    b.box(w, 0.06, d, 0, h - 0.03, 0, M.hullLight);                                              // 천장
    b.box(w - 0.2, 0.035, 0.03, 0, h - 0.08, -(d / 2 - 0.015), a);                               // 천장 악센트
    const rows = 3, perRow = Math.ceil(n / rows);
    const y0 = 0.14, rowH = (h - 0.26) / rows;
    const tilt = 0.14;
    for (let r = 0; r < rows; r++) {
      const y = y0 + r * rowH;
      b.box(w - 0.1, 0.035, d - 0.06, 0, y, 0.01, M.gunmetal);                                   // 선반
      b.box(w - 0.12, 0.045, 0.025, 0, y + 0.035, -(d / 2 - 0.06), M.trim);                      // 진열 턱
      b.box(w - 0.18, 0.012, 0.03, 0, y + rowH - 0.04, -(d / 2 - 0.07), M.stripWhite);           // 선반 조명 (위 선반 밑)
      for (let k = 0; k < perRow; k++) {
        const slot = (rows - 1 - r) * perRow + k;                                               // 0 = 왼쪽 위
        if (slot >= n) continue;
        const cx = (k - (perRow - 1) / 2) * ((w - 0.2) / perRow);
        const rarity = slots[slot];
        b.box(0.22, 0.02, 0.1, cx, y + 0.028, -0.02, M.hullDark);                                // 받침
        if (!rarity) continue;
        const cm = caseMat(rarity);
        const cy = y + 0.2;
        b.box(0.3, 0.3, 0.035, cx, cy, 0, cm, 0, tilt);                                          // 케이스 (등급색)
        b.cyl(0.12, 0.12, 0.006, 28, cx, cy + 0.003, -0.024, DISC_FACE, ALONG_X + tilt);         // 디스크 면
        b.cyl(0.03, 0.03, 0.008, 12, cx, cy + 0.003, -0.027, M.gunmetal, ALONG_X + tilt);        // 허브
        b.box(0.12, 0.03, 0.008, cx, y + 0.04, -(d / 2 - 0.044), cm);                            // 등급 표찰
      }
    }
  },

  /**
   * 레코드랙 (`3 × 2 · 1.2`): 짧은 다리의 원목 캐비닛(앞면에 레코드 등이 꽂힌 칸 둘) 위에 칸막이 달린 **레코드 통**. 통의 칸마다
   * (`SHELF_SLOTS.record`) 꽂힌 레코드가 등급색 슬리브로 서고, 슬리브 위로 검은 음반이 반쯤 솟는다. 뒤에 악센트 띠가 달린 머리판.
   */
  record_rack: (b, _model, w, d, h, a, extra) => {
    const n = SHELF_SLOTS.record;
    const slots = slotsOf(extra, n);
    const legH = 0.14;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(0.026, 0.017, legH, 8, sx * (w / 2 - 0.12), legH / 2, sz * (d / 2 - 0.12), M.gunmetal);
    const cabH = 0.46, cabTop = legH + cabH;
    b.boxB(w - 0.02, cabH, d - 0.04, 0, legH, 0, WOOD);                                          // 캐비닛
    b.box(w, 0.035, d, 0, cabTop + 0.0175, 0, WOOD_DARK);                                        // 상판
    const fz = -(d / 2 - 0.02);
    for (const sx of [-1, 1]) {
      const cx = sx * (w / 4);
      b.box(w / 2 - 0.12, cabH - 0.12, 0.012, cx, legH + cabH / 2, fz - 0.006, M.floorGrate);    // 칸 (어두운 안쪽)
      for (let k = 0; k < 9; k++) {
        const sh = cabH - 0.2 - ((k * 5) % 3) * 0.025;
        b.boxB(0.028, sh, 0.012, cx - 0.2 + k * 0.05, legH + 0.07, fz - 0.014, k % 3 === 0 ? a : k % 2 ? M.padding : M.fabric);   // 레코드 등
      }
    }
    b.box(w - 0.1, 0.03, 0.014, 0, legH + 0.03, fz - 0.008, a);                                  // 앞 악센트
    // ── 레코드 통
    const binY = cabTop + 0.035, binH = 0.26, binD = d - 0.32, binZ = -0.03;
    b.box(w - 0.06, 0.02, binD, 0, binY + 0.01, binZ, WOOD_DARK);                                // 통 바닥
    b.box(w - 0.06, 0.1, 0.03, 0, binY + 0.05, binZ - binD / 2, WOOD);                           // 앞 턱
    b.box(w - 0.06, binH, 0.03, 0, binY + binH / 2, binZ + binD / 2, WOOD);                      // 뒷벽
    for (const sx of [-1, 1]) b.box(0.03, binH, binD, sx * (w / 2 - 0.045), binY + binH / 2, binZ, WOOD);
    const inner = w - 0.12, cell = inner / n;
    for (let i = 1; i < n; i++) b.box(0.014, binH * 0.72, binD - 0.06, -inner / 2 + i * cell, binY + binH * 0.36, binZ, M.gunmetal);   // 칸막이
    // 머리판 + 악센트 조명
    const headZ = d / 2 - 0.05;
    b.box(w - 0.06, h - binY, 0.03, 0, (binY + h) / 2, headZ, WOOD_DARK);
    b.box(w - 0.24, 0.03, 0.02, 0, h - 0.06, headZ - 0.025, a);
    const tilt = 0.18, sy = binY + 0.02 + 0.15;
    for (let k = 0; k < n; k++) {
      const cx = -inner / 2 + (k + 0.5) * cell;
      const rarity = slots[k];
      b.box(0.1, 0.022, 0.008, cx, binY + 0.07, binZ - binD / 2 - 0.018, rarity ? caseMat(rarity) : M.hullDark);   // 칸 표찰
      if (!rarity) continue;
      const cm = caseMat(rarity);
      b.box(0.3, 0.3, 0.02, cx, sy, binZ, cm, 0, tilt);                                          // 슬리브 (등급색)
      b.cyl(0.05, 0.05, 0.004, 16, cx, sy - 0.02, binZ - 0.013, a, ALONG_X + tilt);               // 슬리브 라벨
      b.cyl(0.14, 0.14, 0.008, 28, cx, sy + 0.066, binZ + 0.028, VINYL, ALONG_X + tilt);         // 솟은 음반
    }
  },

  /**
   * 흔들의자 (`2 × 2 · 1.1`): 곡선 흔들 다리 둘(원호를 짧은 상자로 이은 것) · 다리 넷 · 쿠션 좌판 · 뒤로 기운 등받이(기둥 둘 ·
   * 윗가로대 · 살 다섯) · 팔걸이. **전부 `rig.rock` 그룹 안**이라 앉아 있는 동안 통째로 흔들린다 (피벗 = 원호 바닥점 = 그룹 원점).
   */
  rocking_chair: (_b, model, _w, _d, _h, a) => {
    const seatTop = 0.36;                                                                         // player FURN_SIT: 발바닥이 좌판 윗면 0.36 m 아래
    const seatBoard = seatTop - 0.05;                                                             // 좌판 윗면 (쿠션 밑)
    const armY = seatTop + 0.19;
    const rock = rigGroup(model, model.group, 'rock', 0, 0, 0, (b) => {
      const R = 1.35, span = 0.35, segs = 8;
      for (const sx of [-1, 1]) {
        for (let i = 0; i < segs; i++) {
          const am = -span + (2 * span) * (i + 0.5) / segs;
          const len = 2 * R * Math.sin(span / segs) + 0.012;
          b.box(0.045, 0.045, len, sx * 0.28, R * (1 - Math.cos(am)) + 0.0225, R * Math.sin(am), WOOD_DARK, 0, -am);   // 흔들 다리
        }
        b.boxB(0.042, seatBoard - 0.085, 0.042, sx * 0.28, 0.05, -0.2, WOOD);                    // 앞다리
        b.boxB(0.042, seatBoard - 0.09, 0.042, sx * 0.28, 0.055, 0.22, WOOD);                    // 뒷다리
        b.box(0.036, 0.03, 0.42, sx * 0.28, 0.16, 0.01, WOOD_DARK);                              // 옆 보
      }
      b.box(0.56, 0.03, 0.03, 0, 0.14, -0.2, WOOD_DARK);                                          // 앞 보
      b.box(0.62, 0.035, 0.52, 0, seatBoard - 0.0175, 0.01, WOOD);                               // 좌판
      b.box(0.52, 0.05, 0.46, 0, seatTop - 0.025, 0.02, M.padding);                              // 쿠션
      b.box(0.53, 0.012, 0.012, 0, seatTop - 0.03, -0.215, a);                                   // 쿠션 파이핑
      // 등받이 (뒤로 t 만큼 기운 축을 따라)
      const t = 0.22, by = seatBoard, bz = 0.25;
      const along = (s: number): [number, number] => [by + s * Math.cos(t), bz + s * Math.sin(t)];
      for (const sx of [-1, 1]) { const [y, z] = along(0.4); b.box(0.046, 0.8, 0.046, sx * 0.27, y, z, WOOD, 0, t); }
      { const [y, z] = along(0.74); b.box(0.6, 0.09, 0.036, 0, y, z, WOOD, 0, t); b.box(0.42, 0.016, 0.01, 0, y + 0.022 * Math.sin(t), z - 0.022 * Math.cos(t), a, 0, t); }
      { const [y, z] = along(0.14); b.box(0.54, 0.04, 0.03, 0, y, z, WOOD, 0, t); }
      for (let k = 0; k < 5; k++) { const [y, z] = along(0.43); b.box(0.045, 0.54, 0.018, -0.2 + k * 0.1, y, z, WOOD_DARK, 0, t); }
      // 팔걸이
      for (const sx of [-1, 1]) {
        b.box(0.07, 0.03, 0.56, sx * 0.31, armY, 0.0, WOOD);
        b.boxB(0.034, armY - seatBoard, 0.034, sx * 0.31, seatBoard, -0.2, WOOD);
        b.cyl(0.036, 0.036, 0.07, 10, sx * 0.31, armY, -0.28, WOOD_DARK, 0, 0, ALONG_X);
      }
    });
    model.rig = { pose: 'sit', anchor: new THREE.Vector3(0, seatTop, 0.02), forward: { x: 0, z: -1 }, rock };
  },

  /**
   * TV (`3 × 1 · 1.3`): 미디어 콘솔(문 둘 · 가운데 칸의 플레이어 · 앞 악센트) 위 받침대에 얇은 패널. `extra.on` 이면 화면이
   * 발광하고 화면 안에 하늘 · 지평선 · 해 · UI 막대가 뜬다. 꺼짐은 검은 유리 + 빨간 대기등.
   */
  tv: (b, _model, w, d, _h, a, extra) => {
    const on = extra?.on === true;
    b.boxB(w - 0.04, 0.06, d - 0.06, 0, 0, 0, M.gunmetal);                                        // 받침
    b.boxB(w - 0.02, 0.4, d - 0.04, 0, 0.06, 0, M.hullDark);                                     // 콘솔
    b.box(w, 0.03, d, 0, 0.475, 0, M.hullLight);                                                 // 상판 (윗면 0.49)
    const fz = -(d - 0.04) / 2;
    for (const sx of [-1, 1]) {
      b.box(0.5, 0.32, 0.015, sx * 0.49, 0.27, fz - 0.0075, M.hullLight);                        // 문
      b.box(0.012, 0.12, 0.02, sx * 0.27, 0.29, fz - 0.02, M.trim);                              // 손잡이
    }
    b.box(0.38, 0.32, 0.01, 0, 0.27, fz - 0.005, M.floorGrate);                                  // 가운데 칸
    b.box(0.3, 0.07, 0.012, 0, 0.17, fz - 0.016, M.gunmetal);                                    // 플레이어 앞면
    b.box(0.2, 0.008, 0.004, -0.02, 0.19, fz - 0.024, M.hullDark);                               // 디스크 투입구
    b.box(0.04, 0.012, 0.004, 0.1, 0.155, fz - 0.024, on ? M.stripCyan : M.hullDark);            // 재생등
    b.box(w - 0.12, 0.025, 0.014, 0, 0.09, fz - 0.012, a);                                       // 앞 악센트
    // 받침대 + 패널
    b.box(0.42, 0.02, 0.2, 0, 0.5, 0.04, M.gunmetal);
    b.boxB(0.07, 0.12, 0.04, 0, 0.51, 0.06, M.gunmetal);
    const cy = 0.94, sw = 1.28, sh = 0.6;
    b.box(1.34, 0.68, 0.045, 0, cy, 0.04, M.gunmetal);                                           // 베젤 (z 0.0175 … 0.0625)
    b.box(1.1, 0.4, 0.05, 0, cy, 0.085, M.hullDark);                                             // 뒤 볼록
    b.box(sw, sh, 0.006, 0, cy, 0.0145, on ? TV_ON : M.glassDark);                               // 화면
    if (on) {
      b.box(sw, 0.2, 0.004, 0, cy - sh / 2 + 0.1, 0.009, TV_GROUND);                             // 지평선 아래
      b.box(sw, 0.05, 0.004, 0, cy - sh / 2 + 0.225, 0.009, TV_SKY);                             // 지평선 띠
      b.cyl(0.09, 0.09, 0.004, 24, 0.34, cy + 0.08, 0.009, TV_SUN, ALONG_X);                     // 해
      b.box(0.36, 0.028, 0.004, -0.4, cy + 0.22, 0.009, M.stripWhite);                           // UI 막대
      b.box(0.22, 0.02, 0.004, -0.47, cy + 0.17, 0.009, a);
    }
    b.box(0.02, 0.012, 0.006, 0.6, cy - 0.325, 0.013, on ? M.stripWhite : M.stripRed);           // 전원등
    b.box(0.12, 0.01, 0.004, 0, cy - 0.325, 0.014, M.trim);                                      // 로고
    // 사운드바
    b.boxB(0.8, 0.06, 0.08, 0, 0.49, -0.16, M.hullDark);
    b.box(0.76, 0.03, 0.004, 0, 0.52, -0.2025, M.floorGrate);
  },

  /**
   * 축음기 (`2 × 2 · 1.3`): 둥근 원목 탁자 위의 나무 상자 · 턴테이블 · 태엽 손잡이 · 톤암, 그리고 뒤에서 솟아 앞으로 벌어지는
   * 황동 나팔(점점 커지는 원기둥 다섯). `extra.on` 이면 나팔 입구 · 앞 명판 · 레코드 라벨이 따뜻하게 빛나고 레코드가 돈다.
   */
  gramophone: (b, model, _w, _d, _h, a, extra) => {
    const on = extra?.on === true;
    const top = 0.62;
    b.cyl(0.42, 0.42, 0.04, 28, 0, top - 0.02, 0, WOOD);                                         // 탁자 상판
    b.cyl(0.4, 0.4, 0.014, 28, 0, top - 0.047, 0, WOOD_DARK);
    for (let k = 0; k < 4; k++) {
      const ang = Math.PI / 4 + k * Math.PI / 2;
      b.cyl(0.022, 0.016, top - 0.05, 8, Math.cos(ang) * 0.28, (top - 0.05) / 2, Math.sin(ang) * 0.28, WOOD_DARK);   // 다리
    }
    b.cyl(0.3, 0.3, 0.025, 20, 0, 0.18, 0, WOOD_DARK);                                           // 아래 선반
    for (let k = 0; k < 3; k++) b.cyl(0.15, 0.15, 0.008, 24, 0.02 * k, 0.197 + k * 0.009, -0.03, k === 1 ? a : VINYL);   // 음반 더미
    // 상자
    const bz = 0.06;
    b.boxB(0.42, 0.16, 0.42, 0, top, bz, WOOD);
    b.box(0.44, 0.022, 0.44, 0, top + 0.011, bz, M.trimDark);
    b.box(0.43, 0.012, 0.43, 0, top + 0.16, bz, M.trim);
    b.box(0.12, 0.05, 0.01, 0, top + 0.08, bz - 0.215, on ? WARM_GLOW : M.trimDark);             // 앞 명판
    b.cyl(0.17, 0.17, 0.02, 28, -0.03, top + 0.176, 0.02, M.gunmetal);                           // 턴테이블
    b.cyl(0.012, 0.012, 0.12, 8, 0.27, top + 0.09, 0.1, M.trim, 0, 0, ALONG_X);                  // 태엽 손잡이
    b.cyl(0.02, 0.02, 0.05, 8, 0.33, top + 0.12, 0.1, WOOD_DARK);
    // 톤암 · 사운드박스
    b.box(0.022, 0.022, 0.2, 0.08, top + 0.21, 0.13, M.trim, -0.6);
    b.cyl(0.036, 0.036, 0.02, 12, 0.02, top + 0.205, 0.05, M.trim, ALONG_X);
    // 나팔: 상자 뒤 모서리에서 솟는 목 → 앞 위로 벌어지는 종
    const ex = 0.14, ey = top + 0.34, ez = 0.22;
    b.cyl(0.03, 0.03, 0.18, 10, ex, top + 0.25, ez, M.trim);                                     // 목
    b.cyl(0.036, 0.036, 0.05, 10, ex, ey, ez, M.trimDark);                                       // 팔꿈치
    const dx = -0.2, dy = 0.45, dz = -0.87, dl = Math.hypot(dx, dy, dz);
    const ux = dx / dl, uy = dy / dl, uz = dz / dl;
    const { rx, ry } = aim(ux, uy, uz);
    const L = 0.26, ts = [0, 0.07, 0.13, 0.18, 0.22, L];
    const rad = (t: number): number => 0.03 + 0.22 * Math.pow(t / L, 2.2);
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i], t1 = ts[i + 1], tm = (t0 + t1) / 2;
      b.cyl(rad(t1), rad(t0), t1 - t0 + 0.004, 24, ex + ux * tm, ey + uy * tm, ez + uz * tm, M.trim, rx, ry);   // 종 (위 끝이 넓다)
    }
    const mt = L + 0.003;
    b.cyl(0.232, 0.232, 0.004, 28, ex + ux * mt, ey + uy * mt, ez + uz * mt, on ? WARM_GLOW : M.trimDark, rx, ry);   // 나팔 입구
    const tt = L + 0.006;
    b.cyl(0.06, 0.06, 0.004, 16, ex + ux * tt, ey + uy * tt, ez + uz * tt, on ? M.stripAmber : M.hullDark, rx, ry);   // 목구멍
    // 레코드 (켜져 있으면 돈다)
    const rec = rigGroup(model, model.group, 'record', -0.03, top + 0.19, 0.02, (rb) => {
      rb.cyl(0.16, 0.16, 0.006, 28, 0, 0, 0, VINYL);
      rb.cyl(0.05, 0.05, 0.008, 16, 0, 0.001, 0, on ? WARM_GLOW : a);
      rb.box(0.09, 0.002, 0.01, 0.1, 0.004, 0, M.hullLight);                                     // 결 (도는 것이 보이게)
    });
    if (on) { model.spin = rec; model.spinRate = 3.5; }
  },

  /**
   * 주크박스 (`2 × 2 · 1.8`): 버건디 몸체 위에 반원 아치 지붕. 앞면에 아치를 따라 네온관 두 줄 · 옆 네온 기둥 · 크롬 테 ·
   * 음반 창 · 곡명 카드 · 버튼 줄 · 크롬 스피커 그릴. `extra.on` 이면 네온 · 창 · 곡명 카드가 빛난다 (꺼짐 = 같은 색을 어둡게).
   */
  jukebox: (b, _model, _w, _d, _h, a, extra) => {
    const on = extra?.on === true;
    const cabW = 0.9, cabD = 0.62, cz = 0.1, bodyTop = 1.27, R = cabW / 2;
    const fz = cz - cabD / 2;
    b.boxB(cabW + 0.06, 0.08, cabD + 0.06, 0, 0, cz, M.gunmetal);                                // 받침
    b.boxB(cabW, bodyTop - 0.08, cabD, 0, 0.08, cz, JUKE_BODY);                                  // 몸체
    b.add(new THREE.CylinderGeometry(R, R, cabD, 28, 1, false, Math.PI / 2, Math.PI), JUKE_BODY, 0, bodyTop, cz, Math.PI / 2);   // 아치 지붕
    b.add(new THREE.CylinderGeometry(0.34, 0.34, 0.02, 24, 1, false, Math.PI / 2, Math.PI), on ? JUKE_WINDOW_ON : M.glassDark, 0, bodyTop - 0.05, fz - 0.005, Math.PI / 2);   // 돔 창
    const neonA = neon(accentCss(a), on);
    const neonB = neon('#8fe8ff', on);
    b.add(new THREE.TorusGeometry(0.425, 0.022, 8, 32, Math.PI), neonA, 0, bodyTop, fz - 0.022);  // 바깥 네온 아치
    b.add(new THREE.TorusGeometry(0.37, 0.015, 8, 28, Math.PI), neonB, 0, bodyTop, fz - 0.02);    // 안쪽 네온 아치
    for (const sx of [-1, 1]) {
      b.box(0.045, bodyTop - 0.18, 0.045, sx * 0.425, 0.18 + (bodyTop - 0.18) / 2, fz - 0.022, neonA);   // 옆 네온 기둥
      b.box(0.02, bodyTop - 0.18, 0.03, sx * 0.37, 0.18 + (bodyTop - 0.18) / 2, fz - 0.012, CHROME);    // 크롬 테
    }
    b.box(0.6, 0.3, 0.02, 0, 1.0, fz - 0.006, on ? JUKE_WINDOW_ON : M.glassDark);                // 음반 창
    b.cyl(0.12, 0.12, 0.006, 24, 0, 1.0, fz - 0.02, VINYL, ALONG_X);                             // 창 속 음반
    b.cyl(0.035, 0.035, 0.008, 12, 0, 1.0, fz - 0.024, a, ALONG_X);
    b.box(0.56, 0.1, 0.014, 0, 0.8, fz - 0.008, on ? M.stripWhite : M.hullLight);                // 곡명 카드
    for (let k = 0; k < 8; k++) b.box(0.042, 0.026, 0.02, -0.2 + k * 0.057, 0.715, fz - 0.012, CHROME);   // 버튼
    b.box(0.04, 0.06, 0.02, 0.3, 0.64, fz - 0.012, CHROME);                                      // 동전 투입구
    b.box(0.62, 0.36, 0.01, 0, 0.4, fz - 0.006, M.floorGrate);                                   // 스피커 그릴
    for (let k = 0; k < 5; k++) b.box(0.62, 0.012, 0.016, 0, 0.25 + k * 0.075, fz - 0.014, CHROME);
    b.box(cabW, 0.03, 0.02, 0, 0.1, fz - 0.01, CHROME);                                          // 발 크롬
    b.box(0.14, 0.04, 0.1, 0, bodyTop + R + 0.01, cz - 0.16, CHROME);                            // 꼭대기 장식
  },

  /**
   * 턴테이블 (`3 × 2 · 1.0`): 띄워 놓은 슬레이트 캐비닛(원목 상판 · 앞면 홈 · 레코드 칸) 위에 턴테이블 데크 · 앰프 · 스피커.
   * `extra.on` 이면 받침의 LED 띠 · 스트로브 점 · 피치 슬라이더 · 앰프 VU 가 켜지고 플래터가 돈다.
   */
  turntable: (b, model, w, d, _h, a, extra) => {
    const on = extra?.on === true;
    const led = on ? M.stripCyan : M.hullDark;
    b.boxB(w - 0.2, 0.08, d - 0.2, 0, 0, 0, M.floorGrate);                                       // 들어간 받침
    for (const sz of [-1, 1]) b.box(w - 0.18, 0.02, 0.02, 0, 0.07, sz * (d / 2 - 0.1), led);       // LED 띠
    for (const sx of [-1, 1]) b.box(0.02, 0.02, d - 0.18, sx * (w / 2 - 0.1), 0.07, 0, led);
    b.boxB(w, 0.46, d - 0.02, 0, 0.08, 0, SLATE);                                                // 캐비닛
    const top = 0.57;
    b.box(w, 0.03, d - 0.02, 0, top - 0.015, 0, WOOD);                                           // 원목 상판
    const fz = -(d - 0.02) / 2;
    for (const x of [-0.02, 0.36]) b.box(0.014, 0.4, 0.006, x, 0.31, fz - 0.003, M.floorGrate);   // 홈
    b.box(0.46, 0.36, 0.008, -0.45, 0.31, fz - 0.004, M.floorGrate);                             // 레코드 칸
    for (let k = 0; k < 11; k++) b.boxB(0.026, 0.3 - (k % 3) * 0.02, 0.008, -0.65 + k * 0.04, 0.15, fz - 0.01, k % 4 === 0 ? a : VINYL);
    b.box(w - 0.1, 0.014, 0.008, 0, top - 0.04, fz - 0.004, a);                                  // 앞 악센트
    // 데크
    const dx = -0.28, dz = 0.02;
    b.boxB(0.52, 0.07, 0.42, dx, top, dz, M.gunmetal);
    b.box(0.5, 0.008, 0.4, dx, top + 0.074, dz, M.hullDark);
    const px = dx - 0.04, py = top + 0.085;
    b.cyl(0.168, 0.168, 0.015, 32, px, py, dz, CHROME);                                          // 플래터 받침
    b.cyl(0.03, 0.03, 0.03, 12, dx + 0.18, top + 0.09, dz + 0.12, CHROME);                       // 톤암 피벗
    b.box(0.012, 0.012, 0.25, -0.15, top + 0.11, 0.025, CHROME, Math.atan2(-0.4, -0.92));        // 톤암
    b.box(0.03, 0.01, 0.05, -0.2, top + 0.105, -0.09, M.hullDark, Math.atan2(-0.4, -0.92));      // 헤드셸
    b.box(0.012, 0.01, 0.1, dx + 0.22, top + 0.078, dz - 0.1, on ? M.stripCyan : M.hullDark);    // 피치 슬라이더
    b.cyl(0.02, 0.02, 0.01, 12, dx + 0.2, top + 0.079, dz - 0.16, on ? M.stripWhite : M.hullLight);   // 시작 버튼
    // 앰프
    b.boxB(0.3, 0.1, 0.3, 0.15, top, 0.02, M.gunmetal);
    b.box(0.16, 0.03, 0.006, 0.15, top + 0.06, -0.133, on ? M.stripAmber : M.hullDark);           // VU
    for (const kx of [0.06, 0.24]) b.cyl(0.018, 0.018, 0.02, 10, kx, top + 0.04, -0.14, M.trim, ALONG_X);
    // 스피커
    b.boxB(0.28, 0.4, 0.28, 0.55, top, 0.05, M.hullDark);
    b.cyl(0.09, 0.09, 0.012, 20, 0.55, top + 0.13, -0.096, M.floorGrate, ALONG_X);               // 우퍼
    b.cyl(0.05, 0.05, 0.016, 16, 0.55, top + 0.13, -0.098, M.gunmetal, ALONG_X);
    b.cyl(0.03, 0.03, 0.012, 12, 0.55, top + 0.3, -0.096, CHROME, ALONG_X);                      // 트위터
    b.box(0.2, 0.012, 0.004, 0.55, top + 0.37, -0.092, a);
    // 플래터 위 레코드 (켜져 있으면 돈다)
    const rec = rigGroup(model, model.group, 'platter', px, py + 0.011, dz, (rb) => {
      rb.cyl(0.155, 0.155, 0.006, 32, 0, 0, 0, VINYL);
      rb.cyl(0.05, 0.05, 0.008, 16, 0, 0.001, 0, a);
      rb.cyl(0.006, 0.006, 0.03, 6, 0, 0.012, 0, CHROME);                                        // 스핀들
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        rb.box(0.012, 0.004, 0.006, Math.cos(ang) * 0.162, -0.006, Math.sin(ang) * 0.162, on ? M.stripWhite : M.hullDark, -ang);   // 스트로브 점
      }
    });
    if (on) { model.spin = rec; model.spinRate = 3.5; }
  },

  /**
   * 벤치 랙 (`3 × 5 · 1.6`): 머리 쪽(+Z)에 J 훅이 달린 기둥 둘 · 위 가로대 · 바닥 발, 가운데 플랫 벤치, 훅 위에 바벨.
   * 원반은 **세션 중에만** 보인다 (`extra.gymActive` → `rig.plates.visible`). 바벨은 `rig.bar` 그룹이라 운동 중 훅에서 가슴 위
   * (`barPress`)로 옮겨 가 위아래로 움직인다.
   */
  bench_rack: (b, model, _w, _d, _h, a, extra) => {
    // J 훅의 바는 팔을 다 편 높이(BENCH_BAR_HIGH 1.21)보다 조금 낮게 — 들어 올려 앞으로 빼는 동작으로 읽힌다
    const upZ = 0.95, upX = 0.5, hookY = BENCH_BAR_HIGH.y - 0.07, restZ = 0.85;
    b.box(1.14, 0.05, 0.08, 0, 0.025, upZ + 0.05, M.gunmetal);                                   // 바닥 가로대
    for (const sx of [-1, 1]) {
      b.box(0.08, 0.05, 0.56, sx * upX, 0.025, upZ, M.gunmetal);                                 // 발
      for (const sz of [-1, 1]) b.box(0.1, 0.022, 0.08, sx * upX, 0.011, upZ + sz * 0.24, RUBBER);
      b.boxB(0.075, 1.52, 0.075, sx * upX, 0.05, upZ, M.hullLight);                              // 기둥
      for (let k = 0; k < 10; k++) b.box(0.026, 0.012, 0.004, sx * upX, 0.46 + k * 0.09, upZ - 0.0395, M.floorGrate);   // 구멍 줄
      b.box(0.004, 0.9, 0.03, sx * (upX + 0.0395), 0.95, upZ, a);                                // 바깥 악센트
      b.box(0.09, 0.03, 0.09, sx * upX, 1.585, upZ, M.trim);                                     // 기둥 캡
      b.box(0.05, 0.03, 0.15, sx * upX, hookY - 0.033, restZ + 0.03, M.trim);                    // J 훅 바닥
      b.box(0.05, 0.07, 0.02, sx * upX, hookY - 0.012, restZ - 0.05, M.trim);                    // J 훅 턱
    }
    b.box(1.0, 0.05, 0.05, 0, 1.49, upZ, M.gunmetal);                                            // 위 가로대
    flatBench(b, a);
    const { bar, plates } = barbell(model, model.group, hookY, restZ, 0.72, 0.545, a, () => { /* no extra */ }, extra?.gymActive === true);
    model.rig = {
      pose: 'bench',
      anchor: new THREE.Vector3(0, PAD_TOP, BENCH_SHOULDER_Z),
      forward: { x: 0, z: 1 },
      focus: new THREE.Vector3(0, 0.78, 0.3),
      camDist: 2.9, camUp: 0.55,
      bar, plates,
      barRest: { y: hookY, z: restZ },
      barPress: { low: { ...BENCH_BAR_LOW }, high: { ...BENCH_BAR_HIGH } },
    };
  },

  /**
   * 스미스 머신 (`4 × 5 · 2.2`): 기둥 넷 · 위 틀 · 바닥 틀의 케이지 가운데로 크롬 레일 둘이 서고, 바벨이 레일의 슬라이더에
   * 물려 **수직으로만** 움직인다. 레일에 안전 멈춤쇠 · 거치 핀, 아래에 벤치 랙과 같은 플랫 벤치. 원반은 세션 중에만.
   */
  smith_machine: (b, model, _w, _d, _h, a, extra) => {
    // 레일은 수직이라 바의 z 가 고정이다 — player 의 주먹 경로(z 0.57 → 0.66)의 가운데에 세운다 (양 끝에서 ±4.5 cm 어긋난다)
    const railZ = (BENCH_BAR_LOW.z + BENCH_BAR_HIGH.z) / 2, railX = 0.72, restY = BENCH_BAR_HIGH.y - 0.06, topY = 2.16;
    for (const sz of [-1, 1]) b.box(1.9, 0.06, 0.08, 0, 0.03, sz * 1.15, M.gunmetal);          // 바닥 틀
    for (const sx of [-1, 1]) b.box(0.08, 0.06, 2.3, sx * 0.92, 0.03, 0, M.gunmetal);
    for (const pz of [-0.05, 1.05]) {
      for (const sx of [-1, 1]) {
        b.boxB(0.08, topY - 0.06, 0.08, sx * 0.92, 0.06, pz, M.hullLight);                       // 기둥
        if (pz < 0) b.box(0.004, 1.4, 0.03, sx * 0.9605, 1.1, pz, a);                            // 앞 기둥 악센트
      }
      b.box(1.92, 0.08, 0.08, 0, topY, pz, M.hullLight);                                         // 위 틀 (가로)
    }
    for (const sx of [-1, 1]) {
      b.box(0.08, 0.08, 1.18, sx * 0.92, topY, 0.5, M.hullLight);                                // 위 틀 (세로)
      b.cyl(0.02, 0.02, 2.0, 10, sx * railX, 1.1, railZ, CHROME);                                // 레일
      b.box(0.12, 0.05, 0.12, sx * railX, 0.085, railZ, M.gunmetal);                             // 레일 발
      b.box(0.2, 0.05, 0.06, sx * 0.82, 0.085, railZ, M.gunmetal);
      b.box(0.2, 0.05, 0.05, sx * 0.82, 2.1, railZ, M.gunmetal);                                 // 레일 위 팔
      b.box(0.08, 0.04, 0.12, sx * railX, BENCH_BAR_LOW.y - 0.1, railZ, M.trim);                 // 안전 멈춤쇠 (가슴 높이 바로 아래)
      b.box(0.05, 0.03, 0.1, sx * railX, restY - 0.075, railZ + 0.07, M.trim);                   // 거치 핀
    }
    b.box(1.6, 0.06, 0.06, 0, 2.1, railZ, M.gunmetal);                                           // 레일 위 가로대
    b.box(0.5, 0.06, 0.012, 0, topY, -0.096, a);                                                 // 앞 명판
    flatBench(b, a);
    const { bar, plates } = barbell(model, model.group, restY, railZ, 0.9, 0.78, a, (bb) => {
      for (const sx of [-1, 1]) {
        bb.box(0.08, 0.12, 0.08, sx * railX, 0, 0, M.hullLight);                                 // 슬라이더
        bb.box(0.03, 0.03, 0.08, sx * railX, -0.03, 0.07, M.trim);                               // 거치 갈고리
      }
    }, extra?.gymActive === true);
    model.rig = {
      pose: 'bench',
      anchor: new THREE.Vector3(0, PAD_TOP, BENCH_SHOULDER_Z),
      forward: { x: 0, z: 1 },
      focus: new THREE.Vector3(0, 0.9, 0.3),
      camDist: 3.2, camUp: 0.6,
      bar, plates,
      barRest: { y: restY, z: railZ },
      barPress: { low: { y: BENCH_BAR_LOW.y, z: railZ }, high: { y: BENCH_BAR_HIGH.y, z: railZ } },
    };
  },

  /**
   * 트레드밀 (`2 × 4 · 1.4`): 앞(−Z)에 모터 덮개 · 앞으로 기운 기둥 둘 · 러너 쪽으로 기운 콘솔(화면) · 손잡이, 뒤로 긴 데크 위에
   * 러닝 벨트 · 발판 레일 · 롤러. 벨트 줄무늬는 `rig.belt` 그룹이라 달리는 동안 뒤(+Z)로 흐른다.
   */
  treadmill: (b, model, _w, _d, _h, a) => {
    b.boxB(0.84, 0.14, 1.7, 0, 0.02, 0.1, M.hullDark);                                           // 데크
    for (const sx of [-1, 1]) for (const sz of [-0.7, 0.9]) b.box(0.08, 0.022, 0.1, sx * 0.36, 0.011, sz, RUBBER);
    b.boxB(0.9, 0.2, 0.36, 0, 0, -0.78, M.hullLight);                                            // 모터 덮개
    b.box(0.8, 0.02, 0.01, 0, 0.13, -0.965, a);
    b.box(0.6, 0.006, 0.2, 0, 0.203, -0.78, M.floorGrate);
    for (const sx of [-1, 1]) {
      b.box(0.12, 0.05, 1.45, sx * 0.39, 0.185, 0.2, M.hullLight);                               // 발판 레일
      b.box(0.008, 0.016, 1.4, sx * 0.4535, 0.18, 0.2, a);
    }
    const beltTop = 0.19, zMin = -0.52, spacing = 0.18, n = 8;
    b.box(0.62, 0.02, n * spacing + 0.02, 0, beltTop - 0.01, zMin + n * spacing / 2, BELT);      // 벨트
    b.cyl(0.042, 0.042, 0.64, 12, 0, 0.15, zMin - 0.02, CHROME, 0, 0, ALONG_X);                  // 앞 롤러
    b.box(0.9, 0.09, 0.07, 0, 0.12, 0.965, M.hullLight);                                         // 뒤 캡
    // 기둥 · 콘솔 · 손잡이
    for (const sx of [-1, 1]) b.box(0.07, 1.12, 0.07, sx * 0.4, 0.76, -0.8, M.hullLight, 0, -0.12);
    const ct = 0.6;
    b.box(0.8, 0.08, 0.34, 0, 1.28, -0.83, M.hullDark, 0, ct);                                   // 콘솔
    b.box(0.46, 0.004, 0.2, 0, 1.28 + 0.042 * Math.cos(ct), -0.83 + 0.042 * Math.sin(ct), M.screen, 0, ct);   // 화면
    b.box(0.76, 0.02, 0.012, 0, 1.28 + 0.17 * Math.sin(ct), -0.83 - 0.17 * Math.cos(ct), a, 0, ct);          // 콘솔 앞 악센트
    b.box(0.03, 0.03, 0.012, 0.26, 1.22, -0.7, M.stripRed);                                      // 안전 키
    for (const sx of [-1, 1]) {
      b.box(0.04, 0.04, 0.56, sx * 0.42, 1.08, -0.5, CHROME);                                    // 손잡이
      b.box(0.05, 0.05, 0.2, sx * 0.42, 1.08, -0.34, RUBBER);
      b.box(0.04, 0.12, 0.04, sx * 0.42, 1.02, -0.22, CHROME);
    }
    const belt = rigGroup(model, model.group, 'belt', 0, beltTop + 0.0015, 0, (rb) => {
      for (let k = 0; k < n; k++) rb.box(0.6, 0.003, 0.035, 0, 0, zMin + k * spacing, BELT_STRIPE);
    });
    model.rig = {
      pose: 'run',
      anchor: new THREE.Vector3(0, beltTop, zMin + n * spacing / 2),                              // 벨트 윗면 가운데 (발이 anchor 에 선다)
      forward: { x: 0, z: -1 },
      focus: new THREE.Vector3(0, 0.85, 0.0),
      camDist: 2.7, camUp: 0.4,
      belt, beltSpacing: spacing,
    };
  },

  /**
   * 사이클 (`2 × 3 · 1.2`): 앞뒤 발 · 낮은 보 · 안장 기둥 · 뒤 사선 · 앞 포크(플라이휠을 사이에 둔 판 둘) · 반원 덮개 · 저항 손잡이 ·
   * 핸들 · 콘솔 · 체인 덮개 · 안장. 크랭크(`rig.crank`, 페달은 수평을 지키는 자식 그룹)와 플라이휠(`rig.flywheel`)이 X 축으로 돈다.
   */
  exercise_bike: (b, model, _w, _d, _h, a) => {
    for (const sz of [-0.62, 0.6]) {
      b.box(0.62, 0.05, 0.08, 0, 0.025, sz, M.hullLight);                                        // 앞 · 뒤 발
      for (const sx of [-1, 1]) b.box(0.08, 0.03, 0.09, sx * 0.3, 0.015, sz, RUBBER);
    }
    b.box(0.08, 0.06, 1.1, 0, 0.08, -0.02, M.hullDark);                                          // 낮은 보
    // player FURN_CYCLE (안장 윗면 기준, 앞 = −Z): 크랭크 축 (0, −0.60, 앞 0.25) · 반지름 0.16 · 페달 x ±0.13 · 손잡이 (±0.22, +0.14, 앞 0.50)
    const seatTop = 0.93, seatZ = 0.3;
    const crankY = seatTop - 0.6, crankZ = seatZ - 0.25;
    const gripY = seatTop + 0.14, gripZ = seatZ - 0.5;
    b.box(0.075, 0.62, 0.07, 0, (crankY + seatTop - 0.07) / 2, (crankZ + seatZ) / 2, M.hullLight, 0, Math.atan2(seatZ - crankZ, seatTop - 0.07 - crankY));   // 안장 기둥
    b.box(0.07, 0.62, 0.07, 0, (0.05 + crankY) / 2, (0.6 + crankZ) / 2, M.hullLight, 0, Math.atan2(crankZ - 0.6, crankY - 0.05));   // 뒤 사선
    // 앞 포크: 앞 발(z −0.6)에서 핸들 기둥 꼭대기(y 1.02, z −0.38)까지, 플라이휠을 사이에 둔 판 둘
    const forkLen = Math.hypot(1.02 - 0.05, -0.38 + 0.6), forkT = Math.atan2(-0.38 + 0.6, 1.02 - 0.05);
    for (const sx of [-1, 1]) b.box(0.03, forkLen, 0.07, sx * 0.065, (0.05 + 1.02) / 2, (-0.6 - 0.38) / 2, M.hullDark, 0, forkT);
    b.cyl(0.07, 0.07, 0.12, 16, 0, crankY, crankZ, M.hullDark, 0, 0, ALONG_X);                   // 크랭크 하우징
    const fwY = 0.36, fwZ = -0.6 + (0.36 - 0.05) * Math.tan(forkT);
    b.box(0.02, 0.12, crankZ - fwZ, 0.05, (crankY + fwY) / 2, (crankZ + fwZ) / 2, M.hullLight);  // 체인 덮개 (크랭크 팔 안쪽)
    b.box(0.004, 0.02, crankZ - fwZ - 0.06, 0.0615, (crankY + fwY) / 2, (crankZ + fwZ) / 2, a);
    b.add(new THREE.CylinderGeometry(0.235, 0.235, 0.09, 20, 1, true, 0, Math.PI), M.hullLight, 0, fwY, fwZ, 0, 0, Math.PI / 2);   // 플라이휠 덮개 (위 반원)
    b.cyl(0.03, 0.03, 0.06, 10, 0, 0.63, fwZ + 0.06, M.stripRed);                                // 저항 손잡이
    // 핸들 (기둥 꼭대기에서 라이더 쪽으로 뻗은 뿔 둘 — 고무 손잡이가 player 의 손 자리) · 콘솔
    b.box(0.5, 0.036, 0.036, 0, 1.02, -0.38, M.gunmetal);
    for (const sx of [-1, 1]) {
      b.box(0.036, 0.036, 0.26, sx * 0.22, gripY - 0.02, -0.38 + 0.13, M.gunmetal, 0, Math.atan2(-(gripY - 1.02), 0.26));
      b.box(0.046, 0.046, 0.12, sx * 0.22, gripY, gripZ, RUBBER);
    }
    b.box(0.18, 0.11, 0.03, 0, 1.12, -0.42, M.hullDark, 0, 0.5);
    b.box(0.14, 0.07, 0.004, 0, 1.12 + 0.016 * Math.sin(0.5), -0.42 - 0.016 * Math.cos(0.5), M.screen, 0, 0.5);
    // 안장
    b.box(0.05, 0.05, 0.1, 0, seatTop - 0.07, seatZ, M.gunmetal);
    b.box(0.16, 0.06, 0.26, 0, seatTop - 0.03, seatZ, BENCH_PAD);
    b.box(0.08, 0.05, 0.14, 0, seatTop - 0.035, seatZ - 0.18, BENCH_PAD);
    b.box(0.164, 0.012, 0.24, 0, seatTop - 0.045, seatZ, a);
    // 움직이는 부분
    const flywheel = rigGroup(model, model.group, 'flywheel', 0, fwY, fwZ, (rb) => {
      rb.cyl(0.2, 0.2, 0.05, 28, 0, 0, 0, CHROME, 0, 0, ALONG_X);
      rb.cyl(0.14, 0.14, 0.054, 24, 0, 0, 0, M.gunmetal, 0, 0, ALONG_X);
      rb.box(0.058, 0.26, 0.02, 0, 0, 0, a);                                                     // 도는 것이 보이는 표식
      rb.cyl(0.03, 0.03, 0.07, 10, 0, 0, 0, M.trim, 0, 0, ALONG_X);
    });
    const crankR = 0.16, pedalX = 0.13;
    const pedals: THREE.Group[] = [];
    const crank = rigGroup(model, model.group, 'crank', 0, crankY, crankZ, (rb) => {
      rb.cyl(0.015, 0.015, 0.2, 8, 0, 0, 0, CHROME, 0, 0, ALONG_X);                              // 축
      rb.box(0.022, crankR + 0.03, 0.035, -0.085, crankR / 2, 0, M.gunmetal);                    // 왼 크랭크 (위)
      rb.box(0.022, crankR + 0.03, 0.035, 0.085, -crankR / 2, 0, M.gunmetal);                    // 오른 크랭크 (아래)
      rb.cyl(0.06, 0.06, 0.01, 16, 0.07, 0, 0, M.trim, 0, 0, ALONG_X);                           // 체인링
    });
    for (const sx of [-1, 1]) {
      pedals.push(rigGroup(model, crank, sx < 0 ? 'pedal-l' : 'pedal-r', sx * pedalX, -sx * crankR, 0, (rb) => {
        rb.box(0.1, 0.025, 0.12, 0, 0, 0, RUBBER);
        rb.box(0.1, 0.03, 0.02, 0, 0.018, -0.05, a);                                             // 발 끈
      }));
    }
    model.rig = {
      pose: 'cycle',
      anchor: new THREE.Vector3(0, seatTop, seatZ),
      forward: { x: 0, z: -1 },
      focus: new THREE.Vector3(0, 0.7, -0.1),
      camDist: 2.4, camUp: 0.4,
      crank, pedals, flywheel,
    };
  },
};
