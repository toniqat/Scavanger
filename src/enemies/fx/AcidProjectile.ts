import * as THREE from 'three';
import { GRAVITY, Layers, PLAYER_HEIGHT, PLAYER_RADIUS, type EnemyFaction, type GameContext } from '@/shared';
import { SPEWER_SPIT } from '../EnemyTypes';
import type { Enemy } from '../Enemy';
import type { CombatTarget, TargetList } from '../Targets';
import type { BloodFX } from './BloodFX';

const POOL = 14;
const GLOB_RADIUS = 0.22;
const MAX_LIFE = 4;

export interface AcidSlow { duration: number; factor: number }

/** What the acid needs from EnemySystem: the player list and a damage sink (no-op on replicas). */
export interface AcidHost {
  readonly ctx: GameContext;
  readonly targets: TargetList;
  /** 2026-09-11 (C-48 · X-5): every active enemy — a glob also splashes enemies of the other faction (rogues). */
  readonly active: readonly Enemy[];
  /** The shooter by id (its faction decides who the glob may hurt), or undefined once it despawned. */
  find(id: number): Enemy | undefined;
  /** Apply acid damage + slow to a player (local → ctx.player, remote → dmg message). Replicas ignore it. */
  damageTargetAcid(target: CombatTarget, amount: number, from: THREE.Vector3, shooterId: number, slow: AcidSlow): void;
}

interface Glob {
  mesh: THREE.Mesh;
  active: boolean;
  readonly vel: THREE.Vector3;
  readonly prev: THREE.Vector3;
  life: number;
  shooterId: number;
  /** 2026-09-11 (X-5): faction of the shooter at launch — the glob hurts enemies of the **other** faction only. */
  faction: EnemyFaction;
  /** Enemy id the glob struck directly (the splash skips it), −1 = none. */
  directEnemy: number;
  /** 2026-09-13: the glob struck the rover hull directly (the splash skips it). */
  directVehicle: boolean;
}

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * Pooled arcing acid globs fired by spewers. Tests against terrain/obstacles (world raycast) and every alive
 * player's capsule; damage goes through `AcidHost.damageTargetAcid` so the same code renders host-side (with damage)
 * and replica-side (visual only, from `ee acid` events).
 */
