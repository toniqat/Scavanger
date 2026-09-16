import * as THREE from 'three';
import {
  GRAVITY, GRENADE_FUSE as SHARED_GRENADE_FUSE, GRENADE_INCENDIARY_BLAST_DAMAGE, GRENADE_INCENDIARY_BLAST_RADIUS, PROP_STEP_UP_MAX,
  GRENADE_DAMAGE as SHARED_GRENADE_DAMAGE, GRENADE_PLAYER_DAMAGE_MUL, GRENADE_RADIUS as SHARED_GRENADE_RADIUS,
  breakFragileAlong, explosionDamage, type GameContext, type GrenadeView,
} from '@/shared';
import type { WeaponFx } from './fx/WeaponFx';
import type { PlayerDamageSource } from '@/shared';

/** 2026-09-15 (결과 창 개편): 수류탄 폭발이 로컬 플레이어에게 준 피해의 출처 — 내 것 / 분대원 것. */
const SELF_GRENADE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'self' });
const ALLY_GRENADE_SOURCE: PlayerDamageSource = Object.freeze({ kind: 'ally' });

/** Alias of the shared contract value (3 s); kept for the barrel export. */
export const GRENADE_FUSE = SHARED_GRENADE_FUSE;
/**
 * 2026-09-15 (사용자 결정): 세 수치가 `data/constants.csv` 로 갔다 (반경 6 → **7.2**, ×1.2).
 * 이름은 배럴(`@/weapons`)이 내보내는 계약이라 shared 값의 별칭으로 남긴다 — 호출부는 한 줄도 안 바뀐다.
 */
export const GRENADE_RADIUS = SHARED_GRENADE_RADIUS;
export const GRENADE_DAMAGE = SHARED_GRENADE_DAMAGE;
const BODY_R = 0.08;
const MAX_GRENADES = 8;
/**
 * 한 프레임을 쪼개는 최대 걸음 수 (`update` 의 2026-09-16 주석). 걸음 = 몸 지름 0.16 m 라 50 ms 프레임(`dt` 상한)에서
 * 근력 최대 투척(34 × 1.5 = 51 m/s)이 2.55 m → 16 걸음이다. 그 두 배를 상한으로 둔다 — 넘으면 걸음이 길어질 뿐 멈추지 않는다.
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
   * 2026-09-15 (B-16): G-10 소이 수류탄 (`ItemDef.grenadeFire`) — the blast is the small `GRENADE_INCENDIARY_BLAST_*` one and a
   * **local** explosion lights a fire zone through `ctx.gadgets.igniteGrenadeFire`. A visual-only replica only takes the small blast.
   */
  fire: boolean;
}

