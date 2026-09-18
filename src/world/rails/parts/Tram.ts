/**
 * src/world/rails/parts/Tram.ts — **the tram body · cab console · placement · collision damage**.
 *
 * A bundle of methods taken out of `Rails` (the 2026-09-10 split). The state lives in the single `TramInst`
 * (`rails/model`); this file builds it, places it every frame and judges who is run over.
 *
 * **Axis convention**: local +X = the travel direction (length `halfLen`), local +Z = sideways (width `halfWid`).
 * `data/structures.csv`'s `tram.halfD` (6) is the half **length** and `tram.halfW` (1.9) the half **width** —
 * before 2026-09-10 the two went into the geometry swapped, hanging **a long plank across the rail**.
 *
 * **There is no roof** (an open car) — the rule that keeps the third-person camera from being trapped, the same judgement
 * as a structure's collapsed roof. Instead the cab is behind the bulkhead with the ignition console in it: the body's inside really is walkable space.
 *
 * ## 2026-09-18 batch (user's decision)
 * - **The body orientation is fixed** — `placeTram`'s yaw is the rail tangent only and does not look at `dir`. The
 *   flipping body teleported riders to the other side of the car (`shared/ride` re-solves the spot in vehicle-local coordinates every frame).
 * - So there is **a cab and an ignition console at each end** (a double-ended shuttle). One procedure (`Rails.applyStart`).
 * - **Cabin containers are gone** — the farming spot is the platform.
 */
import * as THREE from 'three';
import {
  Layers, PLAYER_HEIGHT, PLAYER_RADIUS, RIDE_EDGE_MARGIN, RIDE_FOOT_DROP, TRAM_CONSOLE_RANGE, TRAM_HIT_COOLDOWN_S, TRAM_HIT_DAMAGE,
  TRAM_HIT_FLOOR_CLEAR, TRAM_HIT_KNOCKBACK, TRAM_HIT_REACH, TRAM_HIT_SPEED_MIN, TRAM_SPEED, TRAM_START_HOLD_S,
  type GameContext, type PeerId, type Random, type TramDef,
} from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import type { PlayerDamageSource } from '@/shared';

/** 2026-09-15 (results screen rework): the source of damage from a running tram — the contract's 「physical damage that is not an enemy's, such as a tram collision」 = `explosion`. */
const TRAM_DAMAGE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'explosion' });
import { structureRow } from '../../structures/model';
import type { SpatialHash } from '../../SpatialHash';
import {
  GLASS, SCREEN, STEEL, STEEL_DARK, TRAM_DESK_H, TRAM_DESK_HALF_L, TRAM_DESK_HALF_W,
  TRAM_DOOR_HALF, TRAM_FLOOR_T, TRAM_FLOOR_UP, TRAM_NOSE_T, TRAM_WALL_H, TRAM_WALL_T,
  type RailBuild, type RailPath, type TramInst, sampleAt,
} from '../model';

/* Hot-path scratch — no per-frame allocation (world is single threaded). */
const _pos = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _from = new THREE.Vector3();

