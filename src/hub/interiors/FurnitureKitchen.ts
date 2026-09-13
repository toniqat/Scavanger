import * as THREE from 'three';
import type { CookGame, CookLiquid } from '@/shared';
import { COOK_LIQUIDS, COOK_LIQUID_COLOR } from '@/shared';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BuildExtra, Builder, FurnitureModel } from './Furniture';

/* ────────────────────────────────────────────────────────────────────────────
 * 주방 가구 (2026-09-13, 요리 미니게임 — docs/plans/cooking-minigames.md §6-4).
 *
 *   • 자동 조리 가구 4종의 절차 모델 `KITCHEN_APPLIANCE_BUILDERS` — 푸드 프로세서 · 자동 그릴 · 자동 교반기 · 계량 디스펜서.
 *     `Furniture.ts` 의 `BUILDERS` 에 그대로 펼쳐 넣는다 (같은 `Builder` 모양 · 가운데 · 바닥 y 0 · 앞 −Z · `GeoBatch`).
 *     네 대 모두 같은 높이의 주방 캐비닛(`counter`) 위에 서고, 캐비닛 앞면 오른쪽의 표시등 3개 중 `level` 개가 켜진다.
 *   • 조리대(`bench_cook`)의 **도구 rig** `cookBenchTools` — 도마(+칼) · 냄비(+국자) · 웍 · 그릴 팬 · 계량 비커(+액체)가 각자
 *     하위 그룹이라 조리 중에 지금 단계 게임의 도구가 **작업 자리**(오른손 앞)로 나오고 칼 · 국자 · 웍이 손 동작 위상을 따라 움직인다
 *     (`CookStaging` 이 매 프레임 쓴다). 몸체(후드 · 화구 · 재료 상자 · 조미료 병)는 `Furniture.ts` 의 `bench_cook` 빌더에 그대로 있다.
 *
 * **광원은 하나도 만들지 않는다** — 열선 · 화구 링 · 표시등 · 액체는 emissive 재질뿐이다 (CLAUDE.md 「씬의 광원 개수를 플레이 중에
 * 바꾸지 않는다」 · `smoke-lights`). 재질은 전부 공용이고 버리지 않는다. 투명 유리(`CLEAR_GLASS`)와 비커 액체는 조리대가 **평소에도**
 * 들고 있어서 함선 진입 때의 셰이더 선컴파일에 이미 들어간다 (조리 중에 처음 보이는 프로그램이 없다).
 * ──────────────────────────────────────────────────────────────────────────── */

function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}
/** 푸드 프로세서 볼 · 탱크 · 비커의 맑은 유리. */
const CLEAR_GLASS = new THREE.MeshStandardMaterial({ color: 0xd4ecf6, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.3, depthWrite: false });
/** 냄비 · 교반기 냄비의 국물 (따뜻한 발광). */
const SOUP = std(0xc97a3c, 0.45, 0.05, 0x7a3208, 0.4);
/** 웍 안의 볶는 재료. */
const FOOD = std(0x9c6a3a, 0.7, 0.05, 0x4a2208, 0.22);

const liquidCache = new Map<string, THREE.MeshStandardMaterial>();
/** 붓기 액체의 재질 (`COOK_LIQUID_COLOR`, 약한 발광). 색마다 하나를 영원히 캐시한다 — 디스펜서 탱크와 조리대 비커가 같이 쓴다. */
export function liquidMat(liquid: CookLiquid): THREE.MeshStandardMaterial {
  const css = COOK_LIQUID_COLOR[liquid];
  let m = liquidCache.get(css);
  if (!m) {
    const c = new THREE.Color(css).getHex();
    m = std(c, 0.22, 0.05, c, 0.4);
    liquidCache.set(css, m);
  }
  return m;
}

const TAU = Math.PI * 2;
const ALONG_X = Math.PI / 2;
const frac = (x: number): number => x - Math.floor(x);

/* ── 자동 조리 가구 4종 ───────────────────────────────────────────────────── */

export type KitchenApplianceKind = 'food_processor' | 'auto_grill' | 'auto_stirrer' | 'pour_dispenser';

/** 네 가구가 서는 주방 캐비닛 윗면 높이 (m). */
const COUNTER_TOP = 0.72;

