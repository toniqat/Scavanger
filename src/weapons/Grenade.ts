import * as THREE from 'three';
import {
  GRAVITY, GRENADE_FUSE as SHARED_GRENADE_FUSE, GRENADE_INCENDIARY_BLAST_DAMAGE, GRENADE_INCENDIARY_BLAST_RADIUS, PROP_STEP_UP_MAX, PROP_TOP_MARGIN,
  GRENADE_DAMAGE as SHARED_GRENADE_DAMAGE, GRENADE_PLAYER_DAMAGE_MUL, GRENADE_RADIUS as SHARED_GRENADE_RADIUS,
  PLAYER_HEIGHT, blastDestructibles, blastReachesBody, breakFragileAlong, explosionDamage, type GameContext, type GrenadeView,
} from '@/shared';
import type { WeaponFx } from './fx/WeaponFx';
import type { PlayerDamageSource } from '@/shared';

/**
 * 2026-09-15 (the results screen rework): where a grenade blast's damage to the local player came from —
 * mine / a squadmate's.
 */
const SELF_GRENADE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'self' });
const ALLY_GRENADE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'ally' });

/** Alias of the shared contract value (3 s); kept for the barrel export. */
export const GRENADE_FUSE = SHARED_GRENADE_FUSE;
/**
 * 2026-09-15 (user's decision): the three numbers moved to `data/constants.csv` (radius 6 → **7.2**, ×1.2).
 * The names are a contract the barrel (`@/weapons`) exports, so they stay as aliases of the shared values —
 * not one call site changes.
 */
export const GRENADE_RADIUS = SHARED_GRENADE_RADIUS;
export const GRENADE_DAMAGE = SHARED_GRENADE_DAMAGE;
const BODY_R = 0.08;
const MAX_GRENADES = 8;
/**
 * The cap on how many steps one frame is cut into (`update`'s 2026-09-16 comment). A step is the body diameter
 * 0.16 m, so in a 50 ms frame (the `dt` cap) a full `근력` strength throw (34 × 1.5 = 51 m/s) covers 2.55 m →
 * 16 steps. The cap is twice that — past it the steps only grow longer, nothing stops.
 */
const MAX_SUBSTEPS = 32;
/** Share of the blast damage a player takes (own grenade and, since Phase 7, squadmates' replicas alike). */
const PLAYER_DAMAGE_MUL = GRENADE_PLAYER_DAMAGE_MUL;

interface GrenadeBody {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  fuse: number;
  active: boolean;
  /** Replica of a remote player's grenade: arc/bounce/FX/audio only — no enemy or player damage, no gameplay events. */
  visualOnly: boolean;
  led: THREE.MeshStandardMaterial;
  ledMesh: THREE.Mesh;
  /** Last LED blink state (rising edge → one pooled light pulse). */
  blinkOn: boolean;
  /**
   * 2026-09-15 (B-16): the G-10 incendiary grenade (`ItemDef.grenadeFire`) — the blast is the small
   * `GRENADE_INCENDIARY_BLAST_*` one and a **local** explosion lights a fire zone through
   * `ctx.gadgets.igniteGrenadeFire`. A visual-only replica only takes the small blast.
   */
  fire: boolean;
}

const _n = new THREE.Vector3(), _tmp = new THREE.Vector3(), _prev = new THREE.Vector3(), _probe = new THREE.Vector3();
/**
 * Restitution of a floor · wall bounce (it comes back at this fraction of the normal speed).
 * The 0.4 of the old floor formula `−vn × 1.4`, unchanged.
 */
const BOUNCE_RESTITUTION = 0.4;
/**
 * How far the body is lowered for the push-out query — it puts the 「on top」 boundary at the body's top
 * (`update`'s 2026-09-17 comment).
 */
const PROBE_DROP = PROP_TOP_MARGIN - BODY_R;