const _n = new THREE.Vector3(), _tmp = new THREE.Vector3(), _prev = new THREE.Vector3();

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
   * @param fire 2026-09-15 (B-16): G-10 소이 수류탄 (`ItemDef.grenadeFire`) — small blast + (local only) a fire zone on explosion.
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
         * 2026-09-16 — **쪼개 걷는다** (튜토리얼 마지막 웅덩이에서 수류탄이 벽 · 바닥을 뚫고 절벽으로 떨어졌다).
         * 한 프레임에 통째로 옮기면 두 가지가 샌다:
         *   ① 얇은 벽 — `boxPushOut` 은 **가까운 면**으로 밀어내므로 한 걸음에 반두께 + 몸(웅덩이 벽 0.3 + 0.08 = 0.38 m)을
         *      넘게 나아가면 반대편으로 빠져나간다. 34 m/s × 1/60 s = 0.57 m 라 60 fps 에서도 정면 투척이 뚫었다.
         *   ② 바닥 — 떨어지는 몸이 한 걸음에 윗면 밑으로 `PROP_TOP_MARGIN`(0.15)보다 깊이 들어가면 `getSurfaceY` 의
         *      천장(몸 윗면)이 그 바닥을 놓치고, `resolveCollision` 은 그 바닥 상자를 **벽**으로 보고 옆면으로 밀어낸다 —
         *      사람은 발 + 0.9 천장이라 같은 자리에서 멀쩡히 서 있다. 철조망을 넘긴 궤적은 웅덩이 바닥에 11 m/s 로 닿는다.
         * 그래서 한 걸음을 몸 지름(`2 × BODY_R`) 이하로 쪼갠다 — 벽을 넘지 못하고, 바닥 밑으로 몸 반지름 이상 들어가지 않는다.
         * 튕김의 감쇠 · 소리 · 멈춤 · 회전 감쇠는 **프레임당 한 번**이다 (걸음마다 곱하면 쪼갠 수만큼 빨리 멈춘다).
         */
        const dist = g.vel.length() * dt + GRAVITY * dt * dt;
        const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dist / (2 * BODY_R))));
        const h = dt / steps;
        let contact = false, impact = 0;
        for (let s = 0; s < steps; s++) {
          g.vel.y -= GRAVITY * h;
          _prev.copy(g.pos);
          g.pos.addScaledVector(g.vel, h);
          // 2026-09-11: 창문 유리는 튕기지 않고 깨고 지나간다 (깨진 창틀은 `resolveCollision` 이 작은 몸을 밀지 않는다)
          breakFragileAlong(world, _prev, g.pos);
          // 2026-09-11: 바닥은 지형이 아니라 **그 자리의 표면**이다 — 건물 2층 · 옥상 · 계단에 떨어진다.
          // 2026-09-16: 표면 **먼저**, 밀어내기 나중 (`CLAUDE.md` §4.4). 천장은 이 걸음의 **더 높은 쪽** 몸 윗면이다 —
          // 이번 걸음에 지나친 바닥을 잡고, 머리 위 천장판으로는 여전히 튀어 오르지 않는다.
          const terrain = world.getHeightAt(g.pos.x, g.pos.z);
          const surface = world.getSurfaceY(g.pos.x, g.pos.z, Math.max(_prev.y, g.pos.y) + BODY_R - PROP_STEP_UP_MAX);
          const ground = surface + BODY_R;
          if (g.pos.y < ground) {
            g.pos.y = ground;
            contact = true;
            if (surface > terrain + 0.02) _n.set(0, 1, 0); else world.getNormalAt(g.pos.x, g.pos.z, _n);
            const vn = g.vel.dot(_n);
            // reflect with restitution (friction is applied once per frame below)
            if (vn < 0) { g.vel.addScaledVector(_n, -vn * 1.4); impact = Math.max(impact, -vn); }
          }
          world.resolveCollision(g.pos, BODY_R);
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
    // 2026-09-15 (B-16): a G-10 소이 수류탄 is not a frag — a small blast lights the fire, the zone does the real damage
    const fire = g.fire;
    g.fire = false;
    const radius = fire ? GRENADE_INCENDIARY_BLAST_RADIUS : GRENADE_RADIUS;
    const damage = fire ? GRENADE_INCENDIARY_BLAST_DAMAGE : GRENADE_DAMAGE;
    // Visual-only replicas (remote players' grenades) never damage enemies here: the thrower's client resolves
    // that through the host. Phase 7: they DO hurt the local player — same radius / falloff / friendly-fire
    // rule as our own grenades (a squadmate's frag lands on you exactly like your own).
    const kills = !visualOnly && ctx.enemies ? ctx.enemies.applyExplosion(pos, radius, damage) : 0;
    if (ctx.player && !ctx.player.isDead) {
      _tmp.copy(ctx.player.position); _tmp.y += 0.9;
      const d = _tmp.distanceTo(pos);
      // 2026-09-15 (사용자 결정): 자해 · 아군 피해도 공용 2단 계단 (`shared/explosion`) — 안쪽 절반 100 % · 바깥 띠 60 %
      if (d < radius) {
        const dmg = explosionDamage(damage, d, radius) * PLAYER_DAMAGE_MUL;
        // 2026-09-15 (결과 창 개편): 내 수류탄(손에서 터진 것 포함) = `self`, 분대원 수류탄의 복제 = `ally`
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