/** 주방 캐비닛: 걸레받이 · 몸체 · 상판 · 앞면 악센트 · 문 두 짝 · **레벨 표시등 3개**(`level` 개가 켜진다). */
function counter(b: GeoBatch, w: number, d: number, T: number, a: THREE.Material, lv: number): void {
  b.boxB(w - 0.1, 0.08, d - 0.14, 0, 0, 0.03, M.hullDark);                                       // 걸레받이
  b.boxB(w - 0.06, T - 0.14, d - 0.08, 0, 0.08, 0.01, M.hullLight);                              // 캐비닛
  b.box(w - 0.02, 0.06, d - 0.02, 0, T - 0.03, 0, M.gunmetal);                                   // 상판
  const fz = -(d / 2 - 0.04);                                                                    // 앞면 (몸체보다 2 cm 나온다)
  b.box(w - 0.2, 0.035, 0.02, 0, T - 0.12, fz, a);                                               // 앞면 악센트
  b.box(0.015, T - 0.4, 0.02, 0, 0.08 + (T - 0.4) / 2 + 0.06, fz, M.hullDark);                   // 문 사이 틈
  for (const sx of [-1, 1]) b.box(0.02, 0.14, 0.025, sx * 0.06, T - 0.3, fz - 0.01, M.trim);      // 손잡이
  for (let k = 0; k < 3; k++) b.box(0.045, 0.028, 0.02, w / 2 - 0.24 + k * 0.065, T - 0.2, fz - 0.005, k < lv ? M.stripWhite : M.hullDark);
}