/** Builds the body, the colliders and the cab console spots at **both ends**. `Rails` does the `Interactable` registration. */
export function buildTram(
  ctx: BuildCtx, rng: Random, startS: number, startDock: string | null, out: RailBuild,
): TramInst {
  const row = structureRow('tram');
  /** The half **length** (along travel) · half **width** · cabin height — the csv is the source. */
  const halfLen = row ? row.halfD : 6, halfWid = row ? row.halfW : 1.9, wallH = row ? row.wallH : 2.2;
  const parts: THREE.BufferGeometry[] = [];

  // ── Floor · bogies ─────────────────────────────────────────────────
  const floor = new THREE.BoxGeometry(halfLen * 2, TRAM_FLOOR_T, halfWid * 2);
  xform(floor, { x: 0, y: -TRAM_FLOOR_T / 2, z: 0 });
  paintGradient(floor, STEEL_DARK, STEEL);
  parts.push(floor);
  for (const s of [-1, 1]) {
    const bogie = new THREE.BoxGeometry(1.8, 0.4, halfWid * 1.5);
    xform(bogie, { x: s * halfLen * 0.62, y: -0.5, z: 0 });
    paint(bogie, STEEL_DARK, 0.06, rng);
    parts.push(bogie);
  }

  /* ── Side panels (waist high — the open top keeps the camera from being trapped) ──
   * The middle is left open as the **doorway** (it opens along the car's length). Opening both sides is left alone:
   * since 2026-09-18 the body does not flip, so the platform is **always on the local +Z side** (`Rails.build`'s deck
   * centre is left of the tangent and the tram yaw is the tangent), but the opposite doorway is the door onto the rail deck, so it stays. */
  const seg = (k: number): [number, number] => (k < 0 ? [-halfLen, -TRAM_DOOR_HALF] : [TRAM_DOOR_HALF, halfLen]);
  for (const sz of [-1, 1]) {
    for (const k of [-1, 1]) {
      const [x0, x1] = seg(k);
      const len = x1 - x0, mid = (x0 + x1) / 2;
      const w = new THREE.BoxGeometry(len, TRAM_WALL_H, TRAM_WALL_T);
      xform(w, { x: mid, y: TRAM_WALL_H / 2, z: sz * halfWid });
      paintGradient(w, STEEL_DARK, STEEL, 0, TRAM_WALL_H);
      parts.push(w);
      const cap = new THREE.BoxGeometry(len, 0.1, TRAM_WALL_T + 0.1);
      xform(cap, { x: mid, y: TRAM_WALL_H + 0.03, z: sz * halfWid });
      paint(cap, STEEL, 0.05, rng);
      parts.push(cap);
    }
  }

  /* ── Bulkhead + windscreen + driving console at both ends (2026-09-18 — two cabs) ──
   * **Because the body never turns around for the whole raid** (`placeTram`), one end is the tail for half of every
   * run. So the nose · cab · console are built **identically at both ends** (the double-ended layout of a real
   * shuttle) — the old 「front bulkhead + rear railing」 was the shape of a car that turns. Both consoles call
   * **the same ignition procedure** (`Rails.applyStart` — no new wire and no new authority path).
   *
   * `end = +1` is the local +X end, `-1` the −X end. It is the same object turned 180°, so x and z flip together.
   * `TRAM_CAB_LEN` behind the bulkhead is the cab and that space is **empty** — one has to walk in and stand at the console. */
  const deskX = halfLen - TRAM_NOSE_T - TRAM_DESK_HALF_L;
  for (const end of [1, -1] as const) {
    const bulk = new THREE.BoxGeometry(TRAM_NOSE_T, wallH, halfWid * 2);
    xform(bulk, { x: end * (halfLen - TRAM_NOSE_T / 2), y: wallH / 2, z: 0 });
    paintGradient(bulk, STEEL_DARK, STEEL, 0, wallH);
    parts.push(bulk);
    const glass = new THREE.BoxGeometry(0.08, 0.62, halfWid * 1.5);
    xform(glass, { x: end * (halfLen - 0.02), y: wallH * 0.66, z: 0 });
    paint(glass, GLASS);
    parts.push(glass);

    const desk = new THREE.BoxGeometry(TRAM_DESK_HALF_L * 2, TRAM_DESK_H, TRAM_DESK_HALF_W * 2);
    xform(desk, { x: end * deskX, y: TRAM_DESK_H / 2, z: 0 });
    paintGradient(desk, STEEL_DARK, STEEL, 0, TRAM_DESK_H);
    parts.push(desk);
    const screen = new THREE.BoxGeometry(0.46, 0.07, TRAM_DESK_HALF_W * 1.7);
    xform(screen, { x: 0, y: 0, z: 0 }, new THREE.Euler(0, 0, end * 0.5));
    xform(screen, { x: end * (deskX - 0.04), y: TRAM_DESK_H + 0.06, z: 0 });
    paint(screen, SCREEN, 0.06, rng);
    parts.push(screen);
    const lever = new THREE.BoxGeometry(0.1, 0.42, 0.1);
    xform(lever, { x: end * (deskX - 0.06), y: TRAM_DESK_H + 0.2, z: end * TRAM_DESK_HALF_W * 0.55 });
    paint(lever, STEEL, 0.05, rng);
    parts.push(lever);
  }

  const geo = merge(parts);
  out.geos.push(geo);
  const mesh = new THREE.Mesh(geo, out.mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.enable(Layers.PROP);
  // 2026-09-10: give it a name — `scripts/smoke-structures.mjs` compares the bounding boxes of `rail_*` meshes
  // against the box colliders, and the body mesh used to be nameless, so the tram fell out of that check entirely.
  mesh.name = 'rail_tram_body';
  const root = new THREE.Group();
  root.name = 'tram';
  root.add(mesh);
  out.group.add(root);

  const vel = new THREE.Vector3();
  const def: TramDef = {
    id: 'tram_rail_0', lineId: 'rail_0',
    position: new THREE.Vector3(), yaw: 0, state: 'idle', s: startS, dir: 1,
  };
  const inst: TramInst = {
    def, root, parts: [], vel, consolePos: [new THREE.Vector3(), new THREE.Vector3()],
    halfLen, halfWid, wallH,
    dockTimer: 0, runT: 0, lastDock: startDock, targetS: startS, hitUntil: new Map(),
  };

  /* Colliders: one floor (= the deck) + four side panels + two end bulkheads + two console desks. All are
   * `Obstacle.box` and their `velocity` shares **one vector object** — fix that one per frame and the deck query sees the new speed at once. */
  const addPart = (ox: number, oz: number, oy: number, hx: number, hz: number, h: number): void => {
    const entry = ctx.hash.addBox(new THREE.Vector3(0, -9999, 0), hx, hz, 0, h, 'tram');
    entry.velocity = vel;
    inst.parts.push({ entry, ox, oz, oy });
  };
  addPart(0, 0, -TRAM_FLOOR_T, halfLen, halfWid, TRAM_FLOOR_T);                       // floor (top face = the tram floor)
  for (const sz of [-1, 1]) for (const k of [-1, 1]) {
    const [x0, x1] = seg(k);
    addPart((x0 + x1) / 2, sz * halfWid, 0, (x1 - x0) / 2, TRAM_WALL_T / 2, TRAM_WALL_H);
  }
  for (const end of [1, -1] as const) {
    addPart(end * (halfLen - TRAM_NOSE_T / 2), 0, 0, TRAM_NOSE_T / 2, halfWid, wallH);   // the end bulkheads
    addPart(end * deskX, 0, 0, TRAM_DESK_HALF_L, TRAM_DESK_HALF_W, TRAM_DESK_H);         // the console desk in front of it
  }

  /* 2026-09-18 (user's decision): **cabin containers are gone.** Nobody reads `structures.csv`'s `tram.containers`
   * any more (the column and its value stay, by the retirement rule — `rail_platform` still reads the same column).
   * The platform deck's containers (`parts/Platform`) are unchanged: the tram is transport, the platform is the farming spot. */

  return inst;
}

/**
 * Re-places the tram, its colliders and its consoles at `s`. `speed` is the deck speed (m/s, 0 = standing).
 *
 * **It takes no snapshot** — the riding side (`player/PlayerController`) re-reads the `entry.position` and
 * `box.yaw` fixed here every frame to solve its own spot (the same reason the ship interior broke on a snapshot).
 */
export function placeTram(inst: TramInst, path: RailPath, speed: number, hash: SpatialHash | null): void {
  sampleAt(path, inst.def.s, _pos, _tan);
  /* 2026-09-18 (user's decision) — **it does not look at `dir`.** The body orientation is the rail tangent alone
   * and is fixed for the whole raid: forwards one way, backwards on the way back, always standing facing the same
   * way at every platform. It used to be `+ (dir < 0 ? Math.PI : 0)`, which **flipped the body 180° in place**, and
   * since a rider re-solves its spot in vehicle-local coordinates every frame (`shared/ride`) it teleported to the
   * other side of the car on departure. `dir` itself still flips — `s` · `vel` · the knockback direction · `TramWire` read it. */
  const yaw = Math.atan2(_tan.z, _tan.x);
  const fy = _pos.y + TRAM_FLOOR_UP;
  inst.def.position.set(_pos.x, fy, _pos.z);
  inst.def.yaw = yaw;
  inst.root.position.set(_pos.x, fy, _pos.z);
  inst.root.rotation.y = -yaw;
  inst.vel.set(_tan.x * speed * inst.def.dir, 0, _tan.z * speed * inst.def.dir);

  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Local +X = length (travel), local +Z = width. The mesh is Euler(0, −yaw, 0), so +X → (cos, sin), +Z → (−sin, cos).
  for (const p of inst.parts) {
    const wx = _pos.x + p.ox * c - p.oz * s;
    const wz = _pos.z + p.ox * s + p.oz * c;
    hash?.move(p.entry, wx, fy + p.oy, wz, yaw);
  }
  {
    // Where one stands at the console = one step inwards from the desk. `Interactable.position` is these objects.
    // 2026-09-18: one at each end (index 0 = the local +X end, 1 = the −X end).
    const ox = inst.halfLen - TRAM_NOSE_T - TRAM_DESK_HALF_L * 2 - 0.35;
    inst.consolePos[0].set(_pos.x + ox * c, fy + 1.0, _pos.z + ox * s);
    inst.consolePos[1].set(_pos.x - ox * c, fy + 1.0, _pos.z - ox * s);
  }
}

/**
 * **Being hit by a running tram costs damage + knockback** (2026-09-10).
 *
 * It is dangerous **only while fast**: below `TRAM_HIT_SPEED_MIN` nothing happens, and above it both the damage and
 * the knockback scale with `speed / TRAM_SPEED` (docking and the slow stretch right after departure are safe).
 *
 * **Riders are not hit.** The judgement runs only while the feet are more than `TRAM_HIT_FLOOR_CLEAR` below the tram
 * floor (`def.position.y`) — someone standing on the deck, and someone on the platform (at the same height), drop out
 * on that one line, leaving only bodies on the rail deck (`TRAM_FLOOR_UP` 0.35 m below the floor) or on bare ground.
 *
 * **Host / replica**: the tram's state (`s` · `dir` · state) is host-authoritative and already synchronised, so each
 * client judges **its own player only** (the same philosophy as the `Hazard` — no new wire is created).
 * So nobody is hit on someone else's screen, and nobody escapes on their own screen alone.
 *
 * ## 2026-09-11 (C-18) — enemies and disconnected squadmates are hit too
 * - **The authority (single player · host)** alone sweeps the enemies around the body with `ctx.enemies.queryNear` and
 *   runs the same OBB · height-band judgement → `EnemyRef.takeDamage(…, 'ai')` (no kill credit) + `EnemyManagerRef.pushBack`
 *   (on that one enemy, along `dir`). The tram is seed deterministic and `s` synchronised, so a host judgement reaches the replicas through enemy snapshots and `ee damaged`.
 * - **A disconnected squadmate (a ghost, `suspended`)** has its body simulated by the authority, so the same
 *   judgement → `ghost:damage {kb}`. A ghost is a player body, so its foot-height rule is the player's.
 * - ~~A riding enemy is not hit: inside the body OBB, feet at or above the deck top − `RIDE_FOOT_DROP` mean a rider~~
 *   → narrowed in C-63 (below). That window reached the rail deck (floor − `TRAM_FLOOR_UP` 0.35) and **an enemy standing on the rail went unhit.**
 * - The cooldown is **per target** (`TramInst.hitUntil`). The sound is a dedicated `tram_hit` (defined in `audio/`).
 *
 * ## 2026-09-11 (C-63) — the exemption is for bodies actually riding, and no others
 * The local player, enemies and disconnected squadmates all use **one rule** (`riderExempt`):
 * - Feet above floor − `TRAM_HIT_FLOOR_CLEAR` = the deck, or a platform at player height → not hit (the 2026-09-10 line unchanged).
 * - The `RIDE_FOOT_DROP` band below it (floor −0.18 … −0.7 — the rail deck is in here) is exempted only inside the body
 *   cross-section + `RIDE_EDGE_MARGIN` **and when what is underfoot is not a static deck** — underfoot being a part of this
 *   tram (`velocity === inst.vel`, its parts share one velocity vector) or nothing (a rider sagging on a slope or a frame wobble) is a rider; a body on the rail deck is hit.
 * An enemy's riding state is still never asked of `EnemyRef` — the underfoot query is answered by world itself. The
 * order is this folder's `update` (world) → player · enemies, so a body is at its position one frame ago, but the
 * deck-height line filters first, so a lagging rider is never hit.
 */
export function updateTramHit(game: GameContext | null, inst: TramInst, speed: number): void {
  // No dt — every cooldown here is an absolute deadline read off `game.time` (`TramInst.hitUntil`).
  if (!game || speed < TRAM_HIT_SPEED_MIN) return;
  const now = game.time;
  const hitUntil = inst.hitUntil;
  if (hitUntil.size > 24) for (const [k, until] of hitUntil) if (until <= now) hitUntil.delete(k);

  const t = Math.min(1, speed / Math.max(0.001, TRAM_SPEED));
  const floorY = inst.def.position.y;
  const c = Math.cos(inst.def.yaw), s = Math.sin(inst.def.yaw);

  // ── The local player — each client judges its own body only (2026-09-10, unchanged) ──
  const player = game.player;
  if (player && !player.isDead && !player.isInShip && !player.isDropping && game.isGameplayActive()
    && (hitUntil.get('local') ?? -Infinity) <= now) {
    const p = player.position;
    const side = riderExempt(game, inst, p.x, p.y, p.z)
      ? 0 : hitSide(inst, c, s, p.x, p.y, p.z, PLAYER_RADIUS, floorY - TRAM_HIT_FLOOR_CLEAR, floorY - TRAM_HIT_REACH);
    if (side !== 0) {
      hitUntil.set('local', now + TRAM_HIT_COOLDOWN_S);
      knockDir(c, s, side, inst.def.dir);
      game.bus.emit('audio:play', { id: 'tram_hit', position: p, volume: 0.9 });
      player.applyKnockback(_kb, TRAM_HIT_KNOCKBACK * t);
      player.takeDamage(TRAM_HIT_DAMAGE * t, inst.def.position, TRAM_DAMAGE_SOURCE);   // 2026-09-15: physical damage, not from an enemy
    }
  }

  // ── The authority: enemies · disconnected squadmates ──────────────────────
  const net = game.net;
  if (game.isMultiplayer && net && !net.isHost) return;
  if (!game.isGameplayPhase()) return;

  const enemies = game.enemies;
  if (enemies) {
    const near = enemies.queryNear(inst.def.position, Math.hypot(inst.halfLen, inst.halfWid) + TRAM_HIT_REACH + 3);
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      if (e.isDead) continue;
      const key = `e:${e.id}`;
      if ((hitUntil.get(key) ?? -Infinity) > now) continue;
      /* Foot-height window: top = floor − `TRAM_HIT_FLOOR_CLEAR` (the same as the player — the riding band below it is
       * `riderExempt`, C-63); bottom = does the body **top** reach the head spot of the player rule (floor − (TRAM_HIT_REACH − PLAYER_HEIGHT))? Bugs are small, a behemoth is large. */
      const lowFoot = floorY - (TRAM_HIT_REACH - PLAYER_HEIGHT) - e.height;
      const ep = e.position;
      if (riderExempt(game, inst, ep.x, ep.y, ep.z)) continue;
      const side = hitSide(inst, c, s, ep.x, ep.y, ep.z, e.radius, floorY - TRAM_HIT_FLOOR_CLEAR, lowFoot);
      if (side === 0) continue;
      hitUntil.set(key, now + TRAM_HIT_COOLDOWN_S);
      knockDir(c, s, side, inst.def.dir);
      game.bus.emit('audio:play', { id: 'tram_hit', position: e.position, volume: 0.9 });
      // Pushes that one enemy only — the radius is narrowed inside the body and a direction given (pushBack reaches radius + body radius)
      enemies.pushBack(_from.copy(e.position), 0.05, TRAM_HIT_KNOCKBACK * t, _kb);
      e.takeDamage(TRAM_HIT_DAMAGE * t, undefined, _kb, 'ai');
    }
  }

  if (!net) return;
  const refs = net.getRemotePlayers();   // an empty list in single player
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!r.suspended || !r.inMission || r.isDead || r.ghostState === 2) continue;
    const key = `g:${r.id}`;
    if ((hitUntil.get(key) ?? -Infinity) > now) continue;
    const rp = r.position;
    if (riderExempt(game, inst, rp.x, rp.y, rp.z)) continue;
    const side = hitSide(inst, c, s, rp.x, rp.y, rp.z, PLAYER_RADIUS, floorY - TRAM_HIT_FLOOR_CLEAR, floorY - TRAM_HIT_REACH);
    if (side === 0) continue;
    hitUntil.set(key, now + TRAM_HIT_COOLDOWN_S);
    knockDir(c, s, side, inst.def.dir);
    game.bus.emit('audio:play', { id: 'tram_hit', position: r.position, volume: 0.9 });
    game.bus.emit('ghost:damage', {
      id: r.id as PeerId, amount: TRAM_HIT_DAMAGE * t, from: inst.def.position.clone(),
      kb: { direction: _kb.clone(), speed: TRAM_HIT_KNOCKBACK * t },
    });
  }
}

