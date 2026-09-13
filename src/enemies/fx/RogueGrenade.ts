import * as THREE from 'three';
import {
  GRAVITY, Layers, ROGUE_GRENADE_RADIUS, breakFragileAlong,
  type EnemyFaction, type EnemyGrenadeKind, type GameContext, type GrenadeView,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { ENEMY_INCENDIARY } from '../EnemyTypes';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue grenades (Phase 7, rogue AI v2): pooled small spheres on a ballistic arc with one bounce and a fuse.
 * The same class renders the host's grenades (the blast is resolved by `GrenadeHost.onGrenadeExploded(p, true)`) and
 * the replicas' visual copies from `ee grenade` (`onGrenadeExploded(p, false)` = FX only). A host `grenadeHit` that
 * arrives while the local copy still flies pops it in place (`explodeNear`), so the explosion is never shown twice.
 *
 * 2026-09-13 — grenade **kinds** (`EnemyGrenadeKind`, wire index `ee grenade.k` / `ee grenadeHit.k`):
 * - `frag` = the Phase 7 blast (unchanged);
 * - `incendiary` = a small blast (`ENEMY_INCENDIARY.blastDamage`) plus a **fire zone** at the resting spot for
 *   `ENEMY_INCENDIARY.duration`. Zones live in this pool too (`FIRE_POOL`, oldest recycled): flames / smoke / embers from
 *   the shared `@/core/fx` particle pools and one additive ground-glow disc per zone — **no lights**. Every client draws
 *   them; only an `authority` zone calls `GrenadeHost.onFireZoneTick` every `ENEMY_INCENDIARY.tick` s (damage lives in
 *   `parts/Attacks.onFireZoneTick`). A zone remembers the thrower's faction so it never burns its own side.
 * ──────────────────────────────────────────────────────────────────────────── */

const POOL = 8;
const VISUAL_RADIUS = 0.11;
/** Velocity kept after the bounce (along the normal) / on the tangent part — a grenade should stay near where it lands. */
const RESTITUTION = 0.3;
const FRICTION = 0.3;
/** Tangent velocity kept per later contact (rolling), and the speed below which the grenade rests. */
const ROLL_DAMP = 0.5;
const REST_SPEED = 0.8;
/** Distance inside which a host `grenadeHit` claims a still-flying local copy. */
const MATCH_RADIUS = 4;
/* fire zone visuals (drawing constants — the gameplay numbers are `ENEMY_INCENDIARY`) */
const FIRE_POOL = 6;
const FLAME_EMIT_S = 0.07;
const SMOKE_EMIT_S = 0.35;
const EMBER_EMIT_S = 0.22;
const FIRE_FADE_IN_S = 0.25;
const FIRE_FADE_OUT_S = 1.5;
const GLOW_LIFT = 0.12;

/** What the grenades need from EnemySystem. */
export interface GrenadeHost {
  readonly ctx: GameContext;
  /**
   * Fuse ran out at `position`. `authority` = this client resolves the damage; everyone plays FX / shake / audio.
   * `owner` = throwing rogue's id (0 = unknown). 2026-09-13: `kind` — an incendiary's fire zone is already lit here.
   */
  onGrenadeExploded(position: THREE.Vector3, authority: boolean, owner: number, kind: EnemyGrenadeKind): void;
  /**
   * 2026-09-13: an **authority** fire zone ticks — burn whoever stands inside `radius` of `position` for `tick` seconds
   * (players; enemies not of `faction`). Never called for a replica's visual zone.
   */
  onFireZoneTick(position: THREE.Vector3, radius: number, owner: number, faction: EnemyFaction, tick: number): void;
}

interface Grenade {
  active: boolean;
  /** Throwing rogue's id (matching / debug). */
  owner: number;
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  prev: THREE.Vector3;
  fuse: number;
  life: number;
  bounced: boolean;
  resting: boolean;
  /** true for a host grenade (damage), false for a replica visual. */
  authority: boolean;
  spin: number;
  kind: EnemyGrenadeKind;
  faction: EnemyFaction;
}

interface FireZone {
  active: boolean;
  owner: number;
  faction: EnemyFaction;
  authority: boolean;
  readonly position: THREE.Vector3;
  radius: number;
  life: number;
  age: number;
  tick: number;
  flame: number;
  smoke: number;
  ember: number;
  seed: number;
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.MeshBasicMaterial;
}

const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fp = new THREE.Vector3();

/** Soft radial glow for the fire zone's ground disc (procedural — no texture files). */
function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,170,70,1)');
    grad.addColorStop(0.45, 'rgba(255,90,20,0.75)');
    grad.addColorStop(0.8, 'rgba(160,30,5,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class RogueGrenades {
  private readonly items: Grenade[] = [];
  /* HUD 위험 인디케이터용 view (풀 몸체당 하나 재사용) — `getViews()` 참고. */
  private readonly views: ({ position: THREE.Vector3; fuse: number; remote: boolean } | undefined)[] = [];
  private readonly viewList: GrenadeView[] = [];
  private readonly geo = new THREE.SphereGeometry(VISUAL_RADIUS, 10, 8);
  private readonly mat = new THREE.MeshStandardMaterial({ color: 0x2a2e26, emissive: 0xc83a1a, emissiveIntensity: 0.9, roughness: 0.5, metalness: 0.4 });
  /** 2026-09-13: the incendiary body — same material type (no extra shader program), a hot orange band. */
  private readonly matFire = new THREE.MeshStandardMaterial({ color: 0x3b2616, emissive: 0xff8a1a, emissiveIntensity: 1.1, roughness: 0.55, metalness: 0.3 });
  private readonly zones: FireZone[] = [];
  private readonly glowGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  private readonly glowTex = makeGlowTexture();
  private host: GrenadeHost | null = null;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.items.push({ active: false, owner: 0, mesh, vel: new THREE.Vector3(), prev: new THREE.Vector3(), fuse: 0, life: 0, bounced: false, resting: false, authority: false, spin: 0, kind: 'frag', faction: 'rogue' });
    }
    for (let i = 0; i < FIRE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.glowTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(this.glowGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.layers.enable(Layers.NO_RAYCAST);
      scene.add(mesh);
      this.zones.push({ active: false, owner: 0, faction: 'rogue', authority: false, position: new THREE.Vector3(), radius: 1, life: 0, age: 0, tick: 0, flame: 0, smoke: 0, ember: 0, seed: 0, mesh, mat });
    }
  }

  bind(host: GrenadeHost): void { this.host = host; }

  /**
   * Launch from `from` with velocity `vel`; explodes after `fuse` s. Returns false when the pool is full.
   * 2026-09-13: `kind` picks the body / blast, `faction` is the thrower's (an incendiary zone spares that side).
   */
  throw(owner: number, from: THREE.Vector3, vel: THREE.Vector3, fuse: number, authority: boolean, kind: EnemyGrenadeKind = 'frag', faction: EnemyFaction = 'rogue'): boolean {
    let g: Grenade | null = null;
    for (const c of this.items) if (!c.active) { g = c; break; }
    if (!g) return false;
    g.active = true; g.owner = owner; g.authority = authority;
    g.kind = kind; g.faction = faction;
    g.mesh.material = kind === 'incendiary' ? this.matFire : this.mat;
    g.mesh.position.copy(from); g.prev.copy(from);
    g.vel.copy(vel);
    g.fuse = Math.max(0.2, fuse);
    g.life = 0; g.bounced = false; g.resting = false; g.spin = 1;
    g.mesh.visible = true;
    return true;
  }

  /** Live grenades. */
  count(): number { let n = 0; for (const g of this.items) if (g.active) n++; return n; }

  /** 2026-09-13: burning fire zones (debug / smoke). */
  fireZoneCount(): number { let n = 0; for (const z of this.zones) if (z.active) n++; return n; }

  /** 2026-09-13 (debug / smoke): every burning zone — allocates, never call per frame. */
  debugFireZones(): { x: number; y: number; z: number; radius: number; life: number; authority: boolean; faction: EnemyFaction; owner: number }[] {
    const out: { x: number; y: number; z: number; radius: number; life: number; authority: boolean; faction: EnemyFaction; owner: number }[] = [];
    for (const z of this.zones) {
      if (!z.active) continue;
      out.push({ x: z.position.x, y: z.position.y, z: z.position.z, radius: z.radius, life: z.life, authority: z.authority, faction: z.faction, owner: z.owner });
    }
    return out;
  }

  /**
   * 2026-09-10: HUD 위험 인디케이터가 읽는 목록 (`EnemyManagerRef.getEnemyGrenades()`). 아군 수류탄의
   * `weapons/Grenade.getViews()` 와 **같은 모양 · 같은 규약**이다 — 풀 몸체 하나당 view 객체 하나를 재사용하고
   * `position` 은 살아 있는 동안 같은 `Vector3` 인스턴스(`mesh.position`)다. `remote` 는 이 클라이언트에
   * 권한이 없는 복제본이라는 뜻으로 쓴다 (`!authority`).
   */
  getViews(): readonly GrenadeView[] {
    this.viewList.length = 0;
    for (let i = 0; i < this.items.length; i++) {
      const g = this.items[i];
      if (!g.active) continue;
      let v = this.views[i];
      if (!v) { v = { position: g.mesh.position, fuse: 0, remote: false }; this.views[i] = v; }
      v.fuse = g.fuse; v.remote = !g.authority;
      this.viewList.push(v);
    }
    return this.viewList;
  }

  /** Host migration: grenades in flight and burning zones switch sides (demoted → visual only, promoted → they now hurt). */
  setAuthorityAll(authority: boolean): void {
    for (const g of this.items) g.authority = authority;
    for (const z of this.zones) z.authority = authority;
  }

  /** Position of the first live grenade thrown by `owner` (debug / smoke), or null. */
  findByOwner(owner: number): THREE.Vector3 | null {
    for (const g of this.items) if (g.active && g.owner === owner) return g.mesh.position;
    return null;
  }

  /**
   * Velocity that carries a grenade from `from` to `target` in `flight` seconds (gravity `GRAVITY`).
   * Writes into `out`.
   */
  static launchVelocity(from: THREE.Vector3, target: THREE.Vector3, flight: number, out: THREE.Vector3): THREE.Vector3 {
    const T = Math.max(0.4, flight);
    return out.set((target.x - from.x) / T, (target.y - from.y) / T + 0.5 * GRAVITY * T, (target.z - from.z) / T);
  }

  update(dt: number): void {
    const host = this.host;
    const world = host?.ctx.world ?? null;
    for (const g of this.items) {
      if (!g.active) continue;
      g.life += dt;
      g.fuse -= dt;
      if (g.fuse <= 0) { this.explode(g); continue; }
      if (g.resting) continue;
      g.prev.copy(g.mesh.position);
      g.vel.y -= GRAVITY * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      g.mesh.rotation.x += dt * 9 * g.spin; g.mesh.rotation.z += dt * 5 * g.spin;
      if (!world) continue;
      const p = g.mesh.position;
      // contact: obstacles / terrain along the step, then the height field under the sphere
      let hit = false;
      _d.subVectors(p, g.prev);
      const len = _d.length();
      if (len > 1e-4) {
        _d.multiplyScalar(1 / len);
        // 2026-09-11: 창문 유리는 튕기지 않고 깨고 지나간다 (깨진 창틀은 레이가 무시한다)
        breakFragileAlong(world, g.prev, p);
        const wh = world.raycast(g.prev, _d, len + VISUAL_RADIUS);
        if (wh) { p.copy(wh.point).addScaledVector(wh.normal, VISUAL_RADIUS); _n.copy(wh.normal); hit = true; }
      }
      if (!hit) {
        const ground = world.getHeightAt(p.x, p.z);
        if (p.y <= ground + VISUAL_RADIUS) { p.y = ground + VISUAL_RADIUS; world.getNormalAt(p.x, p.z, _n); hit = true; }
      }
      if (!world.isInsideBounds(p.x, p.z)) { g.vel.set(0, 0, 0); g.resting = true; continue; }
      if (!hit) continue;
      if (_n.lengthSq() < 0.5) _n.copy(_up);
      if (!g.bounced) {
        // one bounce: reflect around the surface normal, damp
        g.bounced = true;
        const vn = g.vel.dot(_n);
        g.vel.addScaledVector(_n, -vn);               // tangent part
        g.vel.multiplyScalar(FRICTION);
        g.vel.addScaledVector(_n, Math.abs(vn) * RESTITUTION);
        g.spin = 0.5;
      } else {
        // second contact: slide / roll, then rest
        const vn = g.vel.dot(_n);
        if (vn < 0) g.vel.addScaledVector(_n, -vn);
        g.vel.multiplyScalar(ROLL_DAMP);
        if (g.vel.lengthSq() < REST_SPEED * REST_SPEED) { g.vel.set(0, 0, 0); g.resting = true; }
      }
    }
    this.updateZones(dt);
  }

  /**
   * A host `grenadeHit` at `p`: pop the nearest still-flying local copy (no damage), else just the FX.
   * 2026-09-13: `kind` from the wire (`grenadeHit.k`) — it wins over the copy's (a late copy may have missed `ee grenade.k`)
   * and lights the visual fire zone when no copy is flying here.
   */
  explodeNear(p: THREE.Vector3, kind?: EnemyGrenadeKind): void {
    let best: Grenade | null = null;
    let bestD = MATCH_RADIUS * MATCH_RADIUS;
    for (const g of this.items) {
      if (!g.active) continue;
      const d = g.mesh.position.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best) {
      if (kind) best.kind = kind;
      best.mesh.position.copy(p);
      this.explode(best);
    } else {
      const k = kind ?? 'frag';
      this.blastFx(p, k);
      if (k === 'incendiary') this.ignite(p, 0, 'rogue', false);
      this.host?.onGrenadeExploded(p, false, 0, k);
    }
  }

  private explode(g: Grenade): void {
    g.active = false; g.mesh.visible = false;
    const p = g.mesh.position;
    this.blastFx(p, g.kind);
    if (g.kind === 'incendiary') this.ignite(p, g.owner, g.faction, g.authority);
    this.host?.onGrenadeExploded(p, g.authority, g.owner, g.kind);
  }

  /** Light a fire zone at `p` (the oldest one is recycled when all are burning). */
  private ignite(p: THREE.Vector3, owner: number, faction: EnemyFaction, authority: boolean): void {
    let z: FireZone | null = null;
    for (const c of this.zones) {
      if (!c.active) { z = c; break; }
      if (!z || c.life < z.life) z = c;
    }
    if (!z) return;
    z.active = true;
    z.owner = owner; z.faction = faction; z.authority = authority;
    z.position.copy(p);
    z.radius = Math.max(0.5, ENEMY_INCENDIARY.radius);
    z.life = Math.max(0.5, ENEMY_INCENDIARY.duration);
    z.age = 0;
    z.tick = Math.max(0.05, ENEMY_INCENDIARY.tick) * 0.3;   // the first burn lands promptly
    z.flame = 0; z.smoke = 0; z.ember = 0;
    z.seed = Math.random() * 100;
    const world = this.host?.ctx.world;
    const ground = world && world.ready ? world.getSurfaceY(p.x, p.z, p.y + 0.5) : p.y;
    z.mesh.position.set(p.x, ground + GLOW_LIFT, p.z);
    z.mesh.scale.setScalar(z.radius);
    z.mat.opacity = 0;
    z.mesh.visible = true;
  }

  private updateZones(dt: number): void {
    const fx = FxManager.get();
    const host = this.host;
    const world = host?.ctx.world ?? null;
    const now = host?.ctx.time ?? 0;
    const tickLen = Math.max(0.05, ENEMY_INCENDIARY.tick);
    for (const z of this.zones) {
      if (!z.active) continue;
      z.life -= dt;
      z.age += dt;
      if (z.life <= 0) { z.active = false; z.mesh.visible = false; continue; }
      // authority: burn on the tick (a long frame never stacks more than one tick)
      if (z.authority && host) {
        z.tick -= dt;
        if (z.tick <= 0) {
          z.tick = Math.max(z.tick + tickLen, tickLen * 0.5);
          host.onFireZoneTick(z.position, z.radius, z.owner, z.faction, tickLen);
        }
      }
      // visuals: fade in / out, flickering ground glow, flames / smoke / embers from the shared pools
      const k = Math.min(1, z.age / FIRE_FADE_IN_S) * Math.min(1, z.life / FIRE_FADE_OUT_S);
      z.mat.opacity = k * (0.5 + 0.22 * Math.sin(now * 13 + z.seed) + 0.1 * Math.sin(now * 31 + z.seed * 2.3));
      if (!fx) continue;
      z.flame -= dt;
      if (z.flame <= 0) {
        z.flame += FLAME_EMIT_S;
        if (Math.random() < k) {
          for (let i = 0; i < 2; i++) {
            this.pointInZone(z, world, _fp);
            ParticleBurst.fireball(fx.additive, _fp, 2, 1.1, 0.55);
          }
        }
      }
      z.smoke -= dt;
      if (z.smoke <= 0) {
        z.smoke += SMOKE_EMIT_S;
        _fp.set(z.position.x, z.mesh.position.y + 0.8, z.position.z);
        ParticleBurst.smoke(fx.alpha, _fp, 2, z.radius * 0.35 * Math.max(0.3, k), 0x2b2622);
      }
      z.ember -= dt;
      if (z.ember <= 0) {
        z.ember += EMBER_EMIT_S;
        this.pointInZone(z, world, _fp);
        ParticleBurst.sparks(fx.additive, _fp, _up, 2, 2.5, 0xff9040);
      }
    }
  }

  /** A random point on the burning ground inside `z` (surface height under it). */
  private pointInZone(z: FireZone, world: GameContext['world'], out: THREE.Vector3): THREE.Vector3 {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * z.radius * 0.9;
    const x = z.position.x + Math.cos(a) * r, zz = z.position.z + Math.sin(a) * r;
    const y = world && world.ready ? world.getSurfaceY(x, zz, z.position.y + 0.5) : z.position.y;
    return out.set(x, y + 0.15, zz);
  }

  private blastFx(p: THREE.Vector3, kind: EnemyGrenadeKind): void {
    const fx = FxManager.get();
    if (!fx) return;
    if (kind === 'incendiary') {
      ParticleBurst.fireball(fx.additive, p, 40, 5, 1.4);
      ParticleBurst.sparks(fx.additive, p, _up, 34, 7, 0xff8a30);
      ParticleBurst.groundBlast(fx.alpha, p, 24, ENEMY_INCENDIARY.radius * 1.2, 0x4a3426, 0.35);
      ParticleBurst.smoke(fx.alpha, p, 16, 1.5, 0x2e2419);
      fx.flashes.flash(p, 0xffa040, 0, 3.5, 0.12);
      return;
    }
    ParticleBurst.fireball(fx.additive, p, 34, 6, 1.1);
    ParticleBurst.sparks(fx.additive, p, _up, 26, 8, 0xffb060);
    ParticleBurst.groundBlast(fx.alpha, p, 40, ROGUE_GRENADE_RADIUS * 1.6, 0x5c5248, 0.45);
    ParticleBurst.smoke(fx.alpha, p, 22, 1.8, 0x2a2622);
    fx.flashes.flash(p, 0xffc070, 0, 4, 0.1);
  }

  clear(): void {
    for (const g of this.items) { g.active = false; g.mesh.visible = false; }
    for (const z of this.zones) { z.active = false; z.mesh.visible = false; }
  }

  dispose(): void {
    for (const g of this.items) this.scene.remove(g.mesh);
    this.items.length = 0;
    for (const z of this.zones) { this.scene.remove(z.mesh); z.mat.dispose(); }
    this.zones.length = 0;
    this.geo.dispose();
    this.mat.dispose();
    this.matFire.dispose();
    this.glowGeo.dispose();
    this.glowTex.dispose();
  }
}