export const KITCHEN_APPLIANCE_BUILDERS: Readonly<Record<KitchenApplianceKind, Builder>> = {
  /**
   * 푸드 프로세서 (`2 × 2 · 1.2`, 썰기 · 다지기): 캐비닛 위 모터 받침(속도 표시창 · 다이얼 · 상태등) → 맞물림 링 → **맑은 유리 볼**
   * (안에 S자 칼날 둘 · 축 · 청록 허브 · 다진 조각) → 뚜껑 · 투입구 · 누름대, 볼 옆 손잡이. 오른쪽에 여분 칼날 원판 거치대.
   */
  food_processor: (b, w, d, _h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const x0 = -w * 0.08, z0 = d * 0.02;
    b.boxB(0.36, 0.16, 0.32, x0, T, z0, M.hullLight);                                            // 모터 받침
    b.box(0.37, 0.025, 0.33, x0, T + 0.16, z0, M.gunmetal);                                      // 받침 윗판
    b.box(0.18, 0.06, 0.012, x0 - 0.05, T + 0.09, z0 - 0.166, M.screen);                         // 속도 표시창
    b.cyl(0.035, 0.035, 0.02, 14, x0 + 0.11, T + 0.09, z0 - 0.172, a, ALONG_X);                  // 다이얼
    b.box(0.03, 0.014, 0.01, x0 - 0.05, T + 0.035, z0 - 0.165, M.stripCyan);                     // 상태등
    b.cyl(0.13, 0.14, 0.03, 20, x0, T + 0.175, z0, M.gunmetal);                                  // 맞물림 링
    const by = T + 0.19, bh = 0.2;
    b.cyl(0.155, 0.135, bh, 24, x0, by + bh / 2, z0, CLEAR_GLASS, 0, 0, 0, true);                // 유리 볼
    b.cyl(0.135, 0.135, 0.01, 20, x0, by + 0.005, z0, CLEAR_GLASS);                              // 볼 바닥
    b.cyl(0.013, 0.013, 0.15, 8, x0, by + 0.075, z0, M.trim);                                    // 칼날 축
    b.box(0.22, 0.008, 0.034, x0, by + 0.045, z0, M.hullLight, 0.5);                             // S자 칼날 (아래)
    b.box(0.2, 0.008, 0.034, x0, by + 0.085, z0, M.hullLight, -0.9);                             // S자 칼날 (위)
    b.cyl(0.024, 0.024, 0.03, 10, x0, by + 0.065, z0, M.stripCyan);                              // 칼날 허브 (돌고 있다)
    for (let k = 0; k < 6; k++) {
      b.box(0.034, 0.028, 0.034, x0 + Math.cos(k * 1.1) * 0.075, by + 0.024, z0 + Math.sin(k * 1.7) * 0.065, k % 2 ? M.crate : a, k * 0.7);   // 다진 조각
    }
    b.cyl(0.165, 0.165, 0.024, 24, x0, by + bh + 0.012, z0, M.hullDark);                         // 뚜껑
    b.cyl(0.05, 0.05, 0.09, 14, x0 + 0.07, by + bh + 0.066, z0 - 0.03, M.hullLight, 0, 0, 0, true);   // 투입구
    b.cyl(0.042, 0.042, 0.04, 12, x0 + 0.07, by + bh + 0.125, z0 - 0.03, a);                     // 누름대
    b.box(0.034, 0.17, 0.05, x0 + 0.2, by + bh * 0.55, z0, M.hullDark);                          // 손잡이
    for (const t of [0.2, 0.9]) b.box(0.05, 0.028, 0.04, x0 + 0.175, by + bh * t, z0, M.hullDark);
    // 여분 칼날 원판 거치대 (오른쪽)
    b.boxB(0.1, 0.22, 0.26, w * 0.33, T, d * 0.14, M.hullDark);
    for (let k = 0; k < 2; k++) {
      b.cyl(0.08, 0.08, 0.012, 18, w * 0.33, T + 0.17, d * 0.14 - 0.06 + k * 0.12, M.hullLight, 0, 0, ALONG_X);
      b.cyl(0.02, 0.02, 0.016, 10, w * 0.33, T + 0.17, d * 0.14 - 0.06 + k * 0.12, a, 0, 0, ALONG_X);
    }
  },

  /**
   * 자동 그릴 (`3 × 2 · 1.0`, 굽기 · 볶기): 캐비닛 위 화실. 왼쪽 **그릴 구역**은 앞뒤로 달리는 쇠살 사이로 달아오른 열선(emissive)이
   * 비치고 패티 두 장이 올라 있다. 오른쪽은 그릴 자국이 난 **철판**(채소 조각). 그릴 구역 위로 뒤쪽 경첩에서 열린 **후드**(뚜껑),
   * 화실 앞면에 표시창 · 다이얼 둘, 오른쪽 끝에 뒤집개 · 집게가 걸린 걸이.
   */
  auto_grill: (b, w, d, _h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const bx = -w * 0.06, bw = w * 0.8, bd = d * 0.72, bz = 0.02;
    b.boxB(bw, 0.1, bd, bx, T, bz, M.hullDark);                                                  // 화실
    b.box(bw + 0.02, 0.02, bd + 0.02, bx, T + 0.1, bz, M.trim);                                  // 테두리
    const gx = bx - bw * 0.2, gw = bw * 0.56;                                                    // 그릴 구역 (왼쪽)
    const px = bx + bw * 0.3, pw = bw * 0.36;                                                    // 철판 구역 (오른쪽)
    for (const oz of [-0.2, 0, 0.2]) b.cyl(0.012, 0.012, gw - 0.08, 8, gx, T + 0.07, bz + oz, M.stripRed, 0, 0, ALONG_X);   // 열선 (emissive only)
    const bars = 7;
    for (let k = 0; k < bars; k++) b.box(0.028, 0.022, bd - 0.08, gx - gw / 2 + 0.06 + k * (gw - 0.12) / (bars - 1), T + 0.115, bz, M.gunmetal);   // 그릴 쇠살
    for (let k = 0; k < 2; k++) {
      const cx = gx - 0.15 + k * 0.3;
      b.cyl(0.06, 0.06, 0.025, 14, cx, T + 0.139, bz, M.padding);                                // 패티
      for (let s = 0; s < 2; s++) b.box(0.09, 0.003, 0.012, cx, T + 0.153, bz - 0.02 + s * 0.04, M.trimDark);   // 구운 자국
    }
    b.box(pw, 0.03, bd - 0.06, px, T + 0.115, bz, M.gunmetal);                                   // 철판
    for (let k = 0; k < 4; k++) b.box(pw - 0.06, 0.004, 0.018, px, T + 0.132, bz - 0.18 + k * 0.12, M.trimDark);   // 그릴 자국
    b.box(pw, 0.02, 0.035, px, T + 0.12, bz - (bd / 2 - 0.05), M.trimDark);                      // 기름 홈
    for (let k = 0; k < 3; k++) b.cyl(0.035, 0.035, 0.012, 10, px - 0.1 + k * 0.1, T + 0.136, bz + 0.08, k === 1 ? a : M.crate);   // 채소 조각
    // 후드: 뒤쪽 경첩(py, pz)에서 위 · 뒤로 열린 뚜껑 (로컬 +Z 가 (0, 0.8, 0.6) 을 향하게 rx −0.93)
    const py = T + 0.13, pz = 0.34, L = 0.26;
    b.box(gw + 0.02, 0.03, L, gx, py + 0.8 * L / 2, pz + 0.6 * L / 2, M.hullLight, 0, -0.93);
    b.box(gw - 0.06, 0.012, L - 0.05, gx, py + 0.8 * L / 2 + 0.012, pz + 0.6 * L / 2 - 0.016, M.hullDark, 0, -0.93);   // 안쪽 열 차폐판
    b.cyl(0.014, 0.014, gw - 0.12, 8, gx, py + 0.8 * L, pz + 0.6 * L - 0.01, M.gunmetal, 0, 0, ALONG_X);   // 후드 손잡이
    for (const sx of [-1, 1]) b.cyl(0.025, 0.025, 0.06, 10, gx + sx * gw * 0.4, py, pz, M.gunmetal, 0, 0, ALONG_X);   // 경첩
    // 화실 앞면: 표시창 · 다이얼 둘
    const fz = bz - bd / 2;
    b.box(0.2, 0.05, 0.012, px, T + 0.05, fz - 0.007, M.screen);
    for (let k = 0; k < 2; k++) {
      const kx = gx - 0.15 + k * 0.3;
      b.cyl(0.028, 0.028, 0.025, 12, kx, T + 0.05, fz - 0.012, M.hullLight, ALONG_X);
      b.box(0.008, 0.02, 0.005, kx, T + 0.065, fz - 0.026, M.stripAmber);
    }
    // 오른쪽 끝: 뒤집개 · 집게 걸이
    const rx = w / 2 - 0.1;
    b.boxB(0.04, 0.34, 0.04, rx, T, 0.3, M.gunmetal);
    b.box(0.04, 0.03, 0.42, rx, T + 0.32, 0.1, M.gunmetal);
    b.box(0.012, 0.18, 0.02, rx, T + 0.21, -0.02, M.hullLight);                                  // 뒤집개 자루
    b.box(0.01, 0.06, 0.08, rx, T + 0.09, -0.02, M.hullLight);                                   // 뒤집개 날
    for (const oz of [-0.012, 0.012]) b.box(0.01, 0.22, 0.012, rx, T + 0.19, 0.16 + oz, M.hullLight, 0, oz * 3);   // 집게
  },

  /**
   * 자동 교반기 (`2 × 2 · 1.3`, 젓기): 캐비닛 위 인덕션 판(달아오른 링) 위의 큰 냄비(국물 · 손잡이 둘). 뒤 오른쪽 **스탠드** 기둥에서
   * 뻗은 **팔** 끝의 모터 머리(청록 띠)가 축을 냄비 속으로 내리고, 축 끝에 십자 **날개**가 달려 있다. 앞 오른쪽에 재료 병.
   */
  auto_stirrer: (b, w, d, _h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const px = -w * 0.1, pz = -d * 0.06;
    b.boxB(0.5, 0.03, 0.5, px, T, pz, M.hullDark);                                               // 인덕션 판
    b.add(new THREE.TorusGeometry(0.2, 0.012, 6, 32), M.stripRed, px, T + 0.035, pz, ALONG_X);   // 달아오른 링 (emissive only)
    b.cyl(0.2, 0.18, 0.28, 24, px, T + 0.03 + 0.14, pz, M.gunmetal, 0, 0, 0, true);              // 냄비
    b.cyl(0.18, 0.18, 0.01, 20, px, T + 0.04, pz, M.gunmetal);                                   // 냄비 바닥
    b.cyl(0.192, 0.192, 0.012, 24, px, T + 0.25, pz, SOUP);                                      // 국물
    b.add(new THREE.TorusGeometry(0.2, 0.01, 6, 32), M.hullLight, px, T + 0.31, pz, ALONG_X);    // 테
    for (const sx of [-1, 1]) b.box(0.06, 0.025, 0.08, px + sx * 0.235, T + 0.26, pz, M.hullDark);   // 손잡이
    // 스탠드 · 팔 · 모터 머리 · 축 · 날개
    const sx0 = w * 0.3, sz0 = d * 0.3, AY = T + 0.56;
    b.boxB(0.24, 0.05, 0.24, sx0, T, sz0, M.hullDark);
    b.cyl(0.032, 0.036, 0.56, 12, sx0, T + 0.05 + 0.28, sz0, M.hullLight);
    b.cyl(0.05, 0.05, 0.05, 12, sx0, AY - 0.06, sz0, a);                                         // 높이 조절 칼라
    b.box(0.12, 0.08, 0.02, sx0, T + 0.3, sz0 - 0.045, M.screen);                                // 기둥의 조작 화면
    const dx = px - sx0, dz = pz - sz0, len = Math.hypot(dx, dz);
    b.box(0.06, 0.06, len + 0.06, (sx0 + px) / 2, AY, (sz0 + pz) / 2, M.hullLight, Math.atan2(dx, dz));   // 팔
    b.cyl(0.065, 0.065, 0.14, 16, px, AY - 0.02, pz, M.hullDark);                                // 모터 머리
    b.cyl(0.067, 0.067, 0.02, 16, px, AY - 0.05, pz, M.stripCyan);                               // 동작 띠 (emissive)
    b.cyl(0.05, 0.05, 0.02, 14, px, AY + 0.06, pz, M.hullLight);
    const shaftTop = AY - 0.09, shaftBot = T + 0.08;
    b.cyl(0.012, 0.012, shaftTop - shaftBot, 8, px, (shaftTop + shaftBot) / 2, pz, M.trim);      // 축
    for (const r of [0.4, 0.4 + Math.PI / 2]) b.box(0.26, 0.07, 0.012, px, T + 0.12, pz, M.hullLight, r);   // 날개
    b.cyl(0.06, 0.06, 0.14, 12, w * 0.32, T + 0.07, -d * 0.28, M.glassDark);                     // 재료 병
    b.cyl(0.062, 0.062, 0.02, 12, w * 0.32, T + 0.15, -d * 0.28, a);
  },

  /**
   * 계량 디스펜서 (`2 × 2 · 1.6`, 붓기): 캐비닛 뒤로 선 벽판에 **액체 탱크 4개**(`COOK_LIQUIDS` 순서 — 물 · 기름 · 우유 · 달걀물,
   * 색 = `COOK_LIQUID_COLOR`)가 걸려 있다 — 맑은 유리 관 속 액체 · 위아래 캡 · 브래킷 · 색 띠. 탱크 밑 밸브가 가로 매니폴드로 모여
   * 가운데 **노즐**로 내려오고, 노즐 밑 받침판 위에 **눈금 비커**가 있다. 벽판 왼쪽에 조작 화면과 액체색 버튼 넷.
   */
  pour_dispenser: (b, w, d, h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const panelZ = d / 2 - 0.06, panelFront = panelZ - 0.035;
    b.boxB(w - 0.06, h - T, 0.07, 0, T, panelZ, M.hullDark);                                     // 벽판
    b.box(w - 0.02, 0.05, 0.14, 0, h - 0.025, d / 2 - 0.08, M.hullLight);                        // 윗 캡
    b.box(w - 0.2, 0.025, 0.02, 0, h - 0.07, panelFront - 0.01, a);                              // 악센트
    const TB = T + 0.4, TH = 0.34, r = 0.08, tz = d / 2 - 0.19;
    const fills = [0.78, 0.55, 0.66, 0.42];
    const spacing = (w - 0.2) / COOK_LIQUIDS.length;
    COOK_LIQUIDS.forEach((liq, i) => {
      const x = -(w - 0.2) / 2 + (i + 0.5) * spacing;
      const f = fills[i % fills.length];
      const mat = liquidMat(liq);
      b.cyl(r, r, TH, 18, x, TB + TH / 2, tz, CLEAR_GLASS, 0, 0, 0, true);                       // 유리 탱크
      b.cyl(r - 0.012, r - 0.012, TH * f, 16, x, TB + TH * f / 2, tz, mat);                      // 액체
      b.cyl(r + 0.008, r + 0.008, 0.03, 18, x, TB - 0.015, tz, M.hullLight);                     // 아래 캡
      b.cyl(r + 0.008, r + 0.008, 0.03, 18, x, TB + TH + 0.015, tz, M.hullLight);                // 위 캡
      b.box(0.08, 0.018, 0.01, x, TB + TH + 0.015, tz - r - 0.012, mat);                         // 색 띠
      b.box(0.04, 0.05, 0.1, x, TB + TH * 0.7, tz + r + 0.02, M.gunmetal);                       // 브래킷
      b.cyl(0.014, 0.014, 0.07, 8, x, TB - 0.065, tz, M.trim);                                   // 밸브
      b.box(0.035, 0.035, 0.015, -0.33 + i * 0.055, T + 0.09, panelFront - 0.008, mat);          // 액체 버튼
    });
    b.box(w - 0.28, 0.04, 0.05, 0, TB - 0.11, tz, M.gunmetal);                                   // 매니폴드
    b.box(0.04, 0.04, 0.2, 0, TB - 0.11, tz - 0.1, M.gunmetal);                                  // 노즐 관
    const nz = tz - 0.19;
    b.cyl(0.035, 0.02, 0.08, 12, 0, TB - 0.16, nz, M.hullLight);                                 // 노즐
    b.cyl(0.012, 0.012, 0.02, 8, 0, TB - 0.21, nz, M.stripCyan);                                 // 노즐 끝 (emissive)
    b.box(0.22, 0.13, 0.012, -0.25, T + 0.22, panelFront - 0.006, M.screen);                     // 조작 화면
    // 받침판 + 눈금 비커
    b.boxB(0.3, 0.02, 0.26, 0, T, nz - 0.02, M.floorGrate);
    const bY = T + 0.02, bH = 0.15;
    b.cyl(0.07, 0.065, bH, 18, 0, bY + bH / 2, nz, CLEAR_GLASS, 0, 0, 0, true);
    b.cyl(0.065, 0.065, 0.006, 16, 0, bY + 0.003, nz, CLEAR_GLASS);
    b.cyl(0.06, 0.06, 0.06, 16, 0, bY + 0.036, nz, liquidMat('water'));
    for (let k = 0; k < 5; k++) b.box(k % 2 ? 0.02 : 0.035, 0.004, 0.004, -0.02, bY + 0.025 + k * 0.025, nz - 0.071, M.stripWhite);   // 눈금
  },
};

