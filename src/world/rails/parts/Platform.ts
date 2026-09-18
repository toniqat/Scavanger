/**
 * src/world/rails/parts/Platform.ts — **the rail platform** (deck · stairs · railings · containers · sign).
 *
 * A bundle of methods taken out of `Rails`, with no state (the 2026-09-10 split).
 * The axis convention is `rails/model`'s: **local +X = the rail tangent (the platform's length `halfW`), local +Z =
 * sideways (its depth `halfD`)**. `PLATFORM_OFFSET` being `halfD + tram.halfW + 0.05` follows from that convention.
 *
 * **2026-09-10 — the ignition console is not here.** Tram ignition moved to the cab console (`parts/Tram`).
 *
 * **2026-09-10 (second) — the pole in its place is the 「전차 호출」 console.** The price of moving the ignition into
 * the car was that there was no way left to call the tram from a platform (standing on the far one meant walking the
 * rail). This console **only calls** — actually departing still means boarding and pressing the cab console.
 * `Rails`, which holds the state machine, does the `Interactable` registration; here only the **visible object**
 * (plinth · body · screen · buttons · glow band) and its collider are built, and **the console spot is handed back**.
 */
import * as THREE from 'three';
import { Layers, PROP_STEP_UP_MAX, RAIL_STAIR_DEPTH, RAIL_STAIR_MAX_RISE, type Random, type RailPlatformDef } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import { buildStairFlight } from '../../structures/parts/Stairs';
import type { ContainerSpec } from '../../structures/parts/Containers';
import { pickTier, type structureRow } from '../../structures/model';
import { DECK, DECK_DARK, STEEL, STEEL_DARK, type RailBuild } from '../model';

/**
 * One platform. The deck is **a lump rising out of the ground** (nobody ever goes under it) and its top face is
 * level with the tram floor — a docked tram is boarded on foot with no gap.
 */
export function buildPlatform(
  ctx: BuildCtx, rng: Random, def: RailPlatformDef,
  row: ReturnType<typeof structureRow>, groundY: number, deckTop: number, yaw: number,
  ax: number, az: number, specs: ContainerSpec[], out: RailBuild,
): THREE.Vector3 {
  const halfW = row ? row.halfW : 7, halfD = row ? row.halfD : 4.5;
  const parts: THREE.BufferGeometry[] = [];
  const { x: cx, z: cz } = def.position;
  const deckH = Math.max(0.4, deckTop - groundY);

  // The deck
  const deck = new THREE.BoxGeometry(halfW * 2, deckH, halfD * 2);
  xform(deck, { x: cx, y: deckTop - deckH / 2, z: cz }, new THREE.Euler(0, -yaw, 0));
  paintGradient(deck, DECK_DARK, DECK, deckTop - deckH, deckTop);
  parts.push(deck);
  ctx.hash.addBox(new THREE.Vector3(cx, deckTop - deckH, cz), halfW, halfD, yaw, deckH, 'platform');

  buildStairs(ctx, rng, parts, cx, cz, yaw, ax, az, halfD, groundY, deckTop);

  // Outer railing · roof columns (silhouette only — they do not block the camera)
  for (let i = -1; i <= 1; i += 2) {
    const g = new THREE.BoxGeometry(0.28, 2.6, 0.28);
    const px = cx + ax * (halfD - 0.5) + Math.cos(yaw) * (halfW - 0.8) * i;
    const pz = cz + az * (halfD - 0.5) + Math.sin(yaw) * (halfW - 0.8) * i;
    xform(g, { x: px, y: deckTop + 1.3, z: pz }, new THREE.Euler(0, -yaw, 0));
    paint(g, STEEL_DARK, 0.06, rng);
    parts.push(g);
  }
  {
    const rail = new THREE.BoxGeometry(halfW * 2, 0.14, 0.16);
    const px = cx + ax * (halfD - 0.25), pz = cz + az * (halfD - 0.25);
    xform(rail, { x: px, y: deckTop + 1.0, z: pz }, new THREE.Euler(0, -yaw, 0));
    paint(rail, STEEL, 0.05, rng);
    parts.push(rail);
  }

  /* ── The 「전차 호출」 console ──────────────────────────────────────────────
   * The spot where the old ignition console, and the sign after it, used to stand (the rail-side deck edge, at one end).
   * It is a thing you operate, so **it has to look like one** — plinth · body · a tilted screen · two buttons · a
   * glow band around the body. The glow pieces are handed over in `out.glow` and `Rails` merges them into **one
   * emissive mesh** (no extra mesh per platform). */
  const conX = cx + Math.cos(yaw) * (halfW - 1.2) - ax * (halfD - 1.0);
  const conZ = cz + Math.sin(yaw) * (halfW - 1.2) - az * (halfD - 1.0);
  {
    /** Console local offset → world. `ox` = along the rail, `oz` = into the deck (the side the player stands on), `tilt` = tilt about the local X axis. */
    const put = (g: THREE.BufferGeometry, ox: number, oy: number, oz: number, tilt = 0): THREE.BufferGeometry => {
      if (tilt) xform(g, undefined, new THREE.Euler(tilt, 0, 0));
      return xform(g, {
        x: conX + Math.cos(yaw) * ox + ax * oz,
        y: deckTop + oy,
        z: conZ + Math.sin(yaw) * ox + az * oz,
      }, new THREE.Euler(0, -yaw, 0));
    };

    const plinth = put(new THREE.BoxGeometry(0.9, 0.18, 0.56), 0, 0.09, 0);
    paint(plinth, DECK_DARK, 0.05, rng);
    parts.push(plinth);

    const body = put(new THREE.BoxGeometry(0.8, 0.95, 0.5), 0, 0.655, 0);
    paintGradient(body, STEEL_DARK, STEEL, deckTop + 0.18, deckTop + 1.13);
    parts.push(body);

    // The tilted screen frame — laid back at the angle one looks down from standing (0.5 rad).
    const head = put(new THREE.BoxGeometry(0.74, 0.44, 0.14), 0, 1.28, 0.1, -0.5);
    paint(head, STEEL_DARK, 0.05, rng);
    parts.push(head);

    // Glow: the screen · the body band · two buttons (the frame's front normal = (0, sin 0.5, cos 0.5))
    out.glow.push(put(new THREE.BoxGeometry(0.6, 0.32, 0.03), 0, 1.323, 0.179, -0.5));
    out.glow.push(put(new THREE.BoxGeometry(0.72, 0.05, 0.02), 0, 1.06, 0.255));
    for (const sx of [-1, 1]) out.glow.push(put(new THREE.BoxGeometry(0.09, 0.09, 0.03), sx * 0.19, 0.86, 0.255));

    // The collider = the visible silhouette. The radius is the widest piece's corner sweep, the plinth's (hypot(0.45, 0.28) = 0.53).
    ctx.hash.add(new THREE.Vector3(conX, deckTop, conZ), 0.53, 1.5, 'sign');
  }

  const geo = merge(parts);
  out.geos.push(geo);
  const mesh = new THREE.Mesh(geo, out.mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(Layers.PROP);
  mesh.name = `rail_${def.id}`;
  out.group.add(mesh);

  // Containers (on the deck, pushed against the side away from the rail)
  const count = row ? row.containers : 4;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1) - 0.5) * (halfW * 2 - 2.4);
    const px = cx + Math.cos(yaw) * t + ax * (halfD - 1.1);
    const pz = cz + Math.sin(yaw) * t + az * (halfD - 1.1);
    specs.push({
      id: `${def.id}_c${i}`, position: new THREE.Vector3(px, deckTop, pz), yaw: yaw + Math.PI / 2,
      tier: pickTier(row ? row.tiers : [], rng.next()), style: (i % 3) as 0 | 1 | 2,
      zoneId: def.id, zoneKind: 'platform',
    });
  }

  /* Where one stands at the call console (chest height). `Rails` hangs the `Interactable` here. */
  return new THREE.Vector3(conX, deckTop + 1.0, conZ);
}

