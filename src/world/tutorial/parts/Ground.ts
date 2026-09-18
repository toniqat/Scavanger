import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  ABYSS_CUT_Z0, ABYSS_DRAW_BOTTOM_Y, ABYSS_EDGE_Z, ABYSS_FADE_TOP_Y, ABYSS_RUN_M, ABYSS_WALL_DROP_L, ABYSS_WALL_DROP_R,
  ABYSS_WALL_STEP_M, CHASM, CHASM_EDGE,
  CHASM_FLOOR_Y, CHASM_GAP_Z, CHASM_NEAR_Z, CHASM_TILT, CORRIDOR_MAX_HALF_X, CORRIDOR_OUTER_X, CORRIDOR_PROFILE, DECKS,
  DECK_LOWER_Y, DECK_TILE_M, DECK_UPPER_Y, PIT, PIT_DEPTH, PIT_FLOOR_Y, PIT_RAMP_OVERLAP, PIT_RAMP_RUN, PIT_RAMP_TOE_X,
  PIT_WALLS, SHIP_HILL_RISE, SHIP_HILL_Y, SHIP_SLOPE, SHIP_SLOPE_RUN, TILE_OVERLAP, VOID_Y, WALL_DESCENT_FROM_Z,
  WALL_DESCENT_RATE_L, WALL_DESCENT_RATE_R, WALL_DESCENT_STEP_M, WALL_MIN_ABOVE_WALK_M, WALL_PLAIN_FROM_Z, WALL_T, WALL_TOP_Y,
  Z_START, box, chasmFarZAt, chasmNearZAt, growRect, rectBox, shipHillSurfaceY, tileRect, type Rect,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * The tutorial planet's **ground** — chasm floor · decks · the side cliff walls · the dead end at the back · the abyss in front of the
 * ship (2026-09-15) · the last stretch's **android pit + walls** (2026-09-15 2nd · 3rd pass, `buildPit`) · **the abyss cuts beyond the wire
 * fence** (3rd pass, `model.ts` `ABYSS_CUTS` — the ground is the gap the lower `DECKS` pieces leave; here their cliff faces are drawn).
 *
 * 2026-09-15 3rd pass — **every lower deck piece · pit wall · side wall beside a cut can have a cliff face**: the rock body is drawn
 * from `ABYSS_FADE_TOP_Y` down with a darkening band below it (`pushCliff` → `this.fade`) — the cliff plate that used to sit only on the
 * edge in front of the ship (old `buildAbyss` ①) generalised to every lower piece, so no rock underside cut off flat at −100 ever shows.
 *
 * 2026-09-16 (user's decision) — past the fence everything is abyss but **the path · the ship hill · the pit island**: corridor pieces ending in
 * 1 m steps along the barrier's far face (`model.ts` `DECKS` · `ABYSS_CUTS`), the **0.9 m hill** the ship stands on and its ramp (`buildShipSlope`),
 * and **descending side walls** from the fence's end (left fast, right gentle — `addDescentWall`; `buildAbyss` carries on from those heights past the edge).
 *
 * Collider and drawing are split:
 *   - **The collider** is square tiles of `DECK_TILE_M` (`SpatialHash.addBox`). As one plate its circumscribed circle is 85 m,
 *     `maxRadius` grows by that much and **every** hash query sweeps hundreds of cells each frame.
 *   - **The drawing** is one box + one top plane per deck rect. There is no reason to split the mesh at tile boundaries.
 * It creates **no lights at all** (`CLAUDE.md`: the scene's light count never changes during play) — everything is emissive.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The half-width the chasm floor plate covers. 2026-09-15 `CORRIDOR_OUTER_X + 6` → **only out to the walls' outer face**: the side
 * walls descend at the abyss in front of the ship, so the 6 m band sticking out past them read as a **floating floor piece** beyond
 * the wall. The wall bodies go down to `VOID_Y`, so nothing that needed covering is lost.
 */
const FLOOR_HALF_X = CORRIDOR_OUTER_X;
/**
 * Top face of the descending last stretch (from `WALL_DESCENT_FROM_Z`) — z is that piece's **front end** (lowest side). Rates and floor value: the
 * `WALL_DESCENT_*` · `WALL_MIN_ABOVE_WALK_M` comments in `model.ts`. `jitter` is height taken off so the steps look less regular; the left side is
 * clamped to the floor value **after that** (it must not be climbable beside the path or the hill). Past the edge `buildAbyss` continues at jitter 0.
 */
function descentTop(sx: number, z: number, jitter = 0): number {
  const run = Math.max(0, WALL_DESCENT_FROM_Z - z);
  if (sx < 0) return Math.max(WALL_TOP_Y - WALL_DESCENT_RATE_L * run - jitter, SHIP_HILL_Y + WALL_MIN_ABOVE_WALK_M);
  return WALL_TOP_Y - WALL_DESCENT_RATE_R * run - jitter;
}
/** How far each wall piece past the edge flares its inner face outward (m) — the chasm ending and opening up. Last piece's inner face 17.9. */
const ABYSS_WALL_FLARE_M = 0.5;
/**
 * The heights that split the cliff face gradient — vertex colours follow the `((y − bottom) / span)^2.2` curve as a **polyline**. A box has
 * top and bottom vertices only, so drawing 380 m as one plate makes the gradient a straight line and it barely darkens within the 60 m
 * seen looking down from the edge. (0.73 at −90 · 0.43 at −160 · 0.15 at −260 · 0 at the bottom)
 */
const ABYSS_FADE_BANDS: readonly number[] = [ABYSS_FADE_TOP_Y, -90, -160, -260, ABYSS_DRAW_BOTTOM_Y];
/** The gradient's top colour = `cliffTexture`'s base colour (colour management moves the sRGB hex into linear). The seam with the rock wall does not jump. */
const ABYSS_TOP_COLOR = new THREE.Color(0x3a342c);

/** Attaches vertex colours that darken with vertex y (the curve in the `ABYSS_FADE_BANDS` comment). */
function shadeAbyss(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const span = ABYSS_FADE_TOP_Y - ABYSS_DRAW_BOTTOM_Y;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - ABYSS_DRAW_BOTTOM_Y) / span));
    const k = Math.pow(t, 2.2);
    col[i * 3] = ABYSS_TOP_COLOR.r * k;
    col[i * 3 + 1] = ABYSS_TOP_COLOR.g * k;
    col[i * 3 + 2] = ABYSS_TOP_COLOR.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