/* ── 조리대 도구 rig ─────────────────────────────────────────────────────── */

/**
 * player `SoldierModel.FURN_COOK` 의 거울 (2026-09-13) — **원본은 player 다** (CLAUDE.md 「가구 자세는 player 가 몸을, hub 가 자리를
 * 갖는다」, 헬스장 `FURN_*` 과 같은 규약이라 값을 옮겨 적는다 — 다른 기능 폴더를 import 하지 않는다). player 쪽이 바뀌면 여기도 고친다.
 *   `COOK_EDGE_GAP` = −edgeZ (anchor → 상판 앞 가장자리) · `COOK_WORK_IN` = edgeZ − workZ (앞 가장자리 → 오른손 작업점) ·
 *   `COOK_KNIFE_X` = knifeX (몸 중심 → 오른손, 몸의 오른쪽) · `COOK_CHOP_LIFT` = chopLift · `COOK_STIR_R` = stirR.
 * 상판 높이 topY 1.08 은 `bench_cook` 의 `h − 0.02`(csv height 1.1)와 같다.
 */
export const COOK_EDGE_GAP = 0.3;
export const COOK_WORK_IN = 0.22;
export const COOK_KNIFE_X = 0.1;
export const COOK_CHOP_LIFT = 0.12;
export const COOK_STIR_R = 0.05;