/**
 * **The platform stairs** (reworked 2026-09-10).
 *
 * The step count used to be nailed to `4`. The deck height (`deckH`) differs per spot because of the rail lifting
 * pass (over 3 m on a stretch crossing a hill), and with a fixed step count one step's rise goes past
 * `PROP_STEP_UP_MAX` (0.9) and **the stairs become a wall** — "stairs that do not work as stairs".
 *
 * Now **one step's rise is held at or below `RAIL_STAIR_MAX_RISE` and the count derived from it.** The base plane is
 * taken against **the outside terrain the stairs actually land on**, not the pad height (stairs reaching past the pad
 * onto dropped terrain leave only the last step unusually tall). Each step's box rises out of its own terrain, so none float.
 */
function buildStairs(
  ctx: BuildCtx, rng: Random, parts: THREE.BufferGeometry[],
  cx: number, cz: number, yaw: number, ax: number, az: number,
  halfD: number, groundY: number, deckTop: number,
): void {
  const depth = Math.max(0.4, RAIL_STAIR_DEPTH);
  const riseMax = Math.max(0.15, Math.min(RAIL_STAIR_MAX_RISE, PROP_STEP_UP_MAX));
  const offsetOf = (i: number): number => halfD + depth / 2 + i * depth;

  // Step count and base plane are solved together — more steps reach further out, and lower terrain there adds more steps again.
  let n = Math.max(2, Math.ceil(Math.max(0.4, deckTop - groundY) / riseMax));
  let baseY = groundY;
  for (let pass = 0; pass < 3; pass++) {
    const far = offsetOf(Math.max(0, n - 2));
    const gy = ctx.terrain.getHeightAt(cx + ax * far, cz + az * far);
    const b = Math.min(groundY, gy);
    const need = Math.max(2, Math.ceil(Math.max(0.4, deckTop - b) / riseMax));
    if (need === n && b === baseY) break;
    n = need; baseY = b;
  }
  const total = Math.max(0.4, deckTop - baseY);
  void total;

  /* 2026-09-11 — **a ramp collider** (`structures/parts/Stairs`). The steps are still drawn as lumps rising out of the
   * terrain, but what is walked on is one ramp from the deck edge (`halfD`) to the far end (`halfD + n × depth`) — no
   * jumping up a step at a time (user's request, "stairs that glide"). The count `n` only decides **how far they reach**. */
  buildStairFlight(ctx, parts, rng, {
    // The ramp reaches a hand's width into the deck — with the seam on exactly the same line a foot can fall through on floating-point error
    hx: cx + ax * (halfD - 0.08), hz: cz + az * (halfD - 0.08), ux: ax, uz: az,
    width: 4.4, run: n * depth + 0.08, topY: deckTop, bottomY: baseY,
    solidY: (x, z) => ctx.terrain.getHeightAt(x, z),
    dark: DECK_DARK, light: DECK, kind: 'platform',
  });
}