/** The z length of one straight cliff wall piece — the inner face and top face are jittered every such step so it does not read as a hallway. */
const WALL_SEG_M = 10;
/** How far the deck top plane is lifted (so it does not z-fight the collider's top face). */
const TOP_LIFT = 0.02;
/**
 * How far chasm 1's **diagonal plate** top face is lifted. The diagonal plate overlaps the axis-aligned deck (an axis-aligned rect
 * cannot hold a diagonal — `CHASM_EDGE` comment), and with both top planes at the same height the overlapping triangle z-fights.
 * Lifted by just 3 cm the diagonal plate wins where they overlap (same ground texture, so the seam does not show) and the rest is
 * unchanged. The walking height does not move at all — **both colliders are `DECK_UPPER_Y`**.
 */
const CHASM_TOP_LIFT = TOP_LIFT + 0.03;
/**
 * The pit floor body is drawn this much larger than `PIT` on every side — so its side faces do not lie in the same plane as the side
 * faces of the remaining deck band (both are hidden places, but no seed of z-fighting is left). **The collider stays `PIT`.**
 */
const FLOOR_BURY = 0.05;
/**
 * The thickness of the pit ramp's **drawn** box (along the slope normal). The high end's underside, `DECK_LOWER_Y − T/cos(19.8°)` = −11.28,
 * must be lower than the pit floor (−10.9), or from the side the space under the slope reads as empty.
 */
const RAMP_T = 1.2;
/** How far below the pit floor the ramp **collider**'s (the wedge's) base sits — it only has to leave no room to pass underneath. */
const RAMP_COLLIDER_DROP = 1;

function groundTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5a5044'; g.fillRect(0, 0, S, S);
  // Rock-grain blotches
  for (let i = 0; i < 220; i++) {
    const x = (i * 71) % S, y = (i * 137) % S, r = 4 + ((i * 29) % 26);
    g.fillStyle = i % 3 === 0 ? 'rgba(110,98,82,0.30)' : 'rgba(58,50,41,0.26)';
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, (i % 7) * 0.45, 0, Math.PI * 2); g.fill();
  }
  // Cracks
  g.strokeStyle = 'rgba(32,27,22,0.55)'; g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = (i * 53) % S, y = (i * 97) % S;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += ((i + k) % 5) * 11 - 18; y += ((i * k) % 6) * 9 + 6; g.lineTo(x, y); }
    g.stroke();
  }
  // Fine sand
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
  // Horizontal strata
  for (let y = 0; y < S; y += 9) {
    g.fillStyle = `rgba(${26 + ((y * 7) % 40)},${22 + ((y * 5) % 34)},${18 + ((y * 3) % 28)},0.5)`;
    g.fillRect(0, y, S, 4 + ((y * 11) % 5));
  }
  // Vertical fissures
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

/**
 * One top plane (the texture repeats to fit `rect`).
 * 2026-09-16: the texture is **aligned to world coordinates** (`offset` = the plate's corner / 8 m) — the steps beyond the wire fence (`model.ts`
 * `DECKS`) are split into 1 m wide pieces, so if the pattern restarted at each plate's corner a stripe would show at every seam. Laying a
 * `PlaneGeometry` flat grows u along +X and v along −Z, so u' = (x − x0)/8 + x0/8 = x/8 · v' = (z0 − z)/8 − z0/8 = −z/8 — same as its neighbour.
 */
function topPlane(rect: Rect, y: number, tex: THREE.CanvasTexture): THREE.Mesh {
  const mesh = topQuad((rect.x0 + rect.x1) / 2, y, (rect.z0 + rect.z1) / 2, rect.x1 - rect.x0, rect.z0 - rect.z1, 0, tex);
  (mesh.material as THREE.MeshStandardMaterial).map!.offset.set(rect.x0 / 8, -rect.z0 / 8);
  return mesh;
}

/**
 * One top plane — by centre · size · `rotateY` (the diagonal plate has yaw ≠ 0).
 * `tiltZ` is the Z-axis tilt (pit ramp — negative drops the +X side), `tiltX` the X-axis tilt (ship hill ramp — positive raises the −Z side).
 */