/** 조리대 위의 도구 하나 (하위 그룹 이름 `cook-<tool>`). */
export type CookTool = 'board' | 'pot' | 'wok' | 'grill' | 'beaker';
export const COOK_TOOLS: readonly CookTool[] = ['board', 'pot', 'wok', 'grill', 'beaker'];
/** 게임 → 작업 자리로 나오는 도구. */
export const COOK_TOOL_OF: Readonly<Record<CookGame, CookTool>> = {
  chop: 'board', mince: 'board', grill: 'grill', stirfry: 'wok', stir: 'pot', pour: 'beaker',
};
/** 조리 중이 아닐 때 비커 액체의 높이 (비커 높이에 대한 비율). */
export const BEAKER_IDLE_LEVEL = 0.4;

export interface CookRig {
  /** 도구 그룹 — `position` 이 도구 바닥 가운데(상판 위)다. */
  tools: Record<CookTool, THREE.Group>;
  /** 쉬는 자리 (조리대 로컬). 도마의 쉬는 자리는 작업 자리 바로 뒤다. */
  rest: Readonly<Record<CookTool, THREE.Vector3>>;
  /** 작업 자리 = player 오른손의 기본 작업점 밑 (도구 중심). */
  work: THREE.Vector3;
  /** 도마가 아닌 도구가 작업 자리에 나올 때 도마가 비켜 가는 자리. */
  boardAside: THREE.Vector3;
  /** 칼 (도마의 자식) · 국자 (냄비의 자식, 냄비 중심 Y 축으로 돈다) · 비커 액체 (비커의 자식, `scale.y` = 높이). */
  knife: THREE.Group;
  ladle: THREE.Group;
  liquid: THREE.Group;
  liquidMesh: THREE.Mesh | null;
  /** 서는 자리 (조리대 로컬 **바닥**) · 몸이 보는 방향 (조리대 쪽 = +Z) · 고정 카메라의 초점. */
  anchor: THREE.Vector3;
  forward: { x: number; z: number };
  focus: THREE.Vector3;
  /** 후드 · 덕트가 차지하는 로컬 상자 — 카메라 가림 판정에 쓴다 (조리대 자신의 콜라이더는 가림 목록에 없다). */
  hood: { min: THREE.Vector3; max: THREE.Vector3 };
}

