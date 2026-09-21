import * as THREE from 'three';
import type { CookGame, CookLiquid } from '@/shared';
import { COOK_LIQUIDS, COOK_LIQUID_COLOR } from '@/shared';
import { GeoBatch, HUB_MATS as M } from './GeoBatch';
import type { BuildExtra, Builder, FurnitureModel } from './Furniture';

/* ────────────────────────────────────────────────────────────────────────────
 * Kitchen furniture (2026-09-13, the cooking minigame).
 *
 *   • The procedural models of the four auto appliances, `KITCHEN_APPLIANCE_BUILDERS` — food processor · auto grill · auto stirrer · pour dispenser.
 *     They spread straight into `Furniture.ts`'s `BUILDERS` (the same `Builder` shape · centred · bottom at y 0 · front toward −Z · `GeoBatch`).
 *     All four stand on a kitchen cabinet (`counter`) of the same height, and `level` of the three indicator lights on the right of its front are lit.
 *   • The cook bench's (`bench_cook`) **tool rig** `cookBenchTools` — board (+knife) · pot (+ladle) · wok · grill pan · beaker (+liquid) are each a
 *     sub-group, so the tool of the current step's game comes out to the **work spot** (in front of the right hand) and the knife · ladle · wok
 *     follow the hand phase (`CookStaging` writes them every frame). The body (hood · hob · ingredient crate · seasoning bottles) stays in its builder.
 *
 * **It creates no light at all** — the heating elements · hob rings · indicator lights · liquids are emissive materials only (CLAUDE.md's 「never
 * change the point-light count at runtime」 · `smoke-lights`). Every material is shared and never disposed. The clear glass (`CLEAR_GLASS`) and the
 * beaker liquid are on the cook bench **at all times**, so they are already in the ship's shader pre-compile on entry (no program appears mid-cooking).
 * ──────────────────────────────────────────────────────────────────────────── */

function std(color: number, roughness: number, metalness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}
/** The clear glass of the food processor bowl · the dispenser tanks · the beakers. */
const CLEAR_GLASS = new THREE.MeshStandardMaterial({ color: 0xd4ecf6, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.3, depthWrite: false });
/** The broth in the pot and in the stirrer's pot (a warm glow). */
const SOUP = std(0xc97a3c, 0.45, 0.05, 0x7a3208, 0.4);
/** The stir-fry ingredients in the wok. */
const FOOD = std(0x9c6a3a, 0.7, 0.05, 0x4a2208, 0.22);

const liquidCache = new Map<string, THREE.MeshStandardMaterial>();
/** The material of a pour liquid (`COOK_LIQUID_COLOR`, a faint glow). One per colour, cached forever — the dispenser tanks and the cook bench's beaker share it. */
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

/* ── The four auto appliances ─────────────────────────────────────────────── */

export type KitchenApplianceKind = 'food_processor' | 'auto_grill' | 'auto_stirrer' | 'pour_dispenser';

/** The height of the kitchen cabinet top the four appliances stand on (m). */
const COUNTER_TOP = 0.72;

/** The kitchen cabinet: kickboard · body · worktop · front accent · two doors · **three level indicator lights** (`level` of them lit). */
function counter(b: GeoBatch, w: number, d: number, T: number, a: THREE.Material, lv: number): void {
  b.boxB(w - 0.1, 0.08, d - 0.14, 0, 0, 0.03, M.hullDark);                                       // kickboard
  b.boxB(w - 0.06, T - 0.14, d - 0.08, 0, 0.08, 0.01, M.hullLight);                              // cabinet body
  b.box(w - 0.02, 0.06, d - 0.02, 0, T - 0.03, 0, M.gunmetal);                                   // worktop
  const fz = -(d / 2 - 0.04);                                                                    // front face (2 cm proud of the body)
  b.box(w - 0.2, 0.035, 0.02, 0, T - 0.12, fz, a);                                               // front accent
  b.box(0.015, T - 0.4, 0.02, 0, 0.08 + (T - 0.4) / 2 + 0.06, fz, M.hullDark);                   // gap between the two doors
  for (const sx of [-1, 1]) b.box(0.02, 0.14, 0.025, sx * 0.06, T - 0.3, fz - 0.01, M.trim);      // handles
  for (let k = 0; k < 3; k++) b.box(0.045, 0.028, 0.02, w / 2 - 0.24 + k * 0.065, T - 0.2, fz - 0.005, k < lv ? M.stripWhite : M.hullDark);
}