/**
 * Inside the body OBB (+`radius`) with the feet within `[footMin, footMax]`: **which side of the rail** (+1 / −1),
 * else 0. Above `footMax` are riders and people on a platform; below `footMin` is under the tram.
 */
function hitSide(
  inst: TramInst, c: number, s: number, x: number, y: number, z: number, radius: number, footMax: number, footMin: number,
): number {
  if (y > footMax || y < footMin) return 0;
  const dx = x - inst.def.position.x, dz = z - inst.def.position.z;
  const lx = dx * c + dz * s, lz = -dx * s + dz * c;
  if (Math.abs(lx) > inst.halfLen + radius || Math.abs(lz) > inst.halfWid + radius) return 0;
  return lz >= 0 ? 1 : -1;
}

/**
 * C-63: is a body in the `RIDE_FOOT_DROP` band below deck height **riding this tram**? Outside the band false (above
 * deck height `hitSide`'s `footMax` already filters; below it is beside the rail, on bare ground). Inside it, a rider is
 * a body within `shared/ride.rideContains`'s volume (cross-section + `RIDE_EDGE_MARGIN`) **whose underfoot is not a static deck**:
 * - The deck underfoot (`getStandingObstacle`, top face ±`PROP_TOP_MARGIN`) is a part of this tram (`velocity === inst.vel`) → a rider.
 * - Nothing underfoot → a rider sagging a little below the deck on a slope or a frame wobble (the only static surface at that height is the rail deck).
 * - A **static deck** underfoot, such as the rail deck → a body standing on the rail beside or ahead of the tram — it is hit (the gap C-63 closed).
 */