/**
 * Pooled frag grenades: arc with gravity, bounce on terrain, fuse, radial damage (enemies + player),
 * explosion FX and events.
 *
 * Perf note: grenades carry NO light of their own. Toggling a `PointLight`'s visibility changes the scene's
 * light count, and three.js then recompiles every lit material (dozens of shader programs) — that was the
 * multi-hundred-ms hitch on every throw and every explosion. The LED pulse and the explosion flash both go
 * through the shared `FlashPool`, whose lights are permanently in the scene (constant light count).
 */
export class GrenadeManager {
  readonly group = new THREE.Group();
  private readonly pool: GrenadeBody[] = [];
  private readonly bodyGeo = new THREE.SphereGeometry(BODY_R, 12, 10);
  private readonly bandGeo = new THREE.CylinderGeometry(BODY_R * 1.02, BODY_R * 1.02, 0.03, 12);
  private readonly capGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.05, 8);
  private readonly ledGeo = new THREE.SphereGeometry(0.012, 6, 6);
  private readonly bodyMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2a, metalness: 0.5, roughness: 0.6 });
  private readonly bandMat = new THREE.MeshStandardMaterial({ color: 0xf2b632, metalness: 0.4, roughness: 0.5 });
  private readonly capMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.8, roughness: 0.4 });

  constructor(private readonly ctx: GameContext, private readonly fx: WeaponFx) {
    this.group.name = 'Grenades';
    for (let i = 0; i < MAX_GRENADES; i++) {
      const mesh = new THREE.Group();
      const body = new THREE.Mesh(this.bodyGeo, this.bodyMat); body.castShadow = true;
      const band = new THREE.Mesh(this.bandGeo, this.bandMat);
      const cap = new THREE.Mesh(this.capGeo, this.capMat); cap.position.y = BODY_R + 0.02;
      const led = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2020, emissiveIntensity: 0 });
      const ledMesh = new THREE.Mesh(this.ledGeo, led); ledMesh.position.set(0, BODY_R + 0.05, 0);
      mesh.add(body, band, cap, ledMesh);
      mesh.visible = false;
      this.group.add(mesh);
      this.pool.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), fuse: 0, active: false, visualOnly: false, led, ledMesh, blinkOn: false, fire: false });
    }
    ctx.scene.add(this.group);
  }

  get activeCount(): number { let n = 0; for (const g of this.pool) if (g.active) n++; return n; }

  /**
   * @param visualOnly replica of a remote player's grenade (multiplayer): same arc, bounce, fuse and
   *   explosion FX/audio and (Phase 7) the same radial damage to the local player, but no `applyExplosion`
   *   (enemy damage is the thrower's) and no `grenade:*` events.
   *   Prefers to evict another visual-only replica when the pool is full so a live local grenade never pops early.
   * @param fuse seconds until the explosion (`GRENADE_FUSE` − cook time for a cooked grenade; 0 → explodes on the next update).
   * @param fire 2026-09-15 (B-16): the G-10 incendiary grenade (`ItemDef.grenadeFire`) — small blast +
   *   (local only) a fire zone on explosion.
   */
  throw(origin: THREE.Vector3, velocity: THREE.Vector3, visualOnly = false, fuse = GRENADE_FUSE, fire = false): boolean {
    let g = this.pool.find((x) => !x.active);
    if (!g) { g = this.pool.find((x) => x.visualOnly) ?? this.pool[0]; this.explode(g); }
    g.active = true;
    g.visualOnly = visualOnly;
    g.fire = fire;
    g.pos.copy(origin); g.vel.copy(velocity);
    g.spin.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
    g.fuse = Math.max(0, fuse);
    g.mesh.visible = true;
    g.mesh.position.copy(origin);
    g.blinkOn = false; g.led.emissiveIntensity = 0;
    if (!visualOnly) this.ctx.bus.emit('grenade:thrown', { position: origin.clone(), velocity: velocity.clone() });
    this.ctx.bus.emit('audio:play', { id: 'grenade_throw', position: origin, volume: 0.7 });
    return true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const world = this.ctx.world;
    for (const g of this.pool) {
      if (!g.active) continue;
      g.fuse -= dt;
      if (g.fuse <= 0) { this.explode(g); continue; }
      if (world && world.ready) {
        /*
         * 2026-09-16 — **it walks in sub-steps** (in the tutorial's last pit a grenade went through the walls ·
         * the floor and fell down the cliff). Moving a whole frame at once leaks in two places:
         *   ① a thin wall — `boxPushOut` pushes out through the **nearest face**, so a step that covers more than
         *      half the thickness + the body (pit wall 0.3 + 0.08 = 0.38 m) comes out the other side. 34 m/s ×
         *      1/60 s = 0.57 m, so a throw straight at it went through even at 60 fps.
         *   ② the floor — when a falling body sinks more than `PROP_TOP_MARGIN` (0.15) below the top face in one
         *      step, `getSurfaceY`'s ceiling (the body's top) misses that floor and `resolveCollision` reads that
         *      floor box as a **wall** and pushes it out sideways — a person, with a feet + 0.9 ceiling, stands
         *      there perfectly well. An arc thrown over the wire fence reaches the pit floor at 11 m/s.
         * So one step is cut to at most the body diameter (`2 × BODY_R`) — it cannot cross a wall, and it never
         * sinks more than a body radius below a floor.
         * The bounce damping · sound · stop · spin damping are **once per frame** (multiplied per step they would
         * stop it as many times sooner as there are steps).
         */
        const dist = g.vel.length() * dt + GRAVITY * dt * dt;
        const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dist / (2 * BODY_R))));
        const h = dt / steps;
        let contact = false, impact = 0;
        for (let s = 0; s < steps; s++) {
          g.vel.y -= GRAVITY * h;
          _prev.copy(g.pos);
          g.pos.addScaledVector(g.vel, h);
          // 2026-09-11: window glass is broken through, not bounced off (`resolveCollision` does not push a
          //   small body out of a broken frame)
          breakFragileAlong(world, _prev, g.pos);
          // 2026-09-11: the floor is not the terrain but **the surface at that spot** — it lands on a building's
          // second floor · a roof · stairs.
          // 2026-09-16: the surface **first**, the push-out after (`CLAUDE.md` §4.4). The ceiling is the body's
          // top at the **higher** of this step's two ends — it catches a floor this step passed, and it still
          // does not bounce up off a ceiling plate overhead.
          const terrain = world.getHeightAt(g.pos.x, g.pos.z);
          const surface = world.getSurfaceY(g.pos.x, g.pos.z, Math.max(_prev.y, g.pos.y) + BODY_R - PROP_STEP_UP_MAX);
          const ground = surface + BODY_R;
          if (g.pos.y < ground) {
            g.pos.y = ground;
            contact = true;
            if (surface > terrain + 0.02) _n.set(0, 1, 0); else world.getNormalAt(g.pos.x, g.pos.z, _n);
            const vn = g.vel.dot(_n);
            // reflect with restitution (friction is applied once per frame below)
            if (vn < 0) { g.vel.addScaledVector(_n, -vn * (1 + BOUNCE_RESTITUTION)); impact = Math.max(impact, -vn); }
          }
          /*
           * 2026-09-17 — **the top face's margin band let them through a wall** (tutorial: they went through the
           * wire fence · the pit walls and fell down the cliff). `resolveCollision` reads a body whose centre is
           * above the top face − `PROP_TOP_MARGIN` (0.15) as 「on top」 and does not push it, while the surface
           * query's ceiling is the body's top (centre + `BODY_R`) — so in the 7 cm band where the centre lies in
           * [top − 0.15, top − 0.08) it is **neither lifted nor pushed**, and a grenade flying horizontally went
           * straight through the upper part of a wall · the wire fence (measured: thrown over the fence close to
           * horizontal it passed just under the top face).
           * So the push-out query asks with the body **lowered** by `PROP_TOP_MARGIN − BODY_R` — the 「on top」
           * boundary becomes body top = top face, and that meshes exactly with the surface query's ceiling (any
           * higher and it was already lifted onto the top face above). Only x · z are taken back from the result.
           */
          _probe.set(g.pos.x, g.pos.y - PROBE_DROP, g.pos.z);
          world.resolveCollision(_probe, BODY_R);
          const px = _probe.x - g.pos.x, pz = _probe.z - g.pos.z;
          const push2 = px * px + pz * pz;
          if (push2 > 1e-10) {
            g.pos.x = _probe.x; g.pos.z = _probe.z;
            /*
             * 2026-09-17 — **they bounce off walls.** Before, only the push-out ran and the velocity stayed, so a
             * grenade clung to the wall and slid down it (the velocity into the wall was still there and bit in
             * again every step). The push-out direction is read as the wall's normal and that component is
             * flipped with the same restitution as a floor bounce (`BOUNCE_RESTITUTION`).
             */
            const inv = 1 / Math.sqrt(push2);
            const nx = px * inv, nz = pz * inv;
            const vn = g.vel.x * nx + g.vel.z * nz;
            if (vn < 0) {
              g.vel.x -= nx * vn * (1 + BOUNCE_RESTITUTION);
              g.vel.z -= nz * vn * (1 + BOUNCE_RESTITUTION);
              contact = true;
              impact = Math.max(impact, -vn);
            }
          }
        }
        if (contact) {
          if (impact > 0) {
            g.vel.multiplyScalar(0.72);   // damp tangential (friction)
            if (impact > 2) this.ctx.bus.emit('audio:play', { id: 'grenade_bounce', position: g.pos, volume: Math.min(1, impact / 12) });
          }
          if (g.vel.lengthSq() < 0.05) g.vel.set(0, 0, 0);
          g.spin.multiplyScalar(0.9);
        }
      } else {
        g.vel.y -= GRAVITY * dt;
        g.pos.addScaledVector(g.vel, dt);
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += g.spin.x * dt; g.mesh.rotation.y += g.spin.y * dt; g.mesh.rotation.z += g.spin.z * dt;
      // beeping LED, faster as the fuse burns down
      const rate = 3 + Math.max(0, GRENADE_FUSE - g.fuse) * 5;
      const blink = Math.max(0, Math.sin(g.fuse * rate * Math.PI)) > 0.6;
      g.led.emissiveIntensity = blink ? 4 : 0;
      if (blink && !g.blinkOn) {
        // rising edge → one short pooled light pulse (no per-grenade light: keeps the scene light count constant)
        g.ledMesh.updateWorldMatrix(true, false);
        _tmp.setFromMatrixPosition(g.ledMesh.matrixWorld);
        this.fx.ledBlink(_tmp);
      }
      g.blinkOn = blink;
    }
  }

  private explode(g: GrenadeBody): void {
    g.active = false; g.mesh.visible = false; g.led.emissiveIntensity = 0; g.blinkOn = false;
    const ctx = this.ctx;
    const pos = g.pos;
    const visualOnly = g.visualOnly;
    g.visualOnly = false;
    // 2026-09-15 (B-16): a G-10 incendiary grenade is not a frag — a small blast lights the fire, the zone
    //   does the real damage
    const fire = g.fire;
    g.fire = false;
    const radius = fire ? GRENADE_INCENDIARY_BLAST_RADIUS : GRENADE_RADIUS;
    const damage = fire ? GRENADE_INCENDIARY_BLAST_DAMAGE : GRENADE_DAMAGE;
    // Visual-only replicas (remote players' grenades) never damage enemies here: the thrower's client resolves
    // that through the host. Phase 7: they DO hurt the local player — same radius / falloff / friendly-fire
    // rule as our own grenades (a squadmate's frag lands on you exactly like your own).
    const kills = !visualOnly && ctx.enemies ? ctx.enemies.applyExplosion(pos, radius, damage) : 0;
    // 2026-09-21 (B-98, user's decision): destructible world objects — dropped cover · window glass · the 탐사 차량.
    //   Behind the same `!visualOnly` gate as the enemy damage: a replica of a squadmate's grenade must not break
    //   the same wall twice, and the vehicle's hostility counter is the thrower's to move.
    if (!visualOnly) blastDestructibles(ctx.world, pos, radius, damage);
    if (ctx.player && !ctx.player.isDead) {
      _tmp.copy(ctx.player.position); _tmp.y += 0.9;
      const d = _tmp.distanceTo(pos);
      // 2026-09-15 (user's decision): self damage · friendly fire take the shared two-step stair too
      //   (`shared/explosion`) — `EXPLOSION_FULL_FRACTION` of the radius at 100 %, the outer band at
      //   `EXPLOSION_OUTER_MUL`
      // 2026-09-18 (user's decision): a grenade that went off beyond a wall · roof · floor does not hit (3 body
      //   points)
      if (d < radius && blastReachesBody(ctx.world, pos, ctx.player.position.x, ctx.player.position.y, ctx.player.position.z, PLAYER_HEIGHT)) {
        const dmg = explosionDamage(damage, d, radius) * PLAYER_DAMAGE_MUL;
        // 2026-09-15 (the results screen rework): my own grenade (one that went off in the hand included) =
        //   `self`, a replica of a squadmate's grenade = `ally`
        if (dmg > 1) ctx.player.takeDamage(dmg, pos.clone(), visualOnly ? ALLY_GRENADE_SOURCE : SELF_GRENADE_SOURCE);
      }
      const shake = THREE.MathUtils.clamp(1 - d / 28, 0, 1) * (fire ? 0.5 : 1);
      if (shake > 0) ctx.bus.emit('camera:shake', { intensity: 0.25 + shake * 0.75, duration: 0.45 });
    }
    this.fx.explosion(pos, radius);
    if (!visualOnly) ctx.bus.emit('grenade:exploded', { position: pos.clone(), radius });
    ctx.bus.emit('audio:play', { id: 'explosion', position: pos, volume: fire ? 0.7 : 1 });
    if (kills > 0) ctx.bus.emit('ui:hitmarker', { kill: true });
    // The fire zone is the thrower's: only a local explosion lights it; replicas get it as `gad spawn` (gadgets is host-authoritative).
    if (fire && !visualOnly) ctx.gadgets?.igniteGrenadeFire?.(pos);
  }

  /** Live grenades for the HUD's off-screen indicators (`ctx.weapons.getGrenades()`). Reuses one view object per pool body. */
  getViews(): readonly GrenadeView[] {
    this.viewList.length = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const g = this.pool[i];
      if (!g.active) continue;
      let v = this.views[i];
      if (!v) { v = { position: g.pos, fuse: 0, remote: false }; this.views[i] = v; }
      v.fuse = g.fuse; v.remote = g.visualOnly;
      this.viewList.push(v);
    }
    return this.viewList;
  }
  private readonly views: Array<{ position: THREE.Vector3; fuse: number; remote: boolean }> = [];
  private readonly viewList: GrenadeView[] = [];

  clear(): void {
    for (const g of this.pool) { g.active = false; g.visualOnly = false; g.fire = false; g.mesh.visible = false; g.led.emissiveIntensity = 0; g.blinkOn = false; }
  }

  dispose(): void {
    this.bodyGeo.dispose(); this.bandGeo.dispose(); this.capGeo.dispose(); this.ledGeo.dispose();
    this.bodyMat.dispose(); this.bandMat.dispose(); this.capMat.dispose();
    for (const g of this.pool) g.led.dispose();
    this.group.removeFromParent();
  }
}