/** 칼이 도마 위에 누워 있는 자리 (도마 로컬) · 칼 그룹 원점에서 자루까지 (자루 = 오른손 자리). */
const KNIFE_REST = new THREE.Vector3(-0.05, 0.035, -0.08);
const KNIFE_GRIP = 0.11;

function toolGroup(model: FurnitureModel, parent: THREE.Object3D, name: string, pos: THREE.Vector3, fill: (b: GeoBatch) => void): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.copy(pos);
  const b = new GeoBatch();
  fill(b);
  b.build(g, model.meshes);
  parent.add(g);
  return g;
}

/**
 * `bench_cook` 의 도구 rig (빌더가 몸체를 병합한 **뒤** `buildFurniture` 가 부른다 — 시뮬레이션 허브의 `simHubRings` 와 같은 자리).
 * 치수는 `bench_cook` 빌더의 화구 판 자리(hx = −w·0.24, hz 0.02, 링 ±0.17 · ±0.14)와 도마 자리(x = w·0.15)에 맞췄다:
 *   냄비 = 뒤 왼쪽 링 · 웍 = 뒤 오른쪽 링 · 그릴 팬 = 앞 왼쪽 링 (앞 오른쪽 링은 비워 둔다) · 도마 = 작업 자리 바로 뒤 · 비커 = 재료 상자 뒤.
 * 작업 자리 x = w·0.15 는 후드 캐노피(x ≤ 0.02) 밖이라 서 있는 머리 위에 후드가 없고, 카메라 시선도 후드를 비켜 간다.
 * 웍 · 그릴 팬 자루는 +X (몸의 왼쪽 — player 의 왼손 `pressX` 쪽)로 뻗는다. `extra.cookGame` 이 있으면 그 도구를 작업 자리에 두고 짓는다.
 */