function riderExempt(game: GameContext, inst: TramInst, x: number, y: number, z: number): boolean {
  const floorY = inst.def.position.y;
  if (y > floorY - TRAM_HIT_FLOOR_CLEAR || y < floorY - RIDE_FOOT_DROP) return false;
  const c = Math.cos(inst.def.yaw), s = Math.sin(inst.def.yaw);
  const dx = x - inst.def.position.x, dz = z - inst.def.position.z;
  if (Math.abs(dx * c + dz * s) > inst.halfLen + RIDE_EDGE_MARGIN || Math.abs(-dx * s + dz * c) > inst.halfWid + RIDE_EDGE_MARGIN) return false;
  const w = game.world;
  if (!w || !w.ready) return false;
  const o = w.getStandingObstacle(x, z, y);
  return !o || o.velocity === inst.vel;
}

/**
 * Writes into `_kb` the direction that pushes forwards while throwing the body **off the rail** — pushing straight forwards alone keeps hitting it.
 *
 * 2026-09-18: "forwards" = **the travel direction**, so `dir` is multiplied in. While the body yaw flipped with `dir`,
 * local +X was the travel direction; now the orientation is fixed, so running backwards local +X points at the tail
 * (`placeTram`). The sideways `side` is the side the body is already on, so it is unchanged.
 */
function knockDir(c: number, s: number, side: number, dir: number): void {
  _kb.set(c * 0.7 * dir - s * side, 0, s * 0.7 * dir + c * side).normalize();
}

/** The cab console's interaction radius and hold time come from the contract (csv) — `Rails` uses them when registering. */
export const TRAM_CONSOLE = { radius: TRAM_CONSOLE_RANGE, holdTime: TRAM_START_HOLD_S } as const;