export const KITCHEN_APPLIANCE_BUILDERS: Readonly<Record<KitchenApplianceKind, Builder>> = {
  /**
   * The food processor (`data/furniture.csv` `furn_food_processor` — chopping · mincing): a motor base on the cabinet (speed readout · dial · status light) → the locking ring →
   * a **clear glass bowl** (two S-blades · shaft · cyan hub · minced bits inside) → lid · feed chute · pusher; a handle beside the bowl, a spare blade-disc rack on the right.
   */
  food_processor: (b, w, d, _h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const x0 = -w * 0.08, z0 = d * 0.02;
    b.boxB(0.36, 0.16, 0.32, x0, T, z0, M.hullLight);                                            // motor base
    b.box(0.37, 0.025, 0.33, x0, T + 0.16, z0, M.gunmetal);                                      // base top plate
    b.box(0.18, 0.06, 0.012, x0 - 0.05, T + 0.09, z0 - 0.166, M.screen);                         // speed readout
    b.cyl(0.035, 0.035, 0.02, 14, x0 + 0.11, T + 0.09, z0 - 0.172, a, ALONG_X);                  // dial
    b.box(0.03, 0.014, 0.01, x0 - 0.05, T + 0.035, z0 - 0.165, M.stripCyan);                     // status light
    b.cyl(0.13, 0.14, 0.03, 20, x0, T + 0.175, z0, M.gunmetal);                                  // locking ring
    const by = T + 0.19, bh = 0.2;
    b.cyl(0.155, 0.135, bh, 24, x0, by + bh / 2, z0, CLEAR_GLASS, 0, 0, 0, true);                // glass bowl
    b.cyl(0.135, 0.135, 0.01, 20, x0, by + 0.005, z0, CLEAR_GLASS);                              // bowl floor
    b.cyl(0.013, 0.013, 0.15, 8, x0, by + 0.075, z0, M.trim);                                    // blade shaft
    b.box(0.22, 0.008, 0.034, x0, by + 0.045, z0, M.hullLight, 0.5);                             // S-blade (lower)
    b.box(0.2, 0.008, 0.034, x0, by + 0.085, z0, M.hullLight, -0.9);                             // S-blade (upper)
    b.cyl(0.024, 0.024, 0.03, 10, x0, by + 0.065, z0, M.stripCyan);                              // blade hub (the part that spins)
    for (let k = 0; k < 6; k++) {
      b.box(0.034, 0.028, 0.034, x0 + Math.cos(k * 1.1) * 0.075, by + 0.024, z0 + Math.sin(k * 1.7) * 0.065, k % 2 ? M.crate : a, k * 0.7);   // minced bits
    }
    b.cyl(0.165, 0.165, 0.024, 24, x0, by + bh + 0.012, z0, M.hullDark);                         // lid
    b.cyl(0.05, 0.05, 0.09, 14, x0 + 0.07, by + bh + 0.066, z0 - 0.03, M.hullLight, 0, 0, 0, true);   // feed chute
    b.cyl(0.042, 0.042, 0.04, 12, x0 + 0.07, by + bh + 0.125, z0 - 0.03, a);                     // pusher
    b.box(0.034, 0.17, 0.05, x0 + 0.2, by + bh * 0.55, z0, M.hullDark);                          // handle
    for (const t of [0.2, 0.9]) b.box(0.05, 0.028, 0.04, x0 + 0.175, by + bh * t, z0, M.hullDark);
    // spare blade-disc rack (right)
    b.boxB(0.1, 0.22, 0.26, w * 0.33, T, d * 0.14, M.hullDark);
    for (let k = 0; k < 2; k++) {
      b.cyl(0.08, 0.08, 0.012, 18, w * 0.33, T + 0.17, d * 0.14 - 0.06 + k * 0.12, M.hullLight, 0, 0, ALONG_X);
      b.cyl(0.02, 0.02, 0.016, 10, w * 0.33, T + 0.17, d * 0.14 - 0.06 + k * 0.12, a, 0, 0, ALONG_X);
    }
  },

  /**
   * The auto grill (`data/furniture.csv` `furn_auto_grill` — grilling · stir-frying): a firebox on the cabinet. On the left the **grill zone**, glowing heating elements (emissive)
   * showing between bars that run front to back, with two patties on them. On the right a **griddle** with griddle marks (vegetable pieces). Over the
   * grill zone a **hood** (a lid) opened from hinges at the back, a readout · two dials on the firebox front, and a spatula · tongs rail at the right end.
   */
  auto_grill: (b, w, d, _h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const bx = -w * 0.06, bw = w * 0.8, bd = d * 0.72, bz = 0.02;
    b.boxB(bw, 0.1, bd, bx, T, bz, M.hullDark);                                                  // firebox
    b.box(bw + 0.02, 0.02, bd + 0.02, bx, T + 0.1, bz, M.trim);                                  // rim
    const gx = bx - bw * 0.2, gw = bw * 0.56;                                                    // grill zone (left)
    const px = bx + bw * 0.3, pw = bw * 0.36;                                                    // griddle zone (right)
    for (const oz of [-0.2, 0, 0.2]) b.cyl(0.012, 0.012, gw - 0.08, 8, gx, T + 0.07, bz + oz, M.stripRed, 0, 0, ALONG_X);   // heating elements (emissive only)
    const bars = 7;
    for (let k = 0; k < bars; k++) b.box(0.028, 0.022, bd - 0.08, gx - gw / 2 + 0.06 + k * (gw - 0.12) / (bars - 1), T + 0.115, bz, M.gunmetal);   // grill bars
    for (let k = 0; k < 2; k++) {
      const cx = gx - 0.15 + k * 0.3;
      b.cyl(0.06, 0.06, 0.025, 14, cx, T + 0.139, bz, M.padding);                                // patty
      for (let s = 0; s < 2; s++) b.box(0.09, 0.003, 0.012, cx, T + 0.153, bz - 0.02 + s * 0.04, M.trimDark);   // sear marks
    }
    b.box(pw, 0.03, bd - 0.06, px, T + 0.115, bz, M.gunmetal);                                   // griddle
    for (let k = 0; k < 4; k++) b.box(pw - 0.06, 0.004, 0.018, px, T + 0.132, bz - 0.18 + k * 0.12, M.trimDark);   // griddle marks
    b.box(pw, 0.02, 0.035, px, T + 0.12, bz - (bd / 2 - 0.05), M.trimDark);                      // grease channel
    for (let k = 0; k < 3; k++) b.cyl(0.035, 0.035, 0.012, 10, px - 0.1 + k * 0.1, T + 0.136, bz + 0.08, k === 1 ? a : M.crate);   // vegetable pieces
    // hood: a lid opened up · back from the hinges at the rear (py, pz) (rx −0.93 so that local +Z points at (0, 0.8, 0.6))
    const py = T + 0.13, pz = 0.34, L = 0.26;
    b.box(gw + 0.02, 0.03, L, gx, py + 0.8 * L / 2, pz + 0.6 * L / 2, M.hullLight, 0, -0.93);
    b.box(gw - 0.06, 0.012, L - 0.05, gx, py + 0.8 * L / 2 + 0.012, pz + 0.6 * L / 2 - 0.016, M.hullDark, 0, -0.93);   // inner heat shield
    b.cyl(0.014, 0.014, gw - 0.12, 8, gx, py + 0.8 * L, pz + 0.6 * L - 0.01, M.gunmetal, 0, 0, ALONG_X);   // hood handle
    for (const sx of [-1, 1]) b.cyl(0.025, 0.025, 0.06, 10, gx + sx * gw * 0.4, py, pz, M.gunmetal, 0, 0, ALONG_X);   // hinges
    // firebox front: a readout · two dials
    const fz = bz - bd / 2;
    b.box(0.2, 0.05, 0.012, px, T + 0.05, fz - 0.007, M.screen);
    for (let k = 0; k < 2; k++) {
      const kx = gx - 0.15 + k * 0.3;
      b.cyl(0.028, 0.028, 0.025, 12, kx, T + 0.05, fz - 0.012, M.hullLight, ALONG_X);
      b.box(0.008, 0.02, 0.005, kx, T + 0.065, fz - 0.026, M.stripAmber);
    }
    // right end: the spatula · tongs rail
    const rx = w / 2 - 0.1;
    b.boxB(0.04, 0.34, 0.04, rx, T, 0.3, M.gunmetal);
    b.box(0.04, 0.03, 0.42, rx, T + 0.32, 0.1, M.gunmetal);
    b.box(0.012, 0.18, 0.02, rx, T + 0.21, -0.02, M.hullLight);                                  // spatula handle
    b.box(0.01, 0.06, 0.08, rx, T + 0.09, -0.02, M.hullLight);                                   // spatula blade
    for (const oz of [-0.012, 0.012]) b.box(0.01, 0.22, 0.012, rx, T + 0.19, 0.16 + oz, M.hullLight, 0, oz * 3);   // tongs
  },

  /**
   * The auto stirrer (`data/furniture.csv` `furn_auto_stirrer` — stirring): a big pot (broth · two handles) on an induction plate (a glowing ring) on the cabinet. The motor head (cyan
   * band) at the end of the **arm** from the **stand** column at the back right lowers a shaft into the pot, a cross **paddle** on its end. An ingredient jar at the front right.
   */
  auto_stirrer: (b, w, d, _h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const px = -w * 0.1, pz = -d * 0.06;
    b.boxB(0.5, 0.03, 0.5, px, T, pz, M.hullDark);                                               // induction plate
    b.add(new THREE.TorusGeometry(0.2, 0.012, 6, 32), M.stripRed, px, T + 0.035, pz, ALONG_X);   // glowing ring (emissive only)
    b.cyl(0.2, 0.18, 0.28, 24, px, T + 0.03 + 0.14, pz, M.gunmetal, 0, 0, 0, true);              // pot
    b.cyl(0.18, 0.18, 0.01, 20, px, T + 0.04, pz, M.gunmetal);                                   // pot floor
    b.cyl(0.192, 0.192, 0.012, 24, px, T + 0.25, pz, SOUP);                                      // broth
    b.add(new THREE.TorusGeometry(0.2, 0.01, 6, 32), M.hullLight, px, T + 0.31, pz, ALONG_X);    // rim
    for (const sx of [-1, 1]) b.box(0.06, 0.025, 0.08, px + sx * 0.235, T + 0.26, pz, M.hullDark);   // handles
    // stand · arm · motor head · shaft · paddle
    const sx0 = w * 0.3, sz0 = d * 0.3, AY = T + 0.56;
    b.boxB(0.24, 0.05, 0.24, sx0, T, sz0, M.hullDark);
    b.cyl(0.032, 0.036, 0.56, 12, sx0, T + 0.05 + 0.28, sz0, M.hullLight);
    b.cyl(0.05, 0.05, 0.05, 12, sx0, AY - 0.06, sz0, a);                                         // height-adjust collar
    b.box(0.12, 0.08, 0.02, sx0, T + 0.3, sz0 - 0.045, M.screen);                                // control screen on the column
    const dx = px - sx0, dz = pz - sz0, len = Math.hypot(dx, dz);
    b.box(0.06, 0.06, len + 0.06, (sx0 + px) / 2, AY, (sz0 + pz) / 2, M.hullLight, Math.atan2(dx, dz));   // arm
    b.cyl(0.065, 0.065, 0.14, 16, px, AY - 0.02, pz, M.hullDark);                                // motor head
    b.cyl(0.067, 0.067, 0.02, 16, px, AY - 0.05, pz, M.stripCyan);                               // running band (emissive)
    b.cyl(0.05, 0.05, 0.02, 14, px, AY + 0.06, pz, M.hullLight);
    const shaftTop = AY - 0.09, shaftBot = T + 0.08;
    b.cyl(0.012, 0.012, shaftTop - shaftBot, 8, px, (shaftTop + shaftBot) / 2, pz, M.trim);      // shaft
    for (const r of [0.4, 0.4 + Math.PI / 2]) b.box(0.26, 0.07, 0.012, px, T + 0.12, pz, M.hullLight, r);   // paddle
    b.cyl(0.06, 0.06, 0.14, 12, w * 0.32, T + 0.07, -d * 0.28, M.glassDark);                     // ingredient jar
    b.cyl(0.062, 0.062, 0.02, 12, w * 0.32, T + 0.15, -d * 0.28, a);
  },

  /**
   * The pour dispenser (`data/furniture.csv` `furn_pour_dispenser` — pouring): **four liquid tanks** (in `COOK_LIQUIDS` order — water · oil · milk · egg, colour = `COOK_LIQUID_COLOR`)
   * hang on the wall panel standing behind the cabinet — liquid in a clear glass tube · caps top and bottom · bracket · colour band. The valves under the
   * tanks gather into a manifold and come down to the centre **nozzle**, a **graduated beaker** on the tray below it; control screen and four liquid buttons left on the panel.
   */
  pour_dispenser: (b, w, d, h, a, lv) => {
    const T = COUNTER_TOP;
    counter(b, w, d, T, a, lv);
    const panelZ = d / 2 - 0.06, panelFront = panelZ - 0.035;
    b.boxB(w - 0.06, h - T, 0.07, 0, T, panelZ, M.hullDark);                                     // wall panel
    b.box(w - 0.02, 0.05, 0.14, 0, h - 0.025, d / 2 - 0.08, M.hullLight);                        // top cap
    b.box(w - 0.2, 0.025, 0.02, 0, h - 0.07, panelFront - 0.01, a);                              // accent
    const TB = T + 0.4, TH = 0.34, r = 0.08, tz = d / 2 - 0.19;
    const fills = [0.78, 0.55, 0.66, 0.42];
    const spacing = (w - 0.2) / COOK_LIQUIDS.length;
    COOK_LIQUIDS.forEach((liq, i) => {
      const x = -(w - 0.2) / 2 + (i + 0.5) * spacing;
      const f = fills[i % fills.length];
      const mat = liquidMat(liq);
      b.cyl(r, r, TH, 18, x, TB + TH / 2, tz, CLEAR_GLASS, 0, 0, 0, true);                       // glass tank
      b.cyl(r - 0.012, r - 0.012, TH * f, 16, x, TB + TH * f / 2, tz, mat);                      // liquid
      b.cyl(r + 0.008, r + 0.008, 0.03, 18, x, TB - 0.015, tz, M.hullLight);                     // bottom cap
      b.cyl(r + 0.008, r + 0.008, 0.03, 18, x, TB + TH + 0.015, tz, M.hullLight);                // top cap
      b.box(0.08, 0.018, 0.01, x, TB + TH + 0.015, tz - r - 0.012, mat);                         // colour band
      b.box(0.04, 0.05, 0.1, x, TB + TH * 0.7, tz + r + 0.02, M.gunmetal);                       // bracket
      b.cyl(0.014, 0.014, 0.07, 8, x, TB - 0.065, tz, M.trim);                                   // valve
      b.box(0.035, 0.035, 0.015, -0.33 + i * 0.055, T + 0.09, panelFront - 0.008, mat);          // liquid button
    });
    b.box(w - 0.28, 0.04, 0.05, 0, TB - 0.11, tz, M.gunmetal);                                   // manifold
    b.box(0.04, 0.04, 0.2, 0, TB - 0.11, tz - 0.1, M.gunmetal);                                  // nozzle pipe
    const nz = tz - 0.19;
    b.cyl(0.035, 0.02, 0.08, 12, 0, TB - 0.16, nz, M.hullLight);                                 // nozzle
    b.cyl(0.012, 0.012, 0.02, 8, 0, TB - 0.21, nz, M.stripCyan);                                 // nozzle tip (emissive)
    b.box(0.22, 0.13, 0.012, -0.25, T + 0.22, panelFront - 0.006, M.screen);                     // control screen
    // the tray + the graduated beaker
    b.boxB(0.3, 0.02, 0.26, 0, T, nz - 0.02, M.floorGrate);
    const bY = T + 0.02, bH = 0.15;
    b.cyl(0.07, 0.065, bH, 18, 0, bY + bH / 2, nz, CLEAR_GLASS, 0, 0, 0, true);
    b.cyl(0.065, 0.065, 0.006, 16, 0, bY + 0.003, nz, CLEAR_GLASS);
    b.cyl(0.06, 0.06, 0.06, 16, 0, bY + 0.036, nz, liquidMat('water'));
    for (let k = 0; k < 5; k++) b.box(k % 2 ? 0.02 : 0.035, 0.004, 0.004, -0.02, bY + 0.025 + k * 0.025, nz - 0.071, M.stripWhite);   // graduations
  },
};

