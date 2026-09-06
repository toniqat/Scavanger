import * as THREE from 'three';
import {
  FLAME_RANGE, FLAME_CONE_DEG, FLAME_DPS, FLAME_ALT_RANGE, FLAME_ALT_CONE_DEG, FLAME_ALT_DPS,
  BURNOUT_THRESHOLD, BURNOUT_DECAY_PER_SEC, BURNOUT_DURATION, FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION,
  type EnemyRef,
} from '@/shared';
import { coneTargets, enemyCentre, type UniqueHandler, type UniqueInput, type UniquePose, type UniqueServices, type UniqueWeapon } from './UniqueHandler';

const DEG = Math.PI / 180;
/** Damage / status ticks per second (also the `weapon:fired` + net cadence). */
const TICK_RATE = 10;
const NET_INTERVAL = 0.1;
const MAX_TARGETS = 12;

const _muzzle = new THREE.Vector3(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * 「인페르노」 화염방사기. LMB = wide cone (`FLAME_RANGE` / `FLAME_CONE_DEG`, `FLAME_DPS`), RMB = long thin jet
 * (`FLAME_ALT_*`). Damage, afterburn (`applyStatus 'burning'`) and heat land in `TICK_RATE` ticks; heat per enemy
 * (`Map<id, heat>`, decaying `BURNOUT_DECAY_PER_SEC`/s) crossing `BURNOUT_THRESHOLD` → `applyStatus('incinerated')`
 * and heat reset. Fuel drains `ammoPerSec × dt` (fractional, persisted per unit); durability −1 per second of spray.
 * The player never burns itself. Net: `fire {m, c:1}` at 10 Hz, `{m, c:-1}` when the beam stops.
 */
export class Flamethrower implements UniqueHandler {
  readonly kind = 'flamethrower' as const;
  readonly handlesMelee = false;
  readonly allowsAim = false;
  readonly pose: UniquePose = { charging: false, spraying: false, heavy: false, firing: false };

  /** -1 off, 0 LMB cone, 1 RMB jet. */
  private mode: -1 | 0 | 1 = -1;
  private readonly heat = new Map<number, number>();
  /** ctx.time of the last flame tick that hit each enemy — heat only cools once the flame has left it. */
  private readonly lastHit = new Map<number, number>();
  private tickT = 0;
  private netT = 0;
  private readonly targets: EnemyRef[] = [];
  private cur: UniqueWeapon | null = null;

  constructor(private readonly s: UniqueServices) {}

  onEquip(w: UniqueWeapon): void { w.model.setHeat(0); }
  onUnequip(w: UniqueWeapon): void { this.stop(w); }

  update(dt: number, w: UniqueWeapon, input: UniqueInput | null): void {
    const s = this.s;
    this.cur = w;
    // heat cools on everyone the flame has left (a full tick without a hit)
    if (this.heat.size > 0) {
      const now = s.ctx.time;
      for (const [id, h] of this.heat) {
        if (now - (this.lastHit.get(id) ?? -Infinity) < 1.5 / TICK_RATE) continue;
        const v = h - BURNOUT_DECAY_PER_SEC * dt;
        if (v <= 0) { this.heat.delete(id); this.lastHit.delete(id); } else this.heat.set(id, v);
      }
    }
    const host = s.host();
    let want: -1 | 0 | 1 = input ? (input.fireDown ? 0 : input.altDown ? 1 : -1) : -1;
    if (want >= 0 && (!host || s.brokenCheck(w))) want = -1;
    if (want >= 0 && !s.drain(w, dt)) { s.dryFire(w); want = -1; }
    if (want !== this.mode) {
      if (this.mode >= 0) this.stop(w);
      if (want >= 0) {
        this.mode = want;
        this.tickT = 0; this.netT = 0;
        w.model.setHeat(1);
        s.ctx.bus.emit('weapon:beamChanged', { weaponId: w.def.id, active: true, mode: want === 0 ? 'primary' : 'alt' });
        if (want === 1) {
          s.muzzle(w, _muzzle); s.aimRay(_o, _d);
          s.ctx.bus.emit('weapon:altFired', { weaponId: w.def.id, origin: _muzzle.clone(), direction: _d.clone() });
        }
      }
    }
    const p = this.pose;
    if (this.mode < 0 || !host) { p.spraying = false; p.firing = false; return; }
    p.spraying = true; p.firing = true;

    const alt = this.mode === 1;
    const range = alt ? FLAME_ALT_RANGE : FLAME_RANGE;
    const half = (alt ? FLAME_ALT_CONE_DEG : FLAME_CONE_DEG) * 0.5 * DEG;
    const dps = alt ? (w.def.altDamage ?? FLAME_ALT_DPS) : (w.stats.damage || FLAME_DPS);
    s.muzzle(w, _muzzle);
    s.aimRay(_o, _d);
    s.ufx.setFlame('local', _muzzle, _d, range, half);
    if (Math.random() < 0.5) s.recoil((Math.random() - 0.5) * 0.0015, (Math.random() - 0.5) * 0.0015);

    this.tickT += dt;
    const tick = 1 / TICK_RATE;
    if (this.tickT >= tick) {
      const dtTick = this.tickT;
      this.tickT = 0;
      this.applyTick(w, dtTick, range, half, dps);
    }
    this.netT -= dt;
    if (this.netT <= 0) { this.netT = NET_INTERVAL; s.announceFire(w, _muzzle, _d, alt ? 1 : 0, 1); }
  }

  private applyTick(w: UniqueWeapon, dtTick: number, range: number, half: number, dps: number): void {
    const s = this.s;
    const mgr = s.ctx.enemies;
    if (!mgr) return;
    const n = coneTargets(s, _muzzle, _d, range, half, MAX_TARGETS, this.targets);
    let anyKill = false;
    for (let i = 0; i < n; i++) {
      const e = this.targets[i];
      const wasDead = e.isDead;
      enemyCentre(e, _c);
      const dmg = dps * dtTick;
      e.takeDamage(dmg, _c, _d);
      if (!wasDead && e.isDead) { anyKill = true; this.heat.delete(e.id); this.lastHit.delete(e.id); continue; }
      if (typeof mgr.applyStatus === 'function') mgr.applyStatus(e.id, 'burning', FLAME_AFTERBURN_DPS, FLAME_AFTERBURN_DURATION);
      this.lastHit.set(e.id, s.ctx.time);
      const h = (this.heat.get(e.id) ?? 0) + dmg;
      if (h >= BURNOUT_THRESHOLD) {
        this.heat.delete(e.id); this.lastHit.delete(e.id);
        if (typeof mgr.applyStatus === 'function') mgr.applyStatus(e.id, 'incinerated', 0, BURNOUT_DURATION);
      } else this.heat.set(e.id, h);
      if (i < 3) s.fx.impactEnemy(_c, _d, false);
    }
    if (n > 0) s.ctx.bus.emit('ui:hitmarker', { kill: anyKill });
  }

  private stop(w: UniqueWeapon): void {
    if (this.mode < 0) return;
    const m: 0 | 1 = this.mode === 1 ? 1 : 0;
    this.mode = -1;
    w.model.setHeat(0);
    this.s.ufx.release('local');
    this.s.ctx.bus.emit('weapon:beamChanged', { weaponId: w.def.id, active: false, mode: m === 0 ? 'primary' : 'alt' });
    this.s.announceBeamEnd(w, m);
    this.pose.spraying = false; this.pose.firing = false;
  }

  reset(): void {
    if (this.cur) this.stop(this.cur);
    this.heat.clear();
    this.lastHit.clear();
    this.mode = -1;
    this.s.ufx.release('local');
    this.pose.spraying = false; this.pose.firing = false;
  }

  dispose(): void { this.reset(); }
}