export function cookBenchTools(model: FurnitureModel, w: number, d: number, h: number, accent: THREE.Material, extra?: BuildExtra): void {
  const top = h - 0.02;
  const hx = -w * 0.24, hz = 0.02;
  const workX = w * 0.15, workZ = -d / 2 + COOK_WORK_IN;
  const v = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, top, z);
  // 화구 링 윗면 (화구 판 top + 0.03, 링 top + 0.027 … 0.043) — 냄비 · 웍 · 그릴 팬은 그 위에 얹힌다 (링이 열린 냄비 바닥을 뚫고 보이지 않게)
  const onHob = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, top + 0.045, z);
  const rest: Record<CookTool, THREE.Vector3> = {
    board: v(workX, -d / 2 + 0.36),
    pot: onHob(hx - 0.17, hz + 0.14),
    wok: onHob(hx + 0.17, hz + 0.14),
    grill: onHob(hx - 0.17, hz - 0.14),
    beaker: v(w * 0.36, d / 2 - 0.22),
  };
  const root = model.group;

  const board = toolGroup(model, root, 'cook-board', rest.board, (b) => {
    b.boxB(0.46, 0.035, 0.3, 0, 0, 0, M.padding);                                                // 도마
    b.cyl(0.032, 0.036, 0.12, 10, 0.15, 0.07, 0.07, M.crate, 0, 0, ALONG_X);                     // 통 채소 (눕힘)
    for (let k = 0; k < 3; k++) b.box(0.012, 0.055, 0.06, 0.07 - k * 0.024, 0.0625, 0.07, k === 1 ? accent : M.crate);   // 썬 조각
  });
  const knife = toolGroup(model, board, 'cook-knife', KNIFE_REST, (b) => {
    b.box(0.18, 0.008, 0.045, 0.02, 0.004, 0, M.hullLight);                                      // 칼날
    b.box(0.08, 0.02, 0.026, -KNIFE_GRIP, 0.01, 0, M.gunmetal);                                  // 자루
  });

  const pot = toolGroup(model, root, 'cook-pot', rest.pot, (b) => {
    b.cyl(0.13, 0.115, 0.17, 18, 0, 0.085, 0, M.gunmetal, 0, 0, 0, true);
    b.cyl(0.115, 0.115, 0.01, 16, 0, 0.008, 0, M.gunmetal);
    b.cyl(0.122, 0.122, 0.012, 18, 0, 0.13, 0, SOUP);                                            // 국물
    b.add(new THREE.TorusGeometry(0.13, 0.007, 6, 24), M.hullLight, 0, 0.17, 0, ALONG_X);        // 테
    for (const sx of [-1, 1]) b.box(0.05, 0.02, 0.06, sx * 0.16, 0.14, 0, M.hullDark);           // 손잡이
  });
  // 국자: 냄비 중심에서 돈다 — 국자 머리는 국물 속 (0.06, 0.11), 자루는 +X 로 기울어 테 밖으로 나온다
  const ladle = toolGroup(model, pot, 'cook-ladle', new THREE.Vector3(0, 0, 0), (b) => {
    b.cyl(0.03, 0.02, 0.02, 10, 0.06, 0.11, 0, M.hullLight);
    b.cyl(0.008, 0.008, 0.26, 6, 0.1, 0.234, 0, M.hullLight, 0, 0, -0.305);
  });

  const wok = toolGroup(model, root, 'cook-wok', rest.wok, (b) => {
    b.cyl(0.17, 0.08, 0.075, 18, 0, 0.0425, 0, M.gunmetal, 0, 0, 0, true);
    b.cyl(0.08, 0.08, 0.01, 16, 0, 0.005, 0, M.gunmetal);
    b.cyl(0.12, 0.1, 0.02, 16, 0, 0.03, 0, FOOD);                                                // 볶는 재료
    for (let k = 0; k < 4; k++) b.box(0.03, 0.02, 0.03, Math.cos(k * 1.6) * 0.06, 0.045, Math.sin(k * 1.6) * 0.05, k % 2 ? M.crate : accent, k);
    b.box(0.2, 0.022, 0.03, 0.27, 0.07, 0, M.hullDark);                                          // 자루
    b.box(0.08, 0.03, 0.04, 0.34, 0.07, 0, M.padding);                                           // 손잡이
  });

  const grill = toolGroup(model, root, 'cook-grill', rest.grill, (b) => {
    b.boxB(0.3, 0.025, 0.24, 0, 0, 0, M.gunmetal);                                               // 그릴 팬
    for (let k = 0; k < 5; k++) b.box(0.28, 0.012, 0.018, 0, 0.031, -0.08 + k * 0.04, M.trimDark);   // 줄무늬 살
    for (let k = 0; k < 2; k++) b.cyl(0.05, 0.05, 0.022, 12, -0.07 + k * 0.12, 0.048, 0, M.padding);   // 굽는 조각
    b.box(0.18, 0.02, 0.03, 0.24, 0.02, 0, M.hullDark);                                          // 자루
  });

  const beaker = toolGroup(model, root, 'cook-beaker', rest.beaker, (b) => {
    b.cyl(0.06, 0.055, 0.15, 16, 0, 0.075, 0, CLEAR_GLASS, 0, 0, 0, true);
    b.cyl(0.055, 0.055, 0.006, 16, 0, 0.003, 0, CLEAR_GLASS);
    for (let k = 0; k < 5; k++) b.box(k % 2 ? 0.02 : 0.035, 0.004, 0.004, -0.01, 0.03 + k * 0.025, -0.061, M.stripWhite);   // 눈금
    b.box(0.02, 0.01, 0.02, 0, 0.148, -0.062, CLEAR_GLASS);                                      // 주둥이
  });
  const liquid = toolGroup(model, beaker, 'cook-liquid', new THREE.Vector3(0, 0.006, 0), (b) => {
    b.cyl(0.052, 0.052, 0.13, 14, 0, 0.065, 0, liquidMat('water'));
  });
  liquid.scale.y = BEAKER_IDLE_LEVEL;
  const liquidMesh = (liquid.children[0] as THREE.Mesh | undefined) ?? null;

  const rig: CookRig = {
    tools: { board, pot, wok, grill, beaker },
    rest,
    work: v(workX, workZ),
    boardAside: v(workX, d / 2 - 0.36),
    knife, ladle, liquid, liquidMesh,
    anchor: new THREE.Vector3(workX + COOK_KNIFE_X, 0, -d / 2 - COOK_EDGE_GAP),
    forward: { x: 0, z: 1 },
    focus: new THREE.Vector3(workX + 0.05, top + 0.06, workZ + 0.06),
    hood: { min: new THREE.Vector3(hx - w * 0.25, top + 0.5, hz - d * 0.38), max: new THREE.Vector3(hx + w * 0.25, top + 1.1, hz + d * 0.38) },
  };
  model.cook = rig;
  const game = extra?.cookGame ?? null;
  if (game) {
    for (const t of COOK_TOOLS) cookToolTarget(rig, t, game, rig.tools[t].position);
    poseCookKnife(rig, game === 'chop' || game === 'mince', 0);
  }
}