/* ── The cook-bench tool rig ─────────────────────────────────────────────── */

/**
 * A mirror of player's `SoldierModel.FURN_COOK` (2026-09-13) — **player is the source of truth** (CLAUDE.md's 「player owns the body offsets, hub owns
 * the anchors」; the same contract as the gym `FURN_*`, so the values are copied across — no other feature folder is imported). When player changes, so does this.
 *   `COOK_EDGE_GAP` = −edgeZ (anchor → the front edge of the bench top) · `COOK_WORK_IN` = edgeZ − workZ (front edge → the right hand's work point) ·
 *   `COOK_KNIFE_X` = knifeX (body centre → the right hand, to the body's right) · `COOK_CHOP_LIFT` = chopLift · `COOK_STIR_R` = stirR.
 * The bench top player poses against is the `bench_cook` builder's `h − 0.02`, `h` being `data/furniture.csv` `furn_bench_cook`'s height — no copy of that number lives here.
 */
export const COOK_EDGE_GAP = 0.3;
export const COOK_WORK_IN = 0.22;
export const COOK_KNIFE_X = 0.1;
export const COOK_CHOP_LIFT = 0.12;
export const COOK_STIR_R = 0.05;

/** One tool on the cook bench (sub-group name `cook-<tool>`). */
export type CookTool = 'board' | 'pot' | 'wok' | 'grill' | 'beaker';
export const COOK_TOOLS: readonly CookTool[] = ['board', 'pot', 'wok', 'grill', 'beaker'];
/** Game → the tool that comes out to the work spot. */
export const COOK_TOOL_OF: Readonly<Record<CookGame, CookTool>> = {
  chop: 'board', mince: 'board', grill: 'grill', stirfry: 'wok', stir: 'pot', pour: 'beaker',
};
/** The height of the beaker's liquid when not cooking (a fraction of the beaker's height). */
export const BEAKER_IDLE_LEVEL = 0.4;