export class AcidProjectiles {
  private readonly globs: Glob[] = [];
  private readonly geo = new THREE.SphereGeometry(GLOB_RADIUS, 10, 8);
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x9fe64a, emissive: 0x5ab81c, emissiveIntensity: 1.4, roughness: 0.3, transparent: true, opacity: 0.92 });

  constructor(private readonly scene: THREE.Scene, private readonly fx: BloodFX) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.visible = false;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.globs.push({ mesh, active: false, vel: new THREE.Vector3(), prev: new THREE.Vector3(), life: 0, shooterId: -1, faction: 'bug', directEnemy: -1, directVehicle: false });
    }
  }

  /**
   * Launch a glob from `from` toward the target's predicted position with a ballistic arc.
   * 2026-09-11 (C-48): `outAim` receives the resolved aim point (feet, after the lead / body-height correction) — the
   * host sends it as `ee acidAt.to` for targets the `ee acid` event cannot name.
   */
  fire(from: THREE.Vector3, target: CombatTarget, shooterId: number, outAim?: THREE.Vector3, faction?: EnemyFaction): boolean {
    _aim.copy(target.position).addScaledVector(target.velocity, THREE.MathUtils.clamp(from.distanceTo(target.position) / 15, 0.7, 1.5) * 0.6);
    // 2026-09-11: `fireAt` aims at the feet + PLAYER_HEIGHT/2 — a target of a different body height (a drone) is lowered by that difference. 0 for a player.
    _aim.y += (target.bodyHeight - PLAYER_HEIGHT) * 0.5;
    if (outAim) outAim.copy(_aim);
    return this.fireAt(from, _aim, shooterId, faction);
  }

  /**
   * Launch toward an explicit point (replica visual from `ee acid` / `ee acidAt`; the host already resolved the aim).
   * `faction` = the shooter's (default `'bug'` — only spewers spit); the glob hurts the other faction.
   */
  fireAt(from: THREE.Vector3, aimFeet: THREE.Vector3, shooterId: number, faction: EnemyFaction = 'bug'): boolean {
    let g: Glob | null = null;
    for (const c of this.globs) if (!c.active) { g = c; break; }
    if (!g) return false;
    g.faction = faction;
    g.directEnemy = -1;
    g.directVehicle = false;
    const dist = from.distanceTo(aimFeet);
    const T = THREE.MathUtils.clamp(dist / 15, 0.7, 1.5);
    _aim.copy(aimFeet);
    _aim.y += PLAYER_HEIGHT * 0.5;
    // a little inaccuracy so the player can dodge
    _aim.x += (Math.random() - 0.5) * 1.4;
    _aim.z += (Math.random() - 0.5) * 1.4;
    _d.subVectors(_aim, from);
    g.vel.set(_d.x / T, _d.y / T + 0.5 * GRAVITY * T, _d.z / T);
    g.mesh.position.copy(from);
    g.prev.copy(from);
    g.life = 0;
    g.shooterId = shooterId;
    g.active = true;
    g.mesh.visible = true;
    return true;
  }

  update(dt: number, host: AcidHost): void {
    const world = host.ctx.world;
    const players = host.targets.alive;
    for (const g of this.globs) {
      if (!g.active) continue;
      g.life += dt;
      g.prev.copy(g.mesh.position);
      g.vel.y -= GRAVITY * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      const s = 1 + Math.sin(g.life * 18) * 0.12;
      g.mesh.scale.set(s, 1 / s, s);

      let splashed = false;
      // player capsules: segment feet→head
      for (let i = 0; i < players.length && !splashed; i++) {
        const t = players[i];
        _p.copy(t.position);
        _p.y = THREE.MathUtils.clamp(g.mesh.position.y, _p.y + PLAYER_RADIUS, _p.y + PLAYER_HEIGHT - PLAYER_RADIUS);
        if (_p.distanceToSquared(g.mesh.position) <= (PLAYER_RADIUS + GLOB_RADIUS) ** 2) {
          host.damageTargetAcid(t, SPEWER_SPIT.damage, g.prev, g.shooterId, { duration: SPEWER_SPIT.slowDuration, factor: 0.55 });
          splashed = true;
        }
      }
      // 2026-09-15 (android squadmates): **the same capsule** as a person — acid does not simply pass through an android (damage on the authority only).
      const allies = host.targets.allies;
      for (let i = 0; i < allies.length && !splashed; i++) {
        const t = allies[i];
        if (t.isDeadOrDowned) continue;
        _p.copy(t.position);
        _p.y = THREE.MathUtils.clamp(g.mesh.position.y, _p.y + PLAYER_RADIUS, _p.y + PLAYER_HEIGHT - PLAYER_RADIUS);
        if (_p.distanceToSquared(g.mesh.position) <= (PLAYER_RADIUS + GLOB_RADIUS) ** 2) {
          host.damageTargetAcid(t, SPEWER_SPIT.damage, g.prev, g.shooterId, { duration: SPEWER_SPIT.slowDuration, factor: 0.55 });
          splashed = true;
        }
      }
      // 2026-09-11 (C-48 · X-5): the body capsule of an enemy of another faction (= a rogue) stops it too — bug acid used to pass straight through a rogue.
      // Damage on the authority only (`damageTargetAcid` → the enemy branch of `applyDamage`, no kill credit). A replica only stops the visual.
      if (!splashed) {
        const e = this.enemyAt(g, host);
        if (e) {
          g.directEnemy = e.id;
          host.damageTargetAcid(e.asTarget, SPEWER_SPIT.damage, g.prev, g.shooterId, { duration: SPEWER_SPIT.slowDuration, factor: 0.55 });
          splashed = true;
        }
      }
      // 2026-09-11: the body of an aggroable drone (the proxy `position` = its underside; a flat body is a sphere at the centre). Damage on the authority only.
      const drones = host.targets.drones;
      for (let i = 0; i < drones.length && !splashed; i++) {
        const t = drones[i];
        const r = t.bodyRadius, h = t.bodyHeight, cy = t.position.y + h * 0.5;
        _p.copy(t.position);
        _p.y = THREE.MathUtils.clamp(g.mesh.position.y, Math.min(cy, t.position.y + r), Math.max(cy, t.position.y + h - r));
        if (_p.distanceToSquared(g.mesh.position) <= (r + GLOB_RADIUS) ** 2) {
          host.damageTargetAcid(t, SPEWER_SPIT.damage, g.prev, g.shooterId, { duration: SPEWER_SPIT.slowDuration, factor: 0.55 });
          splashed = true;
        }
      }
      // 2026-09-13 (the rover): touching the hull box is a direct hit — checked before the world raycast (the hull collider). Damage on the authority only.
      const vehicles = host.targets.vehicles;
      for (let i = 0; i < vehicles.length && !splashed; i++) {
        const t = vehicles[i];
        if (t.isDeadOrDowned || t.vehicleGap3D(g.mesh.position) > GLOB_RADIUS) continue;
        g.directVehicle = true;
        host.damageTargetAcid(t, SPEWER_SPIT.damage, g.prev, g.shooterId, { duration: SPEWER_SPIT.slowDuration, factor: 0.55 });
        splashed = true;
      }
      if (!splashed && world) {
        _d.subVectors(g.mesh.position, g.prev);
        const len = _d.length();
        if (len > 1e-4) {
          _d.multiplyScalar(1 / len);
          const hit = world.raycast(g.prev, _d, len + GLOB_RADIUS);
          if (hit) { g.mesh.position.copy(hit.point); splashed = true; }
        }
        if (!splashed && g.mesh.position.y < world.getHeightAt(g.mesh.position.x, g.mesh.position.z) + GLOB_RADIUS * 0.5) splashed = true;
        if (!splashed && !world.isInsideBounds(g.mesh.position.x, g.mesh.position.z)) splashed = true;
      }
      if (!splashed && g.life > MAX_LIFE) splashed = true;

      if (splashed) {
        this.splash(g, host);
        g.active = false;
        g.mesh.visible = false;
      }
    }
  }

  private splash(g: Glob, host: AcidHost): void {
    const p = g.mesh.position;
    this.fx.burst(p, 26, 'acid', 4.5);
    this.fx.splat(p, 1.1, 'acid', host.ctx.world);
    host.ctx.bus.emit('audio:play', { id: 'acid_splash', position: p, volume: 0.8 });
    const players = host.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const d = t.position.distanceTo(p);
      if (d < 2.4 && d > 0.6) host.damageTargetAcid(t, SPEWER_SPIT.splashDamage, p, g.shooterId, { duration: SPEWER_SPIT.slowDuration * 0.6, factor: 0.7 });
    }
    // 2026-09-15 (android squadmates): the same as the loop over people (2.4 m from the feet, outside the direct-hit distance).
    const allies = host.targets.allies;
    for (let i = 0; i < allies.length; i++) {
      const t = allies[i];
      if (t.isDeadOrDowned) continue;
      const d = t.position.distanceTo(p);
      if (d < 2.4 && d > 0.6) host.damageTargetAcid(t, SPEWER_SPIT.splashDamage, p, g.shooterId, { duration: SPEWER_SPIT.slowDuration * 0.6, factor: 0.7 });
    }
    // 2026-09-11 (X-5): enemies of another faction — measured from the body centre. The body that took the direct hit is skipped; `update` above already paid it.
    const active = host.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.id === g.directEnemy || e.id === g.shooterId || e.faction === g.faction || !e.isCombatant) continue;
      _q.set(e.position.x, e.position.y + e.stats.height * 0.5, e.position.z);
      const d = _q.distanceTo(p);
      if (d < 2.4 + e.stats.radius && d > GLOB_RADIUS) host.damageTargetAcid(e.asTarget, SPEWER_SPIT.splashDamage, p, g.shooterId, { duration: SPEWER_SPIT.slowDuration * 0.6, factor: 0.7 });
    }
    // 2026-09-11: drones — measured from the body centre. A direct hit (inside the body radius + the glob) was already paid by `update` above.
    const drones = host.targets.drones;
    for (let i = 0; i < drones.length; i++) {
      const t = drones[i];
      const d = t.getChest(_q).distanceTo(p);
      if (d < 2.4 && d > Math.max(0.6, t.bodyRadius + GLOB_RADIUS)) host.damageTargetAcid(t, SPEWER_SPIT.splashDamage, p, g.shooterId, { duration: SPEWER_SPIT.slowDuration * 0.6, factor: 0.7 });
    }
    // 2026-09-13: the rover — the distance to the hull box. A glob that hit directly was already paid by `update` above.
    if (!g.directVehicle) {
      const vehicles = host.targets.vehicles;
      for (let i = 0; i < vehicles.length; i++) {
        const t = vehicles[i];
        if (!t.isDeadOrDowned && t.vehicleGap3D(p) < 2.4) host.damageTargetAcid(t, SPEWER_SPIT.splashDamage, p, g.shooterId, { duration: SPEWER_SPIT.slowDuration * 0.6, factor: 0.7 });
      }
    }
  }

  /** First alive enemy of the other faction whose vertical body capsule the glob is inside (not the shooter), or null. */
  private enemyAt(g: Glob, host: AcidHost): Enemy | null {
    const gp = g.mesh.position;
    const active = host.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (e.id === g.shooterId || e.faction === g.faction || !e.isCombatant) continue;
      const r = e.stats.radius, reach = r + GLOB_RADIUS;
      const dx = e.position.x - gp.x, dz = e.position.z - gp.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      const y = THREE.MathUtils.clamp(gp.y, e.position.y + r, Math.max(e.position.y + r, e.position.y + e.stats.height - r));
      const dy = gp.y - y;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) return e;
    }
    return null;
  }

  clear(): void {
    for (const g of this.globs) { g.active = false; g.mesh.visible = false; }
  }

  dispose(): void {
    for (const g of this.globs) this.scene.remove(g.mesh);
    this.globs.length = 0;
    this.geo.dispose();
    this.mat.dispose();
  }
}