function topQuad(
  cx: number, y: number, cz: number, w: number, d: number, yaw: number, tex: THREE.CanvasTexture, tiltZ = 0, tiltX = 0,
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  if (yaw !== 0) geo.rotateY(yaw);
  if (tiltZ !== 0) geo.rotateZ(tiltZ);
  if (tiltX !== 0) geo.rotateX(tiltX);
  geo.translate(cx, y, cz);
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
  /** The cliff faces' darkening bands (`shadeAbyss`, `vertexColors` + `fog: false`) — merged into one mesh at the end of `build`. */
  private fade: THREE.BufferGeometry[] = [];

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

    /* ── Chasm floor plate (drawing) ──
     * 2026-09-15: its height is `CHASM_FLOOR_Y` (−34), not `VOID_Y` (terrain, now −100). 3rd pass: at the front it **ends at `ABYSS_CUT_Z0`
     * (−120), where the first abyss cut beyond the wire fence starts** — past it there are only deck pieces · the pit · walls · cuts, so a plate
     * would show floor under a cut (it must be the same abyss as the edge in front of the ship). Bodies reaching below the plate are hidden by it. */
    const floorGeo = new THREE.PlaneGeometry(FLOOR_HALF_X * 2, Z_START - ABYSS_CUT_Z0);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, CHASM_FLOOR_Y, (Z_START + ABYSS_CUT_Z0) / 2);
    const floor = new THREE.Mesh(floorGeo, darkMat);
    floor.name = 'tut-void-floor';
    floor.layers.enable(Layers.TERRAIN);
    floor.matrixAutoUpdate = false;
    this.group.add(floor);
    this.disposables.push(floorGeo);
    /* Chasm 1's **chasm floor collider** (2026-09-15) — terrain dropped to −100, so a body that fell into chasm 1 lands on this top face
     * (−34). It covers 2 m more front and back than the diagonal gap's outer rect (`CHASM`), out to the walls' outer face. Where it overlaps
     * a deck collider it sits below the deck top face, so walking height is unaffected (`getSurfaceY` picks the highest top face in the feet-height window). */
    const chasmFloor: Rect = { x0: -CORRIDOR_OUTER_X, x1: CORRIDOR_OUTER_X, z0: CHASM.z0 + 2, z1: CHASM.z1 - 2 };
    for (const t of tileRect(chasmFloor, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, CHASM_FLOOR_Y, 'tut_deck');

    /* ── Deck: body box (drawing) + top plane (drawing) + tile colliders ──
     * 2026-09-15 3rd pass: the lower deck is seven pieces (the `DECKS` table in `model.ts`) and the pit · abyss cuts are the **gaps between**
     * them — nothing digs. A piece's side face is the pit rim and the cliff face (the body box draws all six faces), so no rim mesh is built
     * and that piece's collider (`VOID_Y … DECK_LOWER_Y`) is the rim. A lower piece can have a cliff face, so `pushCliff` draws it (file head comment). */
    const bodies: THREE.BufferGeometry[] = [];
    for (const d of DECKS) {
      // 2026-09-16: the ship hill (`SHIP_HILL_Y`) is a lower piece too — it gets the same cliff face and seam overlap
      const lower = d.top < DECK_UPPER_Y;
      if (lower) this.pushCliff(bodies, d.rect, d.top); else bodies.push(rectBox(d.rect, VOID_Y, d.top));
      const top = topPlane(d.rect, d.top + TOP_LIFT, groundTex);
      this.group.add(top);
      this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
      // Where lower pieces meet, only the collider is grown by `TILE_OVERLAP` to overlap (`model.ts` `DECKS` comment — the drawing keeps its design size).
      // It also grows 5 cm toward a cut or the pit, but no top plane is there so nothing shows; a cliff edge only lets a foot land 5 cm further out.
      const cr = lower ? growRect(d.rect, TILE_OVERLAP) : d.rect;
      for (const t of tileRect(cr, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, d.top, 'tut_deck');
    }
    this.buildPit(hash, bodies, groundTex);
    this.buildShipSlope(hash, bodies, groundTex);
    this.buildChasmEdges(hash, bodies, groundTex);
    this.addMerged(bodies, rockMat, 'tut-deck-body');

    /* ── Side cliff walls · the dead end ──
     * 2026-09-14 2nd pass: the walls' inner face is now decided by `CORRIDOR_PROFILE` — a straight stretch is still broken every
     * `WALL_SEG_M` to jitter the inner face and the top face, and a stretch whose width changes is joined by one **slanted plate**
     * (a rotated OBB). Each stretch registers its own collider, so **the drawn silhouette is the collider** (the prop rule in `CLAUDE.md`).
     * The outer face is always `CORRIDOR_OUTER_X` whatever the stretch's width, so nothing shows through behind a narrow stretch's wall. */
    const walls: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      let seg = 0;
      for (let i = 1; i < CORRIDOR_PROFILE.length; i++) {
        const a = CORRIDOR_PROFILE[i - 1], b = CORRIDOR_PROFILE[i];
        if (a.halfX === b.halfX) {
          const depth = a.z - b.z;
          const n = Math.max(1, Math.ceil(depth / WALL_SEG_M));
          for (let j = 0; j < n; j++, seg++) {
            const z0 = a.z - (depth * j) / n;
            let z1 = a.z - (depth * (j + 1)) / n;
            const k = seg * 7 + (sx > 0 ? 3 : 0);
            // 2026-09-16: a piece crossing the fence's end (`WALL_DESCENT_FROM_Z`) is cut there, and descending pieces fill what lies past it (`addDescentWall`).
            // The cut-off front keeps the old piece's k · bite · top face, so the wall at the barrier's left gap (z −132 … −140, bite 0) does not move at all.
            if (z1 < WALL_DESCENT_FROM_Z) {
              this.addDescentWall(hash, walls, sx, a.halfX, Math.min(z0, WALL_DESCENT_FROM_Z), z1);
              if (z0 <= WALL_DESCENT_FROM_Z) continue;
              z1 = WALL_DESCENT_FROM_Z;
            }
            // How deep the wall bites inward — on a narrow stretch it shrinks by the same ratio so the corridor never gets narrower than designed.
            // 2026-09-15: 0 from the piece the ship and the `ship` checkpoint stand on (`WALL_PLAIN_FROM_Z`) — 2.27 m from the ship's left nacelle to the wall
            const bite = z0 <= WALL_PLAIN_FROM_Z ? 0 : (k % 5) * 0.55 * (a.halfX / CORRIDOR_MAX_HALF_X);
            const top = WALL_TOP_Y - (k % 4) * 1.6;
            const inner = sx * (a.halfX - bite), outer = sx * CORRIDOR_OUTER_X;
            const rect: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0, z1 };
            // 2026-09-15 3rd pass: a piece beside an abyss cut past the fence (ending before `ABYSS_CUT_Z0`) shows its inner face to a body falling into the cut, so it is drawn as a cliff face
            if (z1 <= ABYSS_CUT_Z0) this.pushCliff(walls, rect, top); else walls.push(rectBox(rect, VOID_Y, top));
            this.addBox(hash, rect, VOID_Y, top, 'tut_wall');
          }
        } else {
          seg++;
          this.addFunnel(hash, walls, sx, a.halfX, a.z, b.halfX, b.z);
        }
      }
    }
    // 2026-09-15: there is **only one dead-end wall, at the back (`Z_START`)**. The front cap (old `Z_END` −162 … −165) was the wall the
    // ship flew straight through on liftoff, so it was removed; that place is the abyss now (`buildAbyss`).
    const cap: Rect = { x0: -CORRIDOR_OUTER_X, x1: CORRIDOR_OUTER_X, z0: Z_START, z1: Z_START - WALL_T };
    walls.push(rectBox(cap, VOID_Y, WALL_TOP_Y));
    for (const t of tileRect(cap, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, WALL_TOP_Y, 'tut_wall');
    this.buildAbyss(hash, walls);
    this.addMerged(walls, rockMat, 'tut-walls');
    const fadeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, fog: false });
    this.disposables.push(fadeMat);
    this.addMerged(this.fade, fadeMat, 'tut-abyss');
    this.fade = [];

    /* ── The broken bridge caught in chasm 1's gap (drawing only — **below the deck top face**, so it cannot be stepped on or crossed) ──
     * 2026-09-14 2nd pass: chasm 1 is a narrow stretch, so x moved inward from 12 (buried in a wall it would not be seen).
     * 2026-09-14 3rd pass: the half-width shrank further to 7.7 and the edges became **diagonal**, so x stays inside ±5.6 and z comes from
     * the diagonal position at that x (`chasmNearZAt` · `chasmFarZAt`). */
    const bridge: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const xa = sx * 5.0, xb = sx * 5.6;
      bridge.push(box(1.1, 0.5, 3.0, xa, DECK_UPPER_Y - 1.1, chasmNearZAt(xa) - 0.6, sx * 0.22));
      bridge.push(box(0.9, 0.4, 3.6, xb, DECK_UPPER_Y - 2.9, chasmNearZAt(xb) - CHASM_GAP_Z / 2, sx * 0.55));
    }
    bridge.push(box(3.2, 0.4, 1.2, -5.2, DECK_UPPER_Y - 4.4, chasmFarZAt(-5.2) + 0.4, 0.3));
    this.addMerged(bridge, darkMat, 'tut-broken-bridge', true);
  }

  /**
   * **The abyss** (2026-09-15, user's decision — in front of the ship is not a closed wall but a drop with no bottom in sight).
   *
   * It builds two things (2026-09-15 3rd pass: the old ① 「a cliff plate drawn in place of the lower deck's front face」 is gone — a lower deck
   * piece's body (from 2026-09-16 the ship hill `ship_hill` too) draws its own front face with `pushCliff`, because once the cuts appeared the cliff face was no longer one front face):
   *   ① **The side walls past the edge** — `ABYSS_RUN_M / STEP` pieces of `ABYSS_WALL_STEP_M`. Each piece's top face drops by
   *      `ABYSS_WALL_DROP_L` on the left · `ABYSS_WALL_DROP_R` on the right (2026-09-16: from the height the straight wall ended at the edge
   *      — `descentTop`) and its inner face flares by `ABYSS_WALL_FLARE_M` (the chasm ends and opens up). The collider runs from `VOID_Y`
   *      to that top face — a falling body does not pass the wall and leave the map.
   *   ② **There is no floor.** Above `ABYSS_FADE_TOP_Y` the drawing is rock wall (the same material as the other walls), below it vertex
   *      colours darkening down to `ABYSS_DRAW_BOTTOM_Y` (`shadeAbyss`, **`fog: false`**). Fog (FogExp2) paints distance in the **bright**
   *      fog colour, so under fog the depths would brighten instead and clash with the sky dome below them (`core/Sky`'s `ground` colour under the horizon — dark).
   *
   * 0 lights. The one new material (`vertexColors` + `fog: false`, made by `build`) is one more shader variant and `world:ready`'s pre-compile takes it.
   *
   * **Liftoff arithmetic check** (ship `SHIP_POS` · `SHIP_YAW` — `model.ts` comment): the ship rises toward its nose (front right) and advances only 18.5 m
   * before clearing the wall tops (≤ 18); over that the hull stays within x −13.1 … +0.4 — it never touches the walls' inner faces (±15.4, wider still past the edge).
   */
  private buildAbyss(hash: SpatialHash, rock: THREE.BufferGeometry[]): void {
    const edge = ABYSS_EDGE_Z;

    // ① Side walls past the edge — 2026-09-16: they continue down from the height the straight wall ended at the edge (`descentTop`, left −6.1 · right 2.0).
    //    Per piece `ABYSS_WALL_DROP_L` on the left · `ABYSS_WALL_DROP_R` on the right (the right is gentler — last piece's top face left −42.1 · right −16)
    const n = Math.max(1, Math.round(ABYSS_RUN_M / ABYSS_WALL_STEP_M));
    for (const sx of [-1, 1]) {
      const start = descentTop(sx, edge);
      const drop = sx < 0 ? ABYSS_WALL_DROP_L : ABYSS_WALL_DROP_R;
      for (let i = 0; i < n; i++) {
        const z0 = edge - ABYSS_WALL_STEP_M * i, z1 = z0 - ABYSS_WALL_STEP_M;
        const flare = ABYSS_WALL_FLARE_M * i;
        const inner = sx * (CORRIDOR_MAX_HALF_X + flare), outer = sx * (CORRIDOR_OUTER_X + flare);
        const r: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0, z1 };
        const top = start - drop * (i + 1);
        this.pushCliff(rock, r, top);
        this.addBox(hash, r, VOID_Y, top, 'tut_wall');
      }
    }
  }

  /**
   * One box that can have a cliff face: the rock body (`ABYSS_FADE_TOP_Y … top`) goes into `rock`, and what is below it
   * (`ABYSS_DRAW_BOTTOM_Y … ABYSS_FADE_TOP_Y`) is split into `ABYSS_FADE_BANDS` bands of darkening vertex colours (`shadeAbyss`) into `this.fade`.
   * Lower deck pieces · pit walls · side walls beside a cut · walls past the edge are all this. The caller registers the collider separately (from `VOID_Y`).
   */
  private pushCliff(rock: THREE.BufferGeometry[], r: Rect, top: number): void {
    rock.push(rectBox(r, ABYSS_FADE_TOP_Y, top));
    for (let i = 1; i < ABYSS_FADE_BANDS.length; i++) this.fade.push(shadeAbyss(rectBox(r, ABYSS_FADE_BANDS[i], ABYSS_FADE_BANDS[i - 1])));
  }

  /**
   * **The android pit** (2026-09-15 2nd · 3rd pass, user's decision — every dimension and its reason are in `model.ts`'s `PIT` · `PIT_DEPTH` · `PIT_WALLS` comments).
   *
   * It builds four things (the hole is the place the lower `DECKS` pieces left empty from the start):
   *   ① **The floor** — body box (drawing) + `DECK_TILE_M` tile colliders (`VOID_Y … PIT_FLOOR_Y`) + a rock top plane.
   *      The body is drawn `FLOOR_BURY` larger than `PIT` all round so its side faces **do not share a plane** with the deck pieces' and walls' side faces,
   *      and the top plane is laid only from the ramp toe (`PIT_RAMP_TOE_X`) on (two plates of the same height meeting z-fight).
   *      The collider stays `PIT`. Deck pieces and walls surround it (both drawn down to `ABYSS_DRAW_BOTTOM_Y`), so the body's underside is never seen.
   *   ② **The rim** — not built separately. A neighbouring piece's side face (`VOID_Y … DECK_LOWER_Y`) is the 0.9 m rim and that piece's collider is the rim collider
   *      (west, above the ramp = `lower_pit_w`; the ramp's south rim = the body of the ship hill ramp `SHIP_SLOPE`; from 2026-09-16 north = `PIT_WALLS`' `pit_rim_n`).
   *      Why a grenade cannot roll out is in the `PIT_DEPTH` comment.
   *   ④ **The walls** (3rd pass) — east · south `PIT_WALLS` (+ the north rim from 2026-09-16): a cliff-face box (`pushCliff`, the outer face is the cliff) + one column of collider `VOID_Y … top face`.
   *      Material and footsteps are rock (`tut_wall`) — the old concrete `BACKSTOP` (`parts/Dressing`) is gone.
   *   ③ **The ramp** — the whole ship-side (−X) face. The drawing is one box tilted about Z plus a top plane at the same tilt; the collider is
   *      one rotated OBB from `SpatialHash.addRamp` (local +X = the high side = world −X, so `Obstacle.box.yaw` is π).
   *      ⚠ Only the collider bites `PIT_RAMP_OVERLAP` under the deck — butted on exactly the same line, both colliders miss the points on
   *      the seam and the ground under the feet disappears (`CLAUDE.md`'s 「stairs are ramp colliders」). In exchange, at x = `PIT.x0` the
   *      ramp's top face is `PIT_DEPTH × OVERLAP / (RUN + OVERLAP)` = **0.028 m** below the deck, but `getSurfaceY` picks the higher of
   *      the two, so the deck wins over the overlapping 8 cm (no rim and no step appears).
   *
   * 0 lights. No new material either (the floor and ramp bodies use the same `rockMat` as the walls, the top planes the same rock texture as the decks).
   */
  private buildPit(hash: SpatialHash, bodies: THREE.BufferGeometry[], tex: THREE.CanvasTexture): void {
    // ① The floor
    const bury = FLOOR_BURY;
    bodies.push(rectBox({ x0: PIT.x0 - bury, x1: PIT.x1 + bury, z0: PIT.z0 + bury, z1: PIT.z1 - bury }, VOID_Y, PIT_FLOOR_Y));
    for (const t of tileRect(PIT, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, PIT_FLOOR_Y, 'tut_deck');
    // The top plane covers **only the flat part** — laid over the ramp too, two plates of the same height would meet at the toe line and z-fight.
    const floorTop = topPlane({ x0: PIT_RAMP_TOE_X, x1: PIT.x1, z0: PIT.z0, z1: PIT.z1 }, PIT_FLOOR_Y + TOP_LIFT, tex);
    this.group.add(floorTop);
    this.disposables.push(floorTop.geometry, floorTop.material as THREE.Material, (floorTop.material as THREE.MeshStandardMaterial).map!);

    // ④ The walls (east · south) — `model.ts`'s `PIT_WALLS`
    for (const w of PIT_WALLS) {
      this.pushCliff(bodies, w.rect, w.top);
      for (const t of tileRect(w.rect, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, w.top, 'tut_wall');
    }

    // ③ The ramp (the whole −X face)
    const tilt = Math.atan2(PIT_DEPTH, PIT_RAMP_RUN);
    const slopeLen = Math.hypot(PIT_RAMP_RUN, PIT_DEPTH);
    const depth = PIT.z0 - PIT.z1;
    const cx = (PIT.x0 + PIT_RAMP_TOE_X) / 2, cy = (DECK_LOWER_Y + PIT_FLOOR_Y) / 2, cz = (PIT.z0 + PIT.z1) / 2;
    // Tilted box: local +X is the downhill direction, local +Y the slope normal (rotateZ(−tilt) sends +X → (cos, −sin) · +Y → (sin, cos))
    const slab = new THREE.BoxGeometry(slopeLen, RAMP_T, depth);
    slab.rotateZ(-tilt);
    slab.translate(cx - (RAMP_T / 2) * Math.sin(tilt), cy - (RAMP_T / 2) * Math.cos(tilt), cz);
    bodies.push(slab);
    const rampTop = topQuad(cx, cy + TOP_LIFT, cz, slopeLen, depth, 0, tex, -tilt);
    this.group.add(rampTop);
    this.disposables.push(rampTop.geometry, rampTop.material as THREE.Material, (rampTop.material as THREE.MeshStandardMaterial).map!);
    const rx0 = PIT.x0 - PIT_RAMP_OVERLAP;
    const base = PIT_FLOOR_Y - RAMP_COLLIDER_DROP;
    this.entries.push(hash.addRamp(
      new THREE.Vector3((rx0 + PIT_RAMP_TOE_X) / 2, base, cz), (PIT_RAMP_TOE_X - rx0) / 2, depth / 2,
      Math.PI, DECK_LOWER_Y - base, PIT_DEPTH, 'tut_deck',
    ));
  }

  /**
   * **The ship hill's ramp** (2026-09-16, user's decision — dimensions and reasons in `model.ts`'s `SHIP_HILL_*` · `SHIP_SLOPE` comments).
   *   ① **Body** — a cliff-face box of the `SHIP_SLOPE` rect (`pushCliff`, top face `DECK_LOWER_Y`) + tile colliders (`VOID_Y … DECK_LOWER_Y`, seams
   *      grown by `TILE_OVERLAP` like the other lower pieces). Its east face (x 1.5) shows toward the abyss cut `cut_s`, and its north face over x −2 … 1.5 is the pit's south rim.
   *   ② **Wedge** (drawing) — a triangular prism on top of the body. `BoxGeometry`'s top vertices move to the slope height at that z and its bottom ones to
   *      `DECK_LOWER_Y` — the side faces stay vertical and run into the east cliff face as one plane. **Why no tilted box** as in the pit ramp: a tilted
   *      box's low end pokes its bottom edge out along +Z by the slope normal (thickness 1.2 × sin 11.3° = 0.24 m) and juts out of the pit's south rim face like a bib.
   *   ③ **Top plane** — a rock plate tilted about X (`topQuad`'s `tiltX`); the pattern is shifted in world coordinates so it runs on into the path and hill plates.
   *   ④ **Ramp collider** — one `SpatialHash.addRamp`. Local +X (the high side) is world −Z, so `Obstacle.box.yaw` = −π/2 (`obb.toLocal`'s math
   *      convention (cos, sin) = (0, −1)). The high end bites `PIT_RAMP_OVERLAP` under the hill's top face (`CLAUDE.md` 「stairs are ramp colliders,
   *      overlapping the upper plate by 0.08 m」) — so at z −153.5 the slope is 0.016 m below the hill and `getSurfaceY` picks the higher one (the
   *      hill). The low end (z −149) is exactly `DECK_LOWER_Y`, so it runs into the path (`lower_pit_w`) with no step.
   * 0 lights, no new material.
   */
  private buildShipSlope(hash: SpatialHash, bodies: THREE.BufferGeometry[], tex: THREE.CanvasTexture): void {
    const r = SHIP_SLOPE;
    const w = r.x1 - r.x0, d = r.z0 - r.z1, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    // ① Body
    this.pushCliff(bodies, r, DECK_LOWER_Y);
    for (const t of tileRect(growRect(r, TILE_OVERLAP), DECK_TILE_M)) this.addBox(hash, t, VOID_Y, DECK_LOWER_Y, 'tut_deck');
    // ② Wedge — a vertex z can float slightly past the rect bounds, so it is clamped before the lookup (past them `shipHillSurfaceY` is null)
    const wedge = new THREE.BoxGeometry(w, 1, d);
    wedge.translate(cx, 0, cz);
    const pos = wedge.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const z = Math.min(r.z0, Math.max(r.z1, pos.getZ(i)));
      pos.setY(i, pos.getY(i) > 0 ? (shipHillSurfaceY(cx, z) ?? DECK_LOWER_Y) : DECK_LOWER_Y);
    }
    wedge.computeVertexNormals();
    bodies.push(wedge);
    // ③ Top plane
    const tilt = Math.atan2(SHIP_HILL_RISE, SHIP_SLOPE_RUN);
    const slopeLen = Math.hypot(SHIP_SLOPE_RUN, SHIP_HILL_RISE);
    const top = topQuad(cx, (DECK_LOWER_Y + SHIP_HILL_Y) / 2 + TOP_LIFT, cz, w, slopeLen, 0, tex, 0, tilt);
    (top.material as THREE.MeshStandardMaterial).map!.offset.set(r.x0 / 8, -r.z0 / 8);
    this.group.add(top);
    this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
    // ④ Ramp collider
    const hi = r.z1 - PIT_RAMP_OVERLAP;
    const base = DECK_LOWER_Y - RAMP_COLLIDER_DROP;
    this.entries.push(hash.addRamp(
      new THREE.Vector3(cx, base, (r.z0 + hi) / 2), (r.z0 - hi) / 2, w / 2,
      -Math.PI / 2, SHIP_HILL_Y - base, SHIP_HILL_RISE, 'tut_deck',
    ));
  }

  /**
   * **The descending side wall** (2026-09-16, user's decision — `model.ts`'s `WALL_DESCENT_*` comment). `z0 … z1` (z0 > z1) is split into `WALL_DESCENT_STEP_M`
   * pieces and each piece's top face is lowered by `descentTop`. The inner face has bite 0 — the 2.27 m between the ship's left nacelle and the wall is untouched (`WALL_PLAIN_FROM_Z`).
   * Each piece is a cliff face (`pushCliff`) + one column of collider `VOID_Y … top face`, so the stepped top face is the collider.
   */
  private addDescentWall(hash: SpatialHash, walls: THREE.BufferGeometry[], sx: number, halfX: number, z0: number, z1: number): void {
    const n = Math.max(1, Math.ceil((z0 - z1) / WALL_DESCENT_STEP_M - 1e-6));
    for (let i = 0; i < n; i++) {
      const pz0 = z0 - ((z0 - z1) * i) / n, pz1 = z0 - ((z0 - z1) * (i + 1)) / n;
      // 0 / 0.4 / 0.8 m taken from the position and the side — so it does not look like a regular staircase (the left is then clamped to the floor value again)
      const jitter = ((Math.round(-pz1) * 5 + (sx > 0 ? 2 : 0)) % 3) * 0.4;
      const top = descentTop(sx, pz1, jitter);
      const inner = sx * halfX, outer = sx * CORRIDOR_OUTER_X;
      const rect: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0: pz0, z1: pz1 };
      this.pushCliff(walls, rect, top);
      this.addBox(hash, rect, VOID_Y, top, 'tut_wall');
    }
  }

  /**
   * Chasm 1's **diagonal edges** (2026-09-14 3rd pass, user's decision — 「a collapsed cliff」).
   *
   * An axis-aligned rect cannot hold a diagonal, so `DECKS`' `upper_a` · `upper_b` end at **the position furthest back from the
   * diagonal** (85.8 · 74.9) and **one rotated OBB each** fills the wedge from there to the diagonal. The side faces are therefore
   * complete walls (not a heightfield — `model.ts` head comment) and crossing the edge drops the body straight down.
   *
   * ⚠ It must not be built from stepped tiles: with both edges stepping together the gap narrows at an **inner corner** by one step's
   * height (3.6 − step) and that corner alone becomes a shortcut clearable on foot. A rotated OBB has no corners.
   *
   * The plate overlaps the deck (top face `DECK_UPPER_Y`), but **their collider top faces are equal** so walking is no different;
   * only the drawing is separated by `CHASM_TOP_LIFT`.
   */
  private buildChasmEdges(hash: SpatialHash, bodies: THREE.BufferGeometry[], tex: THREE.CanvasTexture): void {
    // The mesh `rotateY` value: local +X = the diagonal's normal (toward the corridor's +z), local +Z = along the diagonal.
    //   rotateY(θ) sends local +X → (cos θ, −sin θ) · local +Z → (sin θ, cos θ), so at θ = tilt − π/2
    //   +X = (sin tilt, cos tilt) = the normal ✔, +Z = (−cos tilt, sin tilt) = along the diagonal (opposite sign only) ✔
    const yaw = CHASM_TILT - Math.PI / 2;
    const nx = Math.sin(CHASM_TILT), nz = Math.cos(CHASM_TILT);
    const w = CHASM_EDGE.width, len = CHASM_EDGE.halfLen * 2;
    const h = DECK_UPPER_Y - VOID_Y;
    for (const side of [1, -1]) {
      // side +1 = the near side (`upper_a`) · −1 = the far side (`upper_b`). The plate reaches `w` from the diagonal face toward the deck.
      const edgeZ = side > 0 ? CHASM_NEAR_Z : CHASM_NEAR_Z - CHASM_GAP_Z;
      const cx = side * nx * (w / 2);
      const cz = edgeZ + side * nz * (w / 2);
      bodies.push(box(w, h, len, cx, VOID_Y + h / 2, cz, yaw));
      this.addObb(hash, cx, cz, w / 2, len / 2, yaw, VOID_Y, DECK_UPPER_Y, 'tut_deck');
      const top = topQuad(cx, DECK_UPPER_Y + CHASM_TOP_LIFT, cz, w, len, yaw, tex);
      this.group.add(top);
      this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
    }
  }

  /**
   * One side (`sx`) of the **funnel** that joins a stretch whose width changes. It is joined by a single slanted plate so no step rim
   * appears — a rim on the narrowing side pushes a body walking along the wall back in z, which reads as 「stuck」.
   *
   * Two pieces: ① a straight box filling from the wide side's face to the outer face, ② a rotated box reaching `T` outward along the
   * slope. `T` is the perpendicular distance from the slope to the **(wide width, narrow-side z)** corner, `|Δz·Δw| / L`, plus `WALL_T`,
   * so ① and ② overlap and cover the wedge with no gap (the wedge is convex and all three of its corners are inside this band).
   */
  private addFunnel(
    hash: SpatialHash, walls: THREE.BufferGeometry[], sx: number, wA: number, zA: number, wB: number, zB: number,
  ): void {
    const dw = wB - wA, dzv = zB - zA;
    const L = Math.hypot(dw, dzv);
    if (L < 1e-3) return;
    const dx = dw / L, dz = dzv / L;          // slope direction measured on the +x side (the −x side is mirrored at the end)
    const nx = -dz, nz = dx;                  // the normal pointing **outward** from the corridor
    const wHi = Math.max(wA, wB);

    // ① Outer fill
    const inner = sx * wHi, outer = sx * CORRIDOR_OUTER_X;
    const fill: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0: zA, z1: zB };
    walls.push(rectBox(fill, VOID_Y, WALL_TOP_Y));
    this.addBox(hash, fill, VOID_Y, WALL_TOP_Y, 'tut_wall');

    // ② The slanted plate
    const t = Math.abs(dzv * dw) / L + WALL_T;
    const cx = sx * ((wA + wB) / 2 + (nx * t) / 2);
    const cz = (zA + zB) / 2 + (nz * t) / 2;
    const yaw = sx * Math.atan2(dx, dz);      // mesh rotateY — local +Z is the slope direction (mirroring flips the sign)
    const h = WALL_TOP_Y - VOID_Y;
    const len = L + 0.2;                      // slightly long so no floating-point sliver is left at the seam
    walls.push(box(t, h, len, cx, VOID_Y + h / 2, cz, yaw));
    this.addObb(hash, cx, cz, t / 2, len / 2, yaw, VOID_Y, WALL_TOP_Y, 'tut_wall');
  }

  private addBox(hash: SpatialHash, r: Rect, y0: number, top: number, kind: string): void {
    const hx = (r.x1 - r.x0) / 2, hz = (r.z0 - r.z1) / 2;
    const pos = new THREE.Vector3((r.x0 + r.x1) / 2, y0, (r.z0 + r.z1) / 2);
    this.entries.push(hash.addBox(pos, hx, hz, 0, top - y0, kind));
  }

  /**
   * A rotated box collider. ⚠ **`meshYaw` is the mesh's `rotateY` value and `Obstacle.box.yaw` is that value with the sign
   * flipped** — three.js's rotation.y θ sends local +X to `(cos θ, −sin θ)`, while `world/obb.ts`'s convention is the math
   * convention `(cos, sin)` (`extraction/Hull` carries the same comment and does the same thing).
   */
  private addObb(
    hash: SpatialHash, x: number, z: number, halfX: number, halfZ: number, meshYaw: number,
    y0: number, top: number, kind: string,
  ): void {
    this.entries.push(hash.addBox(new THREE.Vector3(x, y0, z), halfX, halfZ, -meshYaw, top - y0, kind));
  }

  /** `cast` defaults to false — decks and cliff walls are **ground**: they receive shadows rather than cast them. */
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