export interface CookRig {
  /** The tool groups — `position` is the centre of the tool's base (on the bench top). */
  tools: Record<CookTool, THREE.Group>;
  /** The rest spots (cook-bench local). The board's rest spot is just behind the work spot. */
  rest: Readonly<Record<CookTool, THREE.Vector3>>;
  /** The work spot = under player's right-hand base work point (the tool's centre). */
  work: THREE.Vector3;
  /** Where the board steps aside when a tool other than the board comes out to the work spot. */
  boardAside: THREE.Vector3;
  /** The knife (a child of the board) · the ladle (a child of the pot, turning about the pot's centre Y axis) · the beaker liquid (a child of the beaker, `scale.y` = height). */
  knife: THREE.Group;
  ladle: THREE.Group;
  liquid: THREE.Group;
  liquidMesh: THREE.Mesh | null;
  /** Where the body stands (cook-bench local, on the **floor**) · the direction it faces (toward the bench = +Z) · the fixed camera's focus. */
  anchor: THREE.Vector3;
  forward: { x: number; z: number };
  focus: THREE.Vector3;
  /** The local box the hood · duct take up — used for the camera occlusion check (the cook bench's own collider is not in the blocker list). */
  hood: { min: THREE.Vector3; max: THREE.Vector3 };
}