/** 게임 `game`(null = 조리 중 아님) 동안 도구 `tool` 이 있어야 할 자리를 `out` 에. */
export function cookToolTarget(rig: CookRig, tool: CookTool, game: CookGame | null, out: THREE.Vector3): THREE.Vector3 {
  const active = game ? COOK_TOOL_OF[game] : null;
  if (tool === active) return out.copy(rig.work);
  if (tool === 'board' && active !== null) return out.copy(rig.boardAside);
  return out.copy(rig.rest[tool]);
}

/**
 * 칼: `active`(썰기 · 다지기)면 날을 세워 player 오른손 경로를 따른다 — 위상 φ 0 = 위(+`COOK_CHOP_LIFT`) · 0.5 = 도마에 닿음,
 * 손은 도마 가운데 기준 x −0.6·stirR·sin 2πφ · z +stirR·cos 2πφ (조리대 로컬 — 몸의 오른쪽이 −X, 앞이 +Z). 아니면 도마 위에 눕는다.
 */
export function poseCookKnife(rig: CookRig, active: boolean, cycle: number): void {
  const k = rig.knife;
  if (!active) { k.position.copy(KNIFE_REST); k.rotation.set(0, 0, 0); return; }
  const th = TAU * frac(cycle);
  const up = 0.5 + 0.5 * Math.cos(th);
  const lift = up * up * (3 - 2 * up);
  k.position.set(KNIFE_GRIP - 0.6 * COOK_STIR_R * Math.sin(th), 0.035 + 0.0225 + COOK_CHOP_LIFT * lift, COOK_STIR_R * Math.cos(th));
  k.rotation.set(Math.PI / 2, 0, 0);
}

/** 쉬는 모습으로: 도구는 쉬는 자리 · 칼은 눕히고 · 국자 정지 · 비커 액체는 물 `BEAKER_IDLE_LEVEL`. */
export function restCookRig(rig: CookRig): void {
  for (const t of COOK_TOOLS) { rig.tools[t].position.copy(rig.rest[t]); rig.tools[t].rotation.set(0, 0, 0); }
  poseCookKnife(rig, false, 0);
  rig.ladle.rotation.y = 0;
  rig.liquid.scale.y = BEAKER_IDLE_LEVEL;
  if (rig.liquidMesh) rig.liquidMesh.material = liquidMat('water');
}