/** Where the knife lies on the board (board local) · from the knife group's origin to the handle (the handle = the right hand's spot). */
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
 * The tool rig of `bench_cook` (called by `buildFurniture` **after** the builder has merged the body — the same place as the simulation hub's `simHubRings`).
 * The dimensions match the `bench_cook` builder's hob-plate spot (hx = −w·0.24, hz 0.02, rings ±0.17 · ±0.14) and board spot (x = w·0.15):
 *   pot = back left ring · wok = back right ring · grill pan = front left ring (the front right one is left empty) · board = just behind the work spot · beaker = behind the ingredient crate.
 * The work spot x = w·0.15 is outside the hood canopy (x ≤ 0.02), so there is no hood over the standing head and the camera's line of sight clears it too.
 * The wok · grill-pan handles reach toward +X (the body's left — player's left hand, the `pressX` side). With `extra.cookGame` set, that tool is built at the work spot.
 */
export function cookBenchTools(model: FurnitureModel, w: number, d: number, h: number, accent: THREE.Material, extra?: BuildExtra): void {
  const top = h - 0.02;
  const hx = -w * 0.24, hz = 0.02;
  const workX = w * 0.15, workZ = -d / 2 + COOK_WORK_IN;
  const v = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, top, z);
  // the top of the hob rings (hob plate top + 0.03, ring top + 0.027 … 0.043) — the pot · wok · grill pan sit on it (so no ring shows through an open pot's floor)
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
    b.boxB(0.46, 0.035, 0.3, 0, 0, 0, M.padding);                                                // board
    b.cyl(0.032, 0.036, 0.12, 10, 0.15, 0.07, 0.07, M.crate, 0, 0, ALONG_X);                     // a whole vegetable (laid down)
    for (let k = 0; k < 3; k++) b.box(0.012, 0.055, 0.06, 0.07 - k * 0.024, 0.0625, 0.07, k === 1 ? accent : M.crate);   // cut slices
  });
  const knife = toolGroup(model, board, 'cook-knife', KNIFE_REST, (b) => {
    b.box(0.18, 0.008, 0.045, 0.02, 0.004, 0, M.hullLight);                                      // blade
    b.box(0.08, 0.02, 0.026, -KNIFE_GRIP, 0.01, 0, M.gunmetal);                                  // handle
  });

  const pot = toolGroup(model, root, 'cook-pot', rest.pot, (b) => {
    b.cyl(0.13, 0.115, 0.17, 18, 0, 0.085, 0, M.gunmetal, 0, 0, 0, true);
    b.cyl(0.115, 0.115, 0.01, 16, 0, 0.008, 0, M.gunmetal);
    b.cyl(0.122, 0.122, 0.012, 18, 0, 0.13, 0, SOUP);                                            // broth
    b.add(new THREE.TorusGeometry(0.13, 0.007, 6, 24), M.hullLight, 0, 0.17, 0, ALONG_X);        // rim
    for (const sx of [-1, 1]) b.box(0.05, 0.02, 0.06, sx * 0.16, 0.14, 0, M.hullDark);           // handles
  });
  // the ladle: it turns about the pot's centre — the ladle's bowl sits in the broth (0.06, 0.11) and its handle tilts out past the rim toward +X
  const ladle = toolGroup(model, pot, 'cook-ladle', new THREE.Vector3(0, 0, 0), (b) => {
    b.cyl(0.03, 0.02, 0.02, 10, 0.06, 0.11, 0, M.hullLight);
    b.cyl(0.008, 0.008, 0.26, 6, 0.1, 0.234, 0, M.hullLight, 0, 0, -0.305);
  });

  const wok = toolGroup(model, root, 'cook-wok', rest.wok, (b) => {
    b.cyl(0.17, 0.08, 0.075, 18, 0, 0.0425, 0, M.gunmetal, 0, 0, 0, true);
    b.cyl(0.08, 0.08, 0.01, 16, 0, 0.005, 0, M.gunmetal);
    b.cyl(0.12, 0.1, 0.02, 16, 0, 0.03, 0, FOOD);                                                // stir-fry ingredients
    for (let k = 0; k < 4; k++) b.box(0.03, 0.02, 0.03, Math.cos(k * 1.6) * 0.06, 0.045, Math.sin(k * 1.6) * 0.05, k % 2 ? M.crate : accent, k);
    b.box(0.2, 0.022, 0.03, 0.27, 0.07, 0, M.hullDark);                                          // handle
    b.box(0.08, 0.03, 0.04, 0.34, 0.07, 0, M.padding);                                           // grip
  });

  const grill = toolGroup(model, root, 'cook-grill', rest.grill, (b) => {
    b.boxB(0.3, 0.025, 0.24, 0, 0, 0, M.gunmetal);                                               // grill pan
    for (let k = 0; k < 5; k++) b.box(0.28, 0.012, 0.018, 0, 0.031, -0.08 + k * 0.04, M.trimDark);   // the ridges
    for (let k = 0; k < 2; k++) b.cyl(0.05, 0.05, 0.022, 12, -0.07 + k * 0.12, 0.048, 0, M.padding);   // the grilling pieces
    b.box(0.18, 0.02, 0.03, 0.24, 0.02, 0, M.hullDark);                                          // handle
  });

  const beaker = toolGroup(model, root, 'cook-beaker', rest.beaker, (b) => {
    b.cyl(0.06, 0.055, 0.15, 16, 0, 0.075, 0, CLEAR_GLASS, 0, 0, 0, true);
    b.cyl(0.055, 0.055, 0.006, 16, 0, 0.003, 0, CLEAR_GLASS);
    for (let k = 0; k < 5; k++) b.box(k % 2 ? 0.02 : 0.035, 0.004, 0.004, -0.01, 0.03 + k * 0.025, -0.061, M.stripWhite);   // graduations
    b.box(0.02, 0.01, 0.02, 0, 0.148, -0.062, CLEAR_GLASS);                                      // spout
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

/** Where tool `tool` belongs during game `game` (null = not cooking), into `out`. */
export function cookToolTarget(rig: CookRig, tool: CookTool, game: CookGame | null, out: THREE.Vector3): THREE.Vector3 {
  const active = game ? COOK_TOOL_OF[game] : null;
  if (tool === active) return out.copy(rig.work);
  if (tool === 'board' && active !== null) return out.copy(rig.boardAside);
  return out.copy(rig.rest[tool]);
}

/**
 * The knife: while `active` (chopping · mincing) it stands on edge and follows player's right-hand path — φ 0 = up (+`COOK_CHOP_LIFT`) · 0.5 = touching
 * the board, the hand at x −0.6·stirR·sin 2πφ · z +stirR·cos 2πφ from the board's centre (cook-bench local — the body's right is −X, its front +Z). Otherwise it lies on the board.
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

/** Back to rest: the tools to their rest spots · the knife laid down · the ladle stopped · the beaker liquid back to water at `BEAKER_IDLE_LEVEL`. */
export function restCookRig(rig: CookRig): void {
  for (const t of COOK_TOOLS) { rig.tools[t].position.copy(rig.rest[t]); rig.tools[t].rotation.set(0, 0, 0); }
  poseCookKnife(rig, false, 0);
  rig.ladle.rotation.y = 0;
  rig.liquid.scale.y = BEAKER_IDLE_LEVEL;
  if (rig.liquidMesh) rig.liquidMesh.material = liquidMat('water');
}
